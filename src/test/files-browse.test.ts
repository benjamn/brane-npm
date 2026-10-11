import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, deflateRawSync, gzipSync } from "node:zlib";
import { browseFold, parseOffsetParam, MAX_INLINE, type BrowseResult, type FilesJson } from "../files/browse.js";
import { ReachError, streamSource } from "../files/bytes.js";
import { Readable } from "node:stream";
import { HEX_PAGE_BYTES, hexDumpRows, hexRowColumns, looksBinary } from "../shared/hex-dump.js";
import { archiveFormatFor, normalizeMemberName } from "../files/archive.js";

// ── Fixture writers ─────────────────────────────────────────────────────────
// Archives are built byte by byte here rather than with `zip` or `tar`, so the
// suite runs where neither is installed (brane doctor) and so a hostile
// archive — a `../` name, a lying size — is as easy to write as a good one.

interface ZipSpec {
  name: string;
  data?: Buffer | string;
  deflate?: boolean;
  /** Unix mode bits, written with "made by Unix". */
  mode?: number;
  encrypted?: boolean;
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function makeZip(entries: ZipSpec[], prefix = Buffer.alloc(0)): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "");
    const body = e.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, "utf8");
    const flags = (e.encrypted ? 1 : 0) | 0x800;
    const method = e.deflate ? 8 : 0;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE((46 << 9) | (1 << 5) | 1, 12); // 2026-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.mode !== undefined ? (3 << 8) | 20 : 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE((46 << 9) | (1 << 5) | 1, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.mode ?? 0) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([prefix, ...locals, cd, eocd]);
}

interface TarSpec {
  name: string;
  data?: string | Buffer;
  type?: string;
  link?: string;
  /** Written as a pax `path` record instead of in the header. */
  paxPath?: string;
}

