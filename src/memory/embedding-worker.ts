import { parentPort } from "node:worker_threads";

import { createEmbedder, VECTOR_DIM, type Embedder } from "./embedder.js";

if (!parentPort) {
  throw new Error("embedding-worker.ts must be loaded as a worker thread");
}

let embedderPromise: Promise<Embedder> | null = null;

async function loadExtractor(): Promise<Embedder> {
  console.log("Loading embedding model...");
  // The first load may fetch the model from HuggingFace, which can be
  // transiently rate-limited (HTTP 429) or otherwise flaky. Retry with
  // exponential backoff so a cold cache survives a hiccup instead of failing
  // the whole process (notably CI). Once the model is on disk this loop
  // succeeds on the first attempt and never touches the network.
  const MAX_ATTEMPTS = 4;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const embedder = await createEmbedder();
      console.log("Embedding model ready.");
      return embedder;
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_ATTEMPTS) break;
      const delayMs = 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s
      console.warn(
        `Embedding model load failed (attempt ${attempt}/${MAX_ATTEMPTS}), ` +
          `retrying in ${delayMs}ms:`,
        err instanceof Error ? err.message : err,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

function getExtractor(): Promise<Embedder> {
  if (!embedderPromise) {
    embedderPromise = loadExtractor().catch((err) => {
      embedderPromise = null;
      throw err;
    });
  }
  return embedderPromise;
}

type EmbedRequest = { kind: "embed"; id: number; texts: string[] };
type PreloadRequest = { kind: "preload" };
type WorkerRequest = EmbedRequest | PreloadRequest;

parentPort.on("message", async (msg: WorkerRequest) => {
  if (msg.kind === "preload") {
    getExtractor().catch((err) => {
      console.error("Failed to preload embedding model:", err);
    });
    return;
  }

  if (msg.kind === "embed") {
    try {
      const embedder = await getExtractor();
      const vectors = await embedder.embed(msg.texts);
      // Concatenate into one buffer so the whole batch crosses the worker
      // boundary as a single transfer rather than N copies; `embedBatch`
      // slices it back apart on the other side.
      const flat = new Float32Array(vectors.length * VECTOR_DIM);
      for (let i = 0; i < vectors.length; i++) flat.set(vectors[i], i * VECTOR_DIM);
      parentPort!.postMessage(
        { kind: "embed-result", id: msg.id, flat },
        [flat.buffer],
      );
    } catch (err) {
      parentPort!.postMessage({
        kind: "embed-error",
        id: msg.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
});
