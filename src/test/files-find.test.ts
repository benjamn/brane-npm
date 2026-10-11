import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { ReachError, fileSource, streamSource, type ByteSource } from "../files/bytes.js";
import { openFoldSource } from "../files/browse.js";
import {
  FindSlots,
  MAX_NEEDLE_BYTES,
  parseByteQuery,
  parseFindQuery,
  scanSource,
  type ByteHit,
  type ByteNeedle,
  type FindEvent,
  type ScanOptions,
} from "../files/find.js";

/** A body delivered in the given chunk sizes, the way a decompressor
 *  delivers one: the scanner must not care where the seams fall. */
function chunked(data: Buffer, sizes: number[], reach?: number): ByteSource {
  const open = () => {
    const parts: Buffer[] = [];
    let at = 0;
    for (let i = 0; at < data.length; i++) {
      const n = Math.max(1, sizes[i % sizes.length]);
      parts.push(data.subarray(at, at + n));
      at += n;
    }
    return Readable.from(parts);
  };
  return streamSource(open, data.length, 0, 0, reach);
}

async function scan(source: ByteSource, needles: ByteNeedle[], from = 0, opts: ScanOptions = {}) {
  const events: FindEvent[] = [];
  const done = await scanSource(source, needles, from, (e) => events.push(e), opts);
  const hits = events.flatMap((e) => (e.type === "hits" ? e.hits : []));
  return { hits, done, events };
}

/** What a scan must find: each needle's non-overlapping hits, merged by offset. */
function reference(data: Buffer, needles: ByteNeedle[], from = 0): ByteHit[] {
  const lower = Buffer.from(data.map((b) => (b >= 0x41 && b <= 0x5a ? b | 0x20 : b)));
  const out: Array<{ at: number; len: number; n: number }> = [];
  needles.forEach((needle, n) => {
    const hay = needle.caseless ? lower : data;
    let i = from;
    while (true) {
      const at = hay.indexOf(needle.bytes, i);
      if (at < 0) break;
      out.push({ at, len: needle.bytes.length, n });
      i = at + needle.bytes.length;
    }
  });
  out.sort((a, b) => a.at - b.at || a.n - b.n);
  return out.map((h) => [h.at, h.len]);
}

describe("parseByteQuery", () => {
  it("reads lowercase text as caseless and mixed case as exact", () => {
    assert.deepEqual(parseByteQuery("text").map((n) => [n.kind, n.bytes.toString(), n.caseless]), [["text", "text", true]]);
    assert.deepEqual(parseByteQuery("TEXT").map((n) => [n.kind, n.bytes.toString(), n.caseless]), [["text", "TEXT", false]]);
  });

  it("reads a run of hex pairs as bytes too, with or without spaces or 0x", () => {
    for (const q of ["cf fa ed fe", "cffaedfe", "0xCFFAEDFE", "CF FA ED FE"]) {
      const hex = parseByteQuery(q).find((n) => n.kind === "hex");
      assert.ok(hex, q);
      assert.deepEqual([...hex.bytes], [0xcf, 0xfa, 0xed, 0xfe]);
      assert.equal(hex.caseless, false);
    }
  });

  it("keeps both readings of an ambiguous word", () => {
    const needles = parseByteQuery("cafe");
    assert.deepEqual(needles.map((n) => n.kind), ["text", "hex"]);
    assert.deepEqual([...needles[1].bytes], [0xca, 0xfe]);
  });

  it("does not read an odd digit count or a non-hex word as hex", () => {
    assert.deepEqual(parseByteQuery("abc").map((n) => n.kind), ["text"]);
    assert.deepEqual(parseByteQuery("c0ffee!").map((n) => n.kind), ["text"]);
    assert.deepEqual(parseByteQuery("a b").map((n) => n.kind), ["text"]);
  });

  it("does not trim: a lone space is a query", () => {
    assert.deepEqual(parseByteQuery(" ").map((n) => [...n.bytes]), [[0x20]]);
    assert.deepEqual(parseByteQuery(""), []);
  });

  it("lowercases ASCII only, so the bytes of `İ` stay put", () => {
    const [text] = parseByteQuery("İx");
    assert.equal(text.caseless, false); // `İ` is uppercase: exact
    assert.deepEqual(text.bytes, Buffer.from("İx"));
  });

  it("refuses a needle past the cap", () => {
    assert.ok("error" in (parseFindQuery("x".repeat(MAX_NEEDLE_BYTES + 1)) as object));
    assert.ok(Array.isArray(parseFindQuery("x".repeat(MAX_NEEDLE_BYTES))));
    assert.ok("error" in (parseFindQuery("") as object));
  });
});