function tarHeader(name: string, size: number, type: string, link = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("15107000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write(link, 157);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

function pad(buf: Buffer): Buffer {
  const rem = buf.length % 512;
  return rem ? Buffer.concat([buf, Buffer.alloc(512 - rem)]) : buf;
}

function makeTar(entries: TarSpec[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    if (e.paxPath) {
      const rec = (len: number) => `${len} path=${e.paxPath}\n`;
      let len = rec(0).length;
      while (rec(len).length !== len) len = rec(len).length;
      const body = Buffer.from(rec(len));
      parts.push(tarHeader("PaxHeader", body.length, "x"), pad(body));
    }
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "");
    parts.push(tarHeader(e.name, data.length, e.type ?? "0", e.link), pad(data));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

// ── Fixture fold ────────────────────────────────────────────────────────────

let fold: string;
const MIME = { ".png": "image/png", ".pdf": "application/pdf" };
const browse = (rel: string, opts: { raw?: boolean; offset?: number | null } = {}) =>
  browseFold(fold, rel, { mimeTypes: MIME, ...opts });

function json(r: BrowseResult): FilesJson {
  assert.ok("json" in r, "expected a JSON answer");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json as FilesJson;
}
function asFile(r: BrowseResult) {
  const j = json(r);
  assert.equal(j.type, "file");
  return j as Extract<FilesJson, { type: "file" }>;
}
function asDir(r: BrowseResult) {
  const j = json(r);
  assert.equal(j.type, "directory");
  return j as Extract<FilesJson, { type: "directory" }>;
}
async function rawBytes(r: BrowseResult): Promise<Buffer> {
  assert.ok("raw" in r, "expected a raw answer");
  const parts: Buffer[] = [];
  for await (const c of r.raw.stream) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(40000, 0xab)]);

before(() => {
  fold = mkdtempSync(join(tmpdir(), "brane-files-"));
  mkdirSync(join(fold, "dir"));
  writeFileSync(join(fold, "dir", "hello.ts"), "export const x = 1;\n");
  writeFileSync(join(fold, "prog.bin"), ELF);
  // Bigger than the inline limit, and binary: paged, never "too large".
  writeFileSync(join(fold, "huge.bin"), Buffer.concat([Buffer.from([0]), Buffer.alloc(MAX_INLINE + 10, 1)]));
  writeFileSync(join(fold, "pkg.zip"), makeZip([
    { name: "README.md", data: "# pkg\n" },
    { name: "src/main.ts", data: "const y: number = 2;\n".repeat(50), deflate: true },
    { name: "src/deep/", data: "" },
    { name: "bin/tool", data: ELF, deflate: true },
    { name: "link", data: "src/main.ts", mode: 0o120777 },
  ]));
  writeFileSync(join(fold, "evil.zip"), makeZip([
    { name: "../escape.txt", data: "nope" },
    { name: "/etc/passwd", data: "root:x:0:0\n" },
    { name: "a\\..\\..\\b.txt", data: "nope" },
    { name: "ok.txt", data: "fine" },
    { name: "secret.txt", data: "xxxx", encrypted: true },
  ]));
  // 64 MB of zeros that deflate to ~64 KB: the listing is instant, and a
  // read of the member produces one page, never the whole thing.
  writeFileSync(join(fold, "bomb.zip"), makeZip([{ name: "zeros", data: Buffer.alloc(64 * 1024 * 1024), deflate: true }]));
  // A self-extractor's stub before the zip proper: every offset is short.
  writeFileSync(join(fold, "sfx.zip"), makeZip([{ name: "inside.txt", data: "found me" }], Buffer.alloc(1000, 0x90)));
  writeFileSync(join(fold, "fake.zip"), "this is not a zip at all\n");

  const tar = makeTar([
    { name: "./", type: "5" },
    { name: "top.txt", data: "top\n" },
    { name: "._top.txt", data: "AppleDouble" },
    { name: "nested/dir/", type: "5" },
    { name: "nested/dir/n.py", data: "print('hi')\n" },
    { name: "short", paxPath: `${"long-".repeat(30)}name.txt`, data: "long named\n" },
    { name: "sym", type: "2", link: "top.txt" },
    { name: "hard", type: "1", link: "top.txt" },
    { name: "../../etc/evil", data: "nope" },
  ]);
  writeFileSync(join(fold, "t.tar"), tar);
  writeFileSync(join(fold, "t.tar.gz"), gzipSync(tar));
  writeFileSync(join(fold, "t.tar.br"), brotliCompressSync(tar));
  writeFileSync(join(fold, "notes.md.gz"), gzipSync("# compressed\n"));
  writeFileSync(join(fold, "code.ts.gz"), gzipSync("let z = 3;\n"));
  writeFileSync(join(fold, "junk.tar"), "not a tarball, just text that is long enough ".repeat(20));
});

// ── Hex ─────────────────────────────────────────────────────────────────────

describe("hex dump rules", () => {
  it("calls a file binary on a NUL in its first 8000 bytes, as git does", () => {
    assert.equal(looksBinary(Buffer.from("plain text\n")), false);
    assert.equal(looksBinary(Buffer.from([0x41, 0x00, 0x42])), true);
    const late = Buffer.alloc(9000, 0x41);
    late[8500] = 0;
    assert.equal(looksBinary(late), false);
  });

  it("lays rows out like xxd, numbered from the page's offset", () => {
    const rows = hexDumpRows(Buffer.from("Hello, world!\n\x00\x01ABC"), 0x20);
    assert.deepEqual(rows, [
      "00000020  48 65 6c 6c 6f 2c 20 77  6f 72 6c 64 21 0a 00 01  Hello, world!...",
      "00000030  41 42 43                                          ABC",
    ]);
  });

  it("narrows to eight bytes a row for a phone, columns still aligned", () => {
    const rows = hexDumpRows(Buffer.from("0123456789"), 0, 8);
    assert.deepEqual(rows, [
      "00000000  30 31 32 33 34 35 36 37  01234567",
      "00000008  38 39                    89",
    ]);
    assert.equal(rows[0].length, hexRowColumns(8));
    assert.equal(hexDumpRows(new Uint8Array(16))[0].length, hexRowColumns(16));
  });
});

describe("/api/files: plain files", () => {
  it("serves text as before", async () => {
    const f = asFile(await browse("dir/hello.ts"));
    assert.equal(f.content, "export const x = 1;\n");
    assert.equal(f.binary, undefined);
  });

  it("serves a binary file as its first hex page instead of mangled UTF-8", async () => {
    const f = asFile(await browse("prog.bin"));
    assert.equal(f.binary, true);
    assert.equal(f.content, "");
    assert.ok(f.hex);
    assert.equal(f.hex.offset, 0);
    assert.equal(f.hex.eof, false);
    const page = Buffer.from(f.hex.data, "base64");
    assert.equal(page.length, HEX_PAGE_BYTES);
    assert.deepEqual(page.subarray(0, 4), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  });

  it("pages further in with offset=, and says when the last page is reached", async () => {
    const f = asFile(await browse("prog.bin", { offset: 2 * HEX_PAGE_BYTES }));
    assert.ok(f.hex);
    assert.equal(f.hex.eof, true);
    assert.equal(Buffer.from(f.hex.data, "base64").length, ELF.length - 2 * HEX_PAGE_BYTES);
  });

  it("pages a binary past the inline limit rather than calling it too large", async () => {
    const f = asFile(await browse("huge.bin"));
    assert.equal(f.truncated, undefined);
    assert.ok(f.hex);
  });

  it("streams any file raw, text included, so Download works on large text", async () => {
    const bytes = await rawBytes(await browse("dir/hello.ts", { raw: true }));
    assert.equal(bytes.toString(), "export const x = 1;\n");
  });

  it("refuses paths that leave the fold", async () => {
    const r = await browse("../outside");
    assert.equal(r.status, 400);
    assert.equal((await browse("/etc/passwd")).status, 400);
  });

  it("validates offset=", () => {
    assert.equal(parseOffsetParam(null), null);
    assert.equal(parseOffsetParam("4096"), 4096);
    assert.equal(parseOffsetParam("-1"), undefined);
    assert.equal(parseOffsetParam("1e3"), undefined);
    assert.equal(parseOffsetParam("99999999999999999999"), undefined);
  });
});

// ── Zip ─────────────────────────────────────────────────────────────────────

describe("/api/files: zip archives", () => {
  it("marks archives in a directory listing", async () => {
    const d = asDir(await browse(""));
    const byName = new Map(d.entries.map((e) => [e.name, e]));
    assert.equal(byName.get("pkg.zip")?.archive, true);
    assert.equal(byName.get("t.tar.gz")?.archive, true);
    assert.equal(byName.get("notes.md.gz")?.archive, undefined, "a single compressed file opens as a file");
    assert.equal(byName.get("prog.bin")?.archive, undefined);
  });

  it("lists a zip as a directory, folders first, with implied folders", async () => {
    const d = asDir(await browse("pkg.zip"));
    assert.deepEqual(d.entries.map((e) => [e.name, e.is_dir]), [
      ["bin", true], ["src", true], ["link", false], ["README.md", false],
    ]);
    assert.deepEqual(d.archive, { root: "pkg.zip", format: "zip" });
    const src = asDir(await browse("pkg.zip/src"));
    assert.deepEqual(src.entries.map((e) => e.name), ["deep", "main.ts"]);
    assert.equal(src.path, "pkg.zip/src");
  });

  it("opens a deflated member with highlighting chosen by its own name", async () => {
    const f = asFile(await browse("pkg.zip/src/main.ts"));
    assert.equal(f.content, "const y: number = 2;\n".repeat(50));
    assert.equal((f.highlight as { lang: string } | null)?.lang, "typescript");
    assert.equal(f.archive?.root, "pkg.zip");
  });

  it("opens a binary member in the hex view, and streams it raw", async () => {
    const f = asFile(await browse("pkg.zip/bin/tool"));
    assert.ok(f.hex);
    assert.deepEqual(Buffer.from(f.hex.data, "base64").subarray(0, 4), ELF.subarray(0, 4));
    const bytes = await rawBytes(await browse("pkg.zip/bin/tool", { raw: true }));
    assert.deepEqual(bytes, ELF);
  });

  it("shows a symlink member's target without following it", async () => {
    const f = asFile(await browse("pkg.zip/link"));
    assert.equal(f.link, "src/main.ts");
    assert.equal(f.content, "");
  });

  it("still downloads the archive itself with raw=", async () => {
    const bytes = await rawBytes(await browse("pkg.zip", { raw: true }));
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  });

  it("hides names that can't be placed, and says how many", async () => {
    const d = asDir(await browse("evil.zip"));
    assert.deepEqual(d.entries.map((e) => e.name).sort(), ["etc", "ok.txt", "secret.txt"]);
    assert.equal(d.archive?.skipped, 2);
    assert.equal(asFile(await browse("evil.zip/etc/passwd")).content, "root:x:0:0\n");
  });

  it("explains an encrypted member instead of failing", async () => {
    const f = asFile(await browse("evil.zip/secret.txt"));
    assert.match(f.notice ?? "", /encrypted/);
  });

  it("decodes only one page of a decompression bomb", async () => {
    const d = asDir(await browse("bomb.zip"));
    assert.equal(d.entries[0].size, 64 * 1024 * 1024, "the claimed size is displayed");
    const before = process.memoryUsage().arrayBuffers;
    const f = asFile(await browse("bomb.zip/zeros"));
    assert.ok(f.hex);
    assert.equal(Buffer.from(f.hex.data, "base64").length, HEX_PAGE_BYTES);
    assert.ok(process.memoryUsage().arrayBuffers - before < 32 * 1024 * 1024);
  });

  it("finds a zip behind a self-extractor stub", async () => {
    assert.equal(asFile(await browse("sfx.zip/inside.txt")).content, "found me");
  });

  it("shows a file named .zip that isn't one as the file it is", async () => {
    const f = asFile(await browse("fake.zip"));
    assert.equal(f.content, "this is not a zip at all\n");
    assert.equal((await browse("fake.zip/anything")).status, 404);
  });

  it("404s a member that isn't there, and a path through a non-archive", async () => {
    assert.equal((await browse("pkg.zip/nope.txt")).status, 404);
    assert.equal((await browse("dir/hello.ts/x")).status, 404);
  });
});

// ── Tar ─────────────────────────────────────────────────────────────────────

for (const name of ["t.tar", "t.tar.gz", "t.tar.br"]) {
  describe(`/api/files: ${name}`, () => {
    it("lists members, with pax long names, and unsafe names and dotfiles hidden", async () => {
      const d = asDir(await browse(name));
      assert.deepEqual(d.entries.map((e) => e.name), [
        "nested", "hard", `${"long-".repeat(30)}name.txt`, "sym", "top.txt",
      ]);
      assert.equal(d.archive?.skipped, 1);
      assert.equal(d.entries.find((e) => e.name === "sym")?.link, "top.txt");
    });

    it("reads members, including one past earlier data", async () => {
      assert.equal(asFile(await browse(`${name}/top.txt`)).content, "top\n");
      const py = asFile(await browse(`${name}/nested/dir/n.py`));
      assert.equal(py.content, "print('hi')\n");
      assert.equal((py.highlight as { lang: string } | null)?.lang, "python");
      assert.equal(asFile(await browse(`${name}/${"long-".repeat(30)}name.txt`)).content, "long named\n");
    });

    it("opens a hard link as its target and shows a symlink's target", async () => {
      assert.equal(asFile(await browse(`${name}/hard`)).content, "top\n");
      assert.equal(asFile(await browse(`${name}/sym`)).link, "top.txt");
    });
  });
}

describe("/api/files: other compressed files", () => {
  it("opens a .gz as what it compresses, named by what's inside", async () => {
    const md = asFile(await browse("notes.md.gz"));
    assert.equal(md.content, "# compressed\n");
    assert.equal(md.path, "notes.md.gz");
    const ts = asFile(await browse("code.ts.gz"));
    assert.equal((ts.highlight as { lang: string } | null)?.lang, "typescript");
  });

  it("shows a .tar that isn't tar as the file it is", async () => {
    const f = asFile(await browse("junk.tar"));
    assert.match(f.content, /^not a tarball/);
  });
});

describe("archive names and formats", () => {
  it("recognizes zip-family and tar-family names", () => {
    assert.equal(archiveFormatFor("a/b.jar")?.kind, "zip");
    assert.equal(archiveFormatFor("report.DOCX")?.kind, "zip");
    assert.equal(archiveFormatFor("x.tgz")?.kind, "tar");
    assert.deepEqual(archiveFormatFor("log.txt.gz"), { kind: "single", label: "gz", codec: "gzip", inner: "log.txt" });
    assert.equal(archiveFormatFor(".zip"), null, "a bare extension is a dotfile, not an archive");
    assert.equal(archiveFormatFor("zipper.ts"), null);
  });

  it("normalizes member names, refusing any that climb", () => {
    assert.equal(normalizeMemberName("/abs/x"), "abs/x");
    assert.equal(normalizeMemberName("./a//b/./c"), "a/b/c");
    assert.equal(normalizeMemberName("win\\style\\path"), "win/style/path");
    assert.equal(normalizeMemberName("a/../b"), null);
    assert.equal(normalizeMemberName("..\\x"), null);
    assert.equal(normalizeMemberName("nul\0byte"), null);
    assert.equal(normalizeMemberName("./"), "", "the root: nothing to place, nothing wrong");
  });
});

describe("stream reach", () => {
  it("refuses a read past the reach limit rather than decoding up to it", async () => {
    let opened = 0;
    const src = streamSource(() => { opened++; return Readable.from([Buffer.alloc(100)]); }, null, 0, 0, 50);
    await assert.rejects(src.read(60, 10), ReachError);
    assert.equal(opened, 0, "nothing was decoded");
    assert.equal((await src.read(40, 100)).length, 10, "a read that straddles the limit is cut at it");
  });
});
