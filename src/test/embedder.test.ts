import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  createEmbedder,
  l2Normalize,
  meanPool,
  VECTOR_DIM,
  type Embedder,
} from "../memory/embedder.js";
import { EMBEDDING_GOLDEN } from "./fixtures/embedding-golden.js";

/** Cosine of two unit-ish vectors. */
function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

describe("pooling math", () => {
  it("mean-pools only the unmasked positions", () => {
    // Two positions of a 2-dim hidden state; the second is padding.
    const hidden = Float32Array.from([1, 2, 100, 200]);
    const pooled = meanPool(hidden, 0, 2, 2, [1, 0]);
    assert.deepEqual(Array.from(pooled), [1, 2]);
  });

  it("averages rather than sums, so sequence length doesn't scale the vector", () => {
    const hidden = Float32Array.from([1, 1, 3, 3]);
    assert.deepEqual(Array.from(meanPool(hidden, 0, 2, 2, [1, 1])), [2, 2]);
  });

  it("reads the right sequence out of a batch via its base offset", () => {
    // [batch=2, seq=1, dim=2]
    const hidden = Float32Array.from([1, 2, 30, 40]);
    assert.deepEqual(Array.from(meanPool(hidden, 2, 1, 2, [1])), [30, 40]);
  });

  it("normalizes to unit length", () => {
    const v = Float32Array.from([3, 4]);
    l2Normalize(v);
    assert.ok(Math.abs(Math.hypot(v[0], v[1]) - 1) < 1e-6);
    assert.ok(Math.abs(v[0] - 0.6) < 1e-6);
  });
});

const modelPath = join(
  process.env.BRANE_MODEL_CACHE || join(homedir(), ".brane", "models"),
  "Xenova",
  "bge-small-en-v1.5",
  "onnx",
  "model.onnx",
);
const haveModel = existsSync(modelPath);

describe("embedder", { skip: haveModel ? false : `no model at ${modelPath}` }, () => {
  let embedder: Embedder | null = null;
  const get = async () => (embedder ??= await createEmbedder());

  after(async () => {
    await embedder?.dispose();
  });

  it("reproduces the vectors transformers.js produced", async () => {
    // The reason this file exists. `memory_vec` already holds vectors from the
    // old pipeline, so drift here silently degrades search rather than failing.
    const e = await get();
    const vectors = await e.embed(EMBEDDING_GOLDEN.map((g) => g.text));
    for (let i = 0; i < EMBEDDING_GOLDEN.length; i++) {
      const sim = cosine(vectors[i], EMBEDDING_GOLDEN[i].vector);
      assert.ok(
        sim > 0.99999,
        `cosine ${sim} for ${JSON.stringify(EMBEDDING_GOLDEN[i].text.slice(0, 40))}`,
      );
    }
  });

  it("returns normalized vectors of the schema's width", async () => {
    const [v] = await (await get()).embed(["a sentence"]);
    assert.equal(v.length, VECTOR_DIM);
    let norm = 0;
    for (const x of v) norm += x * x;
    assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-5);
  });

  it("embeds a text identically whether batched or alone", async () => {
    // Padding leaks into the vector if the attention mask is ignored, and the
    // symptom is subtle: results that shift depending on batch composition.
    const e = await get();
    const [alone] = await e.embed(["short"]);
    const batched = await e.embed(["short", "a considerably longer neighbour sentence"]);
    assert.ok(cosine(alone, batched[0]) > 0.99999);
  });

  it("places related text nearer than unrelated text", async () => {
    const [a, b, c] = await (await get()).embed([
      "the daemon streams terminal output over a websocket",
      "tmux panes are mirrored to the browser in real time",
      "sourdough needs a long cold fermentation",
    ]);
    assert.ok(cosine(a, b) > cosine(a, c));
  });

  it("returns nothing for an empty batch without loading anything", async () => {
    assert.deepEqual(await (await get()).embed([]), []);
  });
});