describe("scanSource", () => {
  it("finds what a naive search finds, wherever the chunk seams fall", async () => {
    // A small alphabet makes needles recur, overlap each other, and straddle
    // seams often; case varies so the fold is exercised too.
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const alphabet = Buffer.from("abAB\x00\xca\xfe");
    for (let trial = 0; trial < 200; trial++) {
      const data = Buffer.from(Array.from({ length: 50 + rand(400) }, () => alphabet[rand(alphabet.length)]));
      const q = ["ab", "aba", "cafe", "b", "BA", "a\x00", "abab"][rand(7)];
      const needles = parseByteQuery(q);
      const sizes = Array.from({ length: 5 }, () => 1 + rand(9));
      const from = rand(3) === 0 ? rand(data.length) : 0;
      const { hits, done } = await scan(chunked(data, sizes), needles, from, { maxHits: 1e9, maxPages: 1e9 });
      assert.deepEqual(hits, reference(data, needles, from), `trial ${trial}: ${JSON.stringify(q)} ${sizes}`);
      assert.equal(done.stop, "eof");
      assert.equal(done.next, null);
      assert.equal(done.scanned, data.length);
    }
  });

  it("reports hits in offset order even when a longer needle's hit completes a chunk later", async () => {
    // `cafe` as text (4 bytes) starts at 2 and is whole only in the second
    // chunk; the hex needle ca fe (2 bytes) at 6 is whole in the first. Order
    // must still be 2 before 6.
    const data = Buffer.concat([Buffer.from("xxca"), Buffer.from("fe"), Buffer.from([0xca, 0xfe]), Buffer.from("xx")]);
    const { hits } = await scan(chunked(data, [3, 5]), parseByteQuery("cafe"));
    assert.deepEqual(hits, [[2, 4], [6, 2]]);
  });

  it("stops at the page window and says where the next hit is", async () => {
    // One hit per 16-byte page, pages 0..9.
    const data = Buffer.alloc(160, 0x2e);
    for (let p = 0; p < 10; p++) data.write("Z", p * 16 + 3);
    const needles = parseByteQuery("z");
    const { hits, done } = await scan(chunked(data, [7]), needles, 0, { pageBytes: 16, maxPages: 4 });
    assert.deepEqual(hits.map((h) => h[0]), [3, 19, 35, 51]);
    assert.equal(done.stop, "pages");
    assert.equal(done.next, 67);
    // …and the next window picks up exactly there.
    const again = await scan(chunked(data, [7]), needles, done.next!, { pageBytes: 16, maxPages: 4 });
    assert.deepEqual(again.hits.map((h) => h[0]), [67, 83, 99, 115]);
  });

  it("counts a hit that straddles a page boundary as both pages", async () => {
    const data = Buffer.alloc(64, 0x2e);
    data.write("xy", 15); // pages 0 and 1
    data.write("xy", 40); // page 2
    const { hits, done } = await scan(chunked(data, [64]), parseByteQuery("xy"), 0, { pageBytes: 16, maxPages: 2 });
    assert.deepEqual(hits, [[15, 2]]);
    assert.equal(done.stop, "pages");
    assert.equal(done.next, 40);
  });

  it("stops at the hit cap: a one-byte query in a file made of that byte", async () => {
    const data = Buffer.alloc(100_000);
    const { hits, done } = await scan(chunked(data, [4096]), parseByteQuery("00"), 0, { maxHits: 50 });
    assert.equal(hits.length, 50);
    assert.equal(done.stop, "hits");
    assert.equal(done.next, 50);
    // It stopped in the first chunk, not after reading the file.
    assert.ok(done.scanned <= 4096);
  });

  it("stops on its time budget with a place to resume", async () => {
    let t = 0;
    const data = Buffer.alloc(1000, 0x2e);
    data.write("q", 900);
    const { hits, done } = await scan(chunked(data, [100]), parseByteQuery("q"), 0, {
      budgetMs: 250,
      now: () => (t += 100),
    });
    assert.deepEqual(hits, []);
    assert.equal(done.stop, "time");
    assert.ok(done.next !== null && done.next < 900);
    const rest = await scan(chunked(data, [100]), parseByteQuery("q"), done.next!);
    assert.deepEqual(rest.hits, [[900, 1]]);
  });

  it("stops at the reach limit in a compressed body, keeping what it found before it", async () => {
    const data = Buffer.alloc(300, 0x2e);
    data.write("hit", 10);
    data.write("hit", 250);
    const { hits, done } = await scan(chunked(data, [32], 200), parseByteQuery("hit"));
    assert.deepEqual(hits, [[10, 3]]);
    assert.equal(done.stop, "reach");
    assert.equal(done.scanned, 200);
  });

  it("stops when cancelled", async () => {
    const c = new AbortController();
    c.abort();
    const { done } = await scan(chunked(Buffer.alloc(100), [10]), parseByteQuery("00"), 0, { signal: c.signal });
    assert.equal(done.stop, "cancelled");
  });

  it("resumes a cancelled scan without losing a hit it was holding at the seam", async () => {
    // `NEEDLE` is split across the first seam. The scan is cancelled as the
    // second chunk arrives, while `NEE` is still held back; resuming from the
    // chunk's end would never see the hit.
    const data = Buffer.from("........NEEDLE..........");
    const c = new AbortController();
    const src = streamSource(() => Readable.from((function* () {
      yield data.subarray(0, 11);
      c.abort();
      yield data.subarray(11);
    })()), data.length, 0);
    const first = await scan(src, parseByteQuery("NEEDLE"), 0, { signal: c.signal });
    assert.deepEqual(first.hits, []);
    assert.equal(first.done.stop, "cancelled");
    assert.ok(first.done.next !== null && first.done.next <= 8);
    const rest = await scan(chunked(data, [5]), parseByteQuery("NEEDLE"), first.done.next!);
    assert.deepEqual(rest.hits, [[8, 6]]);
  });

  it("reads a file on disk from an offset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brane-find-"));
    const p = join(dir, "blob.bin");
    const data = Buffer.alloc(3 * 1024 * 1024 + 5);
    data.write("NEEDLE", 1024 * 1024 - 3); // across the first 1 MB read
    data.write("NEEDLE", 3 * 1024 * 1024 - 1);
    writeFileSync(p, data);
    const src = fileSource(p, data.length, 0);
    const { hits, done } = await scan(src, parseByteQuery("NEEDLE"));
    assert.deepEqual(hits, [[1024 * 1024 - 3, 6], [3 * 1024 * 1024 - 1, 6]]);
    assert.equal(done.stop, "eof");
    const later = await scan(src, parseByteQuery("NEEDLE"), 1024 * 1024);
    assert.deepEqual(later.hits, [[3 * 1024 * 1024 - 1, 6]]);
  });
});

