import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { payloadResponse } from "../daemon/payload-serve.js";
import { VIDEO_PAYLOAD_MIME } from "../shared/payload-inline.js";

const MIME: Record<string, string> = { ".png": "image/png", ".txt": "text/plain", ...VIDEO_PAYLOAD_MIME };

async function body(stream: Readable): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk as Buffer);
  return Buffer.concat(parts).toString("latin1");
}

describe("payloadResponse", () => {
  let dir: string;
  const bytes = "0123456789abcdefghij"; // 20 bytes

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "brane-payload-serve-"));
    for (const name of ["clip.mp4", "shot.png", "notes.txt", "empty.mp4"]) {
      writeFileSync(join(dir, name), name === "empty.mp4" ? "" : bytes);
    }
    mkdirSync(join(dir, "sub.mp4"));
  });

  test("no Range: the whole file, with ranges offered", async () => {
    const r = await payloadResponse(join(dir, "clip.mp4"), "clip.mp4", undefined, MIME);
    assert.ok(!("error" in r));
    assert.equal(r.status, 200);
    assert.equal(r.headers["Content-Type"], "video/mp4");
    assert.equal(r.headers["Accept-Ranges"], "bytes");
    assert.equal(r.headers["Content-Length"], "20");
    assert.equal(await body(r.stream), bytes);
  });

  test("Safari's bytes=0-1 probe gets a 206 of exactly two bytes", async () => {
    // Without this answer Safari never plays the video at all.
    const r = await payloadResponse(join(dir, "clip.mp4"), "clip.mp4", "bytes=0-1", MIME);
    assert.ok(!("error" in r));
    assert.equal(r.status, 206);
    assert.equal(r.headers["Content-Range"], "bytes 0-1/20");
    assert.equal(r.headers["Content-Length"], "2");
    assert.equal(await body(r.stream), "01");
  });

  test("an open-ended range and a suffix range, which is how a player seeks", async () => {
    const open = await payloadResponse(join(dir, "clip.mp4"), "clip.mp4", "bytes=15-", MIME);
    assert.ok(!("error" in open));
    assert.equal(open.headers["Content-Range"], "bytes 15-19/20");
    assert.equal(await body(open.stream), "fghij");
    const suffix = await payloadResponse(join(dir, "clip.mp4"), "clip.mp4", "bytes=-3", MIME);
    assert.ok(!("error" in suffix));
    assert.equal(await body(suffix.stream), "hij");
  });

  test("a range past the end is a 416 that names the size", async () => {
    const r = await payloadResponse(join(dir, "clip.mp4"), "clip.mp4", "bytes=20-", MIME);
    assert.equal(r.status, 416);
    assert.equal(r.headers?.["Content-Range"], "bytes */20");
    const empty = await payloadResponse(join(dir, "empty.mp4"), "empty.mp4", "bytes=0-1", MIME);
    assert.equal(empty.status, 416);
  });

  test("images and videos are inline; everything else is an attachment", async () => {
    for (const name of ["clip.mp4", "shot.png"]) {
      const r = await payloadResponse(join(dir, name), name, undefined, MIME);
      assert.ok(!("error" in r));
      assert.equal(r.headers["Content-Disposition"], undefined, name);
      assert.equal(r.headers["Content-Security-Policy"], "sandbox", name);
      r.stream.destroy();
    }
    const txt = await payloadResponse(join(dir, "notes.txt"), "notes.txt", "bytes=0-1", MIME);
    assert.ok(!("error" in txt));
    assert.equal(txt.headers["Content-Disposition"], 'attachment; filename="notes.txt"');
    assert.equal(txt.headers["Content-Security-Policy"], "sandbox");
    txt.stream.destroy();
  });

  test("a missing file and a directory are both 404", async () => {
    assert.equal((await payloadResponse(join(dir, "nope.mp4"), "nope.mp4", undefined, MIME)).status, 404);
    assert.equal((await payloadResponse(join(dir, "sub.mp4"), "sub.mp4", undefined, MIME)).status, 404);
  });
});
