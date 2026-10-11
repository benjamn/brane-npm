/**
 * Feature extraction on `onnxruntime-node` directly — the slice of
 * `@huggingface/transformers` brane actually used.
 *
 * The omnibus package brought 138 MB of code for four steps: tokenize, run one
 * ONNX session, mean-pool over the attention mask, L2-normalize. This file is
 * those four steps. It is written to produce byte-identical vectors to the
 * pipeline it replaces, because `memory_vec` is already full of the old ones —
 * see `src/test/embedder.test.ts`, which pins that against real chunks.
 *
 * The on-disk cache layout is deliberately the one transformers.js used
 * (`<cacheDir>/<repo>/<file>`), so an existing `~/.brane/models` keeps working
 * and nobody re-downloads 133 MB on upgrade.
 */

import { createWriteStream, existsSync, mkdirSync, renameSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import * as ort from "onnxruntime-node";

import { WordPieceTokenizer } from "./wordpiece.js";

/** The model brane embeds with. */
export const MODEL_REPO = "Xenova/bge-small-en-v1.5";

/** Its hidden size — the width of every vector in `memory_vec`. */
export const VECTOR_DIM = 384;

const HF_ENDPOINT = process.env.HF_ENDPOINT || "https://huggingface.co";

function cacheDir(): string {
  return process.env.BRANE_MODEL_CACHE || join(homedir(), ".brane", "models");
}

/**
 * Download one file to the cache if it isn't already there.
 *
 * Writes to a temporary name and renames into place: a model interrupted
 * halfway is 133 MB of plausible-looking ONNX that fails at session load with
 * nothing to suggest a truncated download. The rename makes presence mean
 * complete. (Never removes the partial file — the golden rule applies to
 * brane's own caches too; a stale `.partial` costs disk, and disk is cheap.)
 */
export async function ensureFile(repo: string, file: string): Promise<string> {
  const target = join(cacheDir(), repo, file);
  if (existsSync(target)) return target;

  mkdirSync(dirname(target), { recursive: true });
  const url = `${HF_ENDPOINT}/${repo}/resolve/main/${file}`;
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }

  const partial = `${target}.partial-${process.pid}`;
  await streamPipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(partial),
  );
  renameSync(partial, target);
  return target;
}

export interface Embedder {
  /** Embed texts into normalized 384-dim vectors, one per input. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Release the ONNX session. */
  dispose(): Promise<void>;
}

/**
 * How many cores one embedding session may use.
 *
 * This number was measured, not chosen. Capping ORT at a single intra-op
 * thread — to be a good neighbour to the daemon's event loop and the 10 fps
 * tmux capture — made embedding **6.5x slower** than the transformers.js
 * pipeline it replaces (308 ms/text against 47), which would have turned a
 * dependency cleanup into a visible regression in indexing. Scaling on a
 * 16-core machine: 1→308, 2→152, 4→80, 8→47.6, unbounded→49.7 ms/text. It
 * saturates at 8; letting ORT take everything is marginally *worse* than
 * taking eight.
 *
 * So: leave two cores for everything else, and never exceed the point where
 * more threads stop buying anything.
 */
const MAX_INTRA_OP_THREADS = 8;

function intraOpThreads(): number {
  return Math.max(1, Math.min(MAX_INTRA_OP_THREADS, availableParallelism() - 2));
}

/** Load the model (downloading on a cold cache) and return an embedder. */
export async function createEmbedder(): Promise<Embedder> {
  const tokenizerPath = await ensureFile(MODEL_REPO, "tokenizer.json");
  const modelPath = await ensureFile(MODEL_REPO, "onnx/model.onnx");

  const tokenizer = WordPieceTokenizer.fromFile(tokenizerPath);
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    intraOpNumThreads: intraOpThreads(),
  });

  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];

      const { input_ids, attention_mask, token_type_ids } =
        tokenizer.encodeBatch(texts);
      const batch = input_ids.length;
      const seqLen = input_ids[0].length;
      const dims = [batch, seqLen];

      const toTensor = (rows: number[][]) =>
        new ort.Tensor("int64", BigInt64Array.from(rows.flat().map(BigInt)), dims);

      const output = await session.run({
        input_ids: toTensor(input_ids),
        attention_mask: toTensor(attention_mask),
        token_type_ids: toTensor(token_type_ids),
      });

      const hidden = output.last_hidden_state;
      const data = hidden.data as Float32Array;
      const embedDim = hidden.dims[2];

      const vectors: Float32Array[] = [];
      for (let b = 0; b < batch; b++) {
        const vec = meanPool(data, b * seqLen * embedDim, seqLen, embedDim, attention_mask[b]);
        l2Normalize(vec);
        vectors.push(vec);
      }

      return vectors;
    },

    async dispose(): Promise<void> {
      await session.release();
    },
  };
}

/**
 * Masked mean pool one sequence out of a `[batch, seq, dim]` hidden state.
 *
 * Padding positions carry mask 0 and so contribute nothing to either the sum
 * or the divisor — which is what lets a text embed identically whether it was
 * batched with longer neighbours or sent alone. Divides by the token count,
 * with no epsilon, matching transformers.js's `mean_pooling` exactly; a
 * sequence always contains at least [CLS] and [SEP], so the count is never 0.
 */
export function meanPool(
  hidden: Float32Array,
  base: number,
  seqLen: number,
  embedDim: number,
  mask: number[],
): Float32Array {
  const vec = new Float32Array(embedDim);
  let count = 0;
  for (let j = 0; j < seqLen; j++) count += mask[j];
  for (let k = 0; k < embedDim; k++) {
    let sum = 0;
    for (let j = 0; j < seqLen; j++) {
      sum += hidden[base + j * embedDim + k] * mask[j];
    }
    vec[k] = sum / count;
  }
  return vec;
}

/** L2-normalize in place, so cosine distance in `memory_vec` is a dot product. */
export function l2Normalize(vec: Float32Array): void {
  let norm = 0;
  for (let k = 0; k < vec.length; k++) norm += vec[k] * vec[k];
  norm = Math.sqrt(norm);
  for (let k = 0; k < vec.length; k++) vec[k] /= norm;
}