describe("ByteSource.chunks", () => {
  it("throws ReachError past the reach limit rather than ending quietly", async () => {
    const src = chunked(Buffer.alloc(100), [30], 50);
    let got = 0;
    await assert.rejects(async () => {
      for await (const c of src.chunks(0)) got += c.length;
    }, ReachError);
    assert.equal(got, 50);
  });

  it("ends normally when the body ends exactly at the limit", async () => {
    const src = chunked(Buffer.alloc(50), [30], 50);
    let got = 0;
    for await (const c of src.chunks(10)) got += c.length;
    assert.equal(got, 40);
  });
});

describe("FindSlots", () => {
  it("supersedes the oldest scan rather than refusing a new one", () => {
    const slots = new FindSlots(2);
    const a = slots.admit();
    const b = slots.admit();
    assert.equal(slots.size, 2);
    const c = slots.admit();
    assert.equal(a.signal.aborted, true);
    assert.equal(b.signal.aborted, false);
    assert.equal(c.signal.aborted, false);
    assert.equal(slots.size, 2);
    b.release();
    c.release();
    a.release(); // releasing a superseded scan is harmless
    assert.equal(slots.size, 0);
  });
});

describe("openFoldSource", () => {
  const fold = mkdtempSync(join(tmpdir(), "brane-find-fold-"));
  mkdirSync(join(fold, "sub"));
  writeFileSync(join(fold, "sub", "a.bin"), Buffer.from("\x00\x01hello\x00"));
  writeFileSync(join(fold, "notes.txt.gz"), gzipSync(Buffer.from("x".repeat(1000) + "buried")));

  it("opens a plain file", async () => {
    const src = await openFoldSource(fold, "sub/a.bin");
    assert.ok(!("error" in src));
    const { hits } = await scan(src as ByteSource, parseByteQuery("hello"));
    assert.deepEqual(hits, [[2, 5]]);
  });

  it("searches a .gz as what it compresses, as the hex view shows it", async () => {
    const src = await openFoldSource(fold, "notes.txt.gz");
    assert.ok(!("error" in src));
    const { hits } = await scan(src as ByteSource, parseByteQuery("buried"));
    assert.deepEqual(hits, [[1000, 6]]);
  });

  it("refuses what isn't a file, or isn't in the fold", async () => {
    assert.deepEqual(await openFoldSource(fold, "sub"), { status: 400, error: "Not a file" });
    assert.equal((await openFoldSource(fold, "../etc/passwd") as { status: number }).status, 400);
    assert.equal((await openFoldSource(fold, "/etc/passwd") as { status: number }).status, 400);
    assert.equal((await openFoldSource(fold, "nope.bin") as { status: number }).status, 404);
  });
});
