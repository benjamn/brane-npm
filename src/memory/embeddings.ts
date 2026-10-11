import { Worker } from "node:worker_threads";

// Re-exported, not redeclared: the dimensionality belongs to the model, and
// `storage.ts` bakes it into the vec0 schema. Two copies could disagree.
export { VECTOR_DIM } from "./embedder.js";
import { VECTOR_DIM } from "./embedder.js";

type EmbedResult = { kind: "embed-result"; id: number; flat: Float32Array };
type EmbedError = { kind: "embed-error"; id: number; message: string };
type WorkerMessage = EmbedResult | EmbedError;

type PendingEmbed = {
  resolve: (flat: Float32Array) => void;
  reject: (err: Error) => void;
};

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, PendingEmbed>();

function failAllPending(err: Error): void {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./embedding-worker.js", import.meta.url));
  w.on("message", (msg: WorkerMessage) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.kind === "embed-result") p.resolve(msg.flat);
    else p.reject(new Error(msg.message));
  });
  w.on("error", (err) => {
    failAllPending(err);
    worker = null;
  });
  w.on("exit", () => {
    failAllPending(new Error("embedding worker exited"));
    worker = null;
  });
  worker = w;
  return w;
}

/** Preload the embedding model in the background. Safe to call multiple times. */
export function preloadEmbeddingModel(): void {
  try {
    getWorker().postMessage({ kind: "preload" });
  } catch (err) {
    console.error("Failed to preload embedding model:", err);
  }
}

/**
 * Tear down the embedding worker. Calling `worker.terminate()` kills the
 * worker thread and releases its ONNX session — crucially without invoking
 * the main process's `__cxa_finalize`, which is where the
 * `pthread_mutex_lock: Invalid argument` abort used to come from.
 */
export async function disposeEmbeddingModel(): Promise<void> {
  if (!worker) return;
  const w = worker;
  worker = null;
  try {
    await w.terminate();
  } catch {
    // Worker already gone; nothing to do.
  }
  failAllPending(new Error("embedding worker terminated"));
}

function sendEmbed(texts: string[]): Promise<Float32Array> {
  const w = getWorker();
  const id = nextId++;
  return new Promise<Float32Array>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ kind: "embed", id, texts });
  });
}

/** Embed a single text string, returns normalized 384-dim vector. */
export async function embedText(text: string): Promise<Float32Array> {
  return sendEmbed([text]);
}

/** Embed multiple texts in one call. Returns array of 384-dim vectors. */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const flat = await sendEmbed(texts);
  const vectors: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    const start = i * VECTOR_DIM;
    vectors.push(flat.slice(start, start + VECTOR_DIM));
  }
  return vectors;
}
