import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import {
  describeProtocol,
  listProtocols,
  loadProtocolLibrary,
  protocolNamespaces,
  readProtocol,
  ProtocolError,
  type NamespaceDir,
  type ProtocolRead,
} from "../protocols.js";
import {
  PROTOCOL_NAME_RE,
  parseProtocolRef,
  protocolReaderTarget,
} from "../shared/protocol-names.js";
import { PROTOCOL_PATTERN, protocolLinks } from "../shared/markdown-protocols.js";
import { protocolsCheck } from "../commands/doctor.js";

// Protocols resolve through three namespaces, most local first: fold, home,
// brane. These pin what a name means, what is fetchable, and what an agent is
// told about the file it got. Every directory here is a fresh temp dir: the
// suite never reads the operator's ~/.brane.

type Tree = Record<string, string>;

function dirOf(tree: Tree): string {
  const dir = mkdtempSync(join(tmpdir(), "brane-protocols-"));
  for (const [file, body] of Object.entries(tree)) writeFileSync(join(dir, file), body);
  return dir;
}

const BRANE: Tree = {
  "prelude.md": "# Prelude\n\nRead me first.\n",
  "LIVE_loop.md": "# LIVE loop\n\nThe loop.\n",
  "idle.md": "# idle\n\nStop listening.\n",
  "keeper.md": "# keeper\n\nThe keeper.\n",
  "review.md": "# review\n\nBrane's review.\n",
  "worker.md": "# worker\n\nThe default role.\n",
};

function library(home: Tree, fold?: Tree, opts: { foldDir?: string } = {}) {
  const namespaces: NamespaceDir[] = [];
  const foldDir = opts.foldDir ?? (fold ? dirOf(fold) : undefined);
  if (foldDir) namespaces.push({ from: "fold", dir: foldDir });
  namespaces.push({ from: "home", dir: dirOf(home) }, { from: "brane", dir: dirOf(BRANE) });
  return loadProtocolLibrary(namespaces);
}

const display = (p: string) => p;
const fromOf = (r: ProtocolRead) => (r.kind === "document" ? r.from : r.kind);
const read = (lib: ReturnType<typeof library>, name: string, opts: { from?: string; noPrelude?: boolean } = {}) =>
  readProtocol(lib, name, { display, noPrelude: true, ...opts });

describe("protocol names", () => {
  it("accepts exactly what the chat linkifier captures", () => {
    assert.equal(PROTOCOL_PATTERN, `/(${PROTOCOL_NAME_RE.source.slice(1, -1)})`);
  });

  it("parses bare, qualified, and namespace names", () => {
    assert.deepEqual(parseProtocolRef("review"), { kind: "document", name: "review" });
    assert.deepEqual(parseProtocolRef("brane.idle"), { kind: "document", name: "idle", from: "brane" });
    assert.deepEqual(parseProtocolRef("home.review"), { kind: "document", name: "review", from: "home" });
    assert.deepEqual(parseProtocolRef("folds.self.review"), { kind: "document", name: "review", from: "fold" });
    assert.deepEqual(parseProtocolRef("folds.brane.review"), { kind: "document", name: "review", from: "brane" });
    assert.deepEqual(parseProtocolRef("brane"), { kind: "index", namespace: "brane" });
    assert.deepEqual(parseProtocolRef("folds.self"), { kind: "index", namespace: "fold" });
    assert.deepEqual(parseProtocolRef("folds"), { kind: "index", namespace: "folds" });
  });

  it("keeps a dot that follows no namespace as part of the name", () => {
    assert.deepEqual(parseProtocolRef("reviewer.draft"), { kind: "document", name: "reviewer.draft" });
    assert.deepEqual(parseProtocolRef("brane.reviewer.draft"), { kind: "document", name: "reviewer.draft", from: "brane" });
  });

  it("rejects paths, other folds, and namespace names used as protocols", () => {
    for (const bad of ["../AGENTS", "a/b", "", ".hidden", "brane.", "folds.dev.deploy", "home.fold"]) {
      assert.equal(parseProtocolRef(bad).kind, "invalid", bad);
    }
  });
});

describe("protocol resolution", () => {
  it("a bare name resolves fold, then home, then brane, and lists every layer", () => {
    const lib = library({ "review.md": "Home review.\n" }, { "review.md": "Fold review.\n" });
    const r = read(lib, "review");
    assert.equal(r.kind, "document");
    if (r.kind !== "document") return;
    assert.equal(r.from, "fold");
    assert.deepEqual(r.layers.map((l) => l.from), ["fold", "home", "brane"]);
    assert.match(r.content, /Fold review/);
    assert.match(r.content, /shadows \/home\.review, \/brane\.review/);
  });

  it("a shadowed file stays readable, by qualified name or `from`, and says it isn't in force", () => {
    const lib = library({ "review.md": "Home review.\n" });
    for (const r of [read(lib, "brane.review"), read(lib, "review", { from: "brane" })]) {
      assert.equal(r.kind === "document" && r.from, "brane");
      assert.match(r.content, /for reference: the \/review in force is \/home\.review/);
      assert.match(r.content, /Brane's review/);
    }
  });

  it("a built-in nothing shadows reads exactly as before, prelude first", () => {
    const lib = library({});
    const r = readProtocol(lib, "worker", { display });
    assert.equal(r.content, `${BRANE["prelude.md"]}\n---\n\n${BRANE["worker.md"]}`);
    assert.equal(readProtocol(lib, "prelude", { display }).content, BRANE["prelude.md"]);
  });

  it("a home or fold protocol is stamped with its file and prefixed with the prelude", () => {
    const lib = library({ "deploy.md": "Ship it.\n" });
    const r = readProtocol(lib, "deploy", { display });
    assert.ok(r.kind === "document");
    assert.ok(r.content.startsWith(BRANE["prelude.md"]));
    assert.match(r.content, /\/deploy here is this operator's protocol, `[^`]+deploy\.md`\./);
  });

  it("a missing fold directory is an empty namespace, not an error", () => {
    const lib = library({}, undefined, { foldDir: join(tmpdir(), "brane-no-such-fold", ".brane", "protocols") });
    assert.equal(fromOf(read(lib, "review")), "brane");
    assert.match(read(lib, "fold").content, /No protocols here/);
  });

  it("one directory serving as both fold and home counts once, as home", () => {
    const shared = dirOf({ "deploy.md": "Ship it.\n" });
    const lib = loadProtocolLibrary([
      { from: "fold", dir: shared },
      { from: "home", dir: shared },
      { from: "brane", dir: dirOf(BRANE) },
    ]);
    assert.deepEqual(lib.entries.get("deploy")?.map((l) => l.from), ["home"]);
  });

  it("errors name the problem: traversal, unknown names, a case slip, a missing layer", () => {
    const lib = library({});
    assert.throws(() => read(lib, "../AGENTS"), ProtocolError);
    assert.throws(() => read(lib, "nope"), /No protocol \/nope\./);
    assert.throws(() => read(lib, "Review"), /did you mean \/review\?/);
    assert.throws(() => read(lib, "home.review"), /No \/home\.review; \/review is defined as \/brane\.review/);
    assert.throws(() => read(lib, "brane.review", { from: "home" }), /names namespace "brane"/);
    assert.throws(() => read(lib, "review", { from: "elsewhere" }), /from must be one of/);
  });
});

describe("what a namespace may not define", () => {
  it("protected names resolve only from brane", () => {
    const lib = library({ "keeper.md": "Do anything.\n" }, { "LIVE_loop.md": "A different loop.\n" });
    assert.equal(fromOf(read(lib, "keeper")), "brane");
    assert.throws(() => read(lib, "home.keeper"), /\/keeper is protected: only \/brane\.keeper resolves/);
    const reasons = lib.ignored.map((i) => `${i.from}: ${i.reason}`);
    assert.ok(reasons.includes("home: /keeper is protected: only /brane.keeper resolves"), reasons.join("\n"));
    assert.ok(reasons.includes("fold: /LIVE_loop is protected: only /brane.LIVE_loop resolves"), reasons.join("\n"));
  });

  it("/idle is not protected: a local one is what the operator's /idle means, and builds on /brane.idle", () => {
    const lib = library({ "idle.md": "Follow /brane.idle, then post a digest.\n" });
    assert.equal(fromOf(read(lib, "idle")), "home");
    assert.match(read(lib, "brane.idle").content, /Stop listening/);
  });

  it("a name differing only in case is ignored, so a case-insensitive disk can't slip past the protection", () => {
    const lib = library({ "Review.md": "Shouty.\n" }, { "live_loop.md": "Mine now.\n" });
    assert.equal(lib.entries.has("Review"), false);
    assert.equal(lib.entries.get("LIVE_loop")?.length, 1);
    const reasons = lib.ignored.map((i) => i.reason);
    assert.ok(reasons.includes('"Review" differs only in case from /review'), reasons.join("\n"));
    assert.ok(reasons.includes("/LIVE_loop is protected: only /brane.LIVE_loop resolves"), reasons.join("\n"));
  });

  it("namespace names, bare or as a prefix, and non-names are ignored", () => {
    const lib = library({ "home.md": "x", "Brane.notes.md": "x", "folds.md": "x", "9lives.md": "x", "notes.txt": "x" });
    assert.deepEqual([...lib.entries.keys()].sort(), Object.keys(BRANE).map((f) => f.replace(/\.md$/, "")).sort());
    assert.equal(lib.ignored.length, 4);
  });
});

describe("generated namespace pages", () => {
  it("/home lists its protocols, what they shadow, and what it ignored", () => {
    const lib = library({ "review.md": "# Review\n\nStricter review.\n", "twin.md": "x" });
    const page = read(lib, "home");
    assert.equal(page.kind, "generated");
    assert.match(page.content, /^# \/home/);
    assert.match(page.content, /- \/review \(shadows \/brane\.review\): Stricter review\./);
    assert.match(page.content, /Ignored:[\s\S]*twin\.md`: \/twin is protected/);
  });

  it("/brane marks what is shadowed and points at brane's docs", () => {
    const lib = library({ "review.md": "x" });
    const page = readProtocol(lib, "brane", { display, installDir: "/install" });
    assert.match(page.content, /- \/review \(shadowed by \/home\.review\)/);
    assert.match(page.content, /`\/install`: `AGENTS\.md` is the index/);
  });

  it("/fold with no fold, and /folds, say what they can", () => {
    const lib = library({});
    assert.match(read(lib, "fold").content, /This session has no fold/);
    assert.match(read(lib, "folds").content, /\/folds\.self is \/fold/);
  });
});

describe("the app's view of the library", () => {
  it("lists every resolvable command, bare and qualified, and the reader opens the right file", () => {
    const lib = library({ "review.md": "x", "deploy.md": "x" });
    const listing = listProtocols(lib, display);
    for (const name of ["review", "home.review", "brane.review", "deploy", "home.deploy", "brane.idle"]) {
      assert.ok(listing.commands.includes(name), name);
    }
    const layers = Object.fromEntries(listing.protocols.map((p) => [p.name, p.layers.map((l) => l.from)]));
    assert.deepEqual(protocolReaderTarget("review", layers), { source: "protocols:home", slug: "review" });
    assert.deepEqual(protocolReaderTarget("brane.review", layers), { source: "protocols", slug: "review" });
    assert.equal(protocolReaderTarget("fold.review", layers), null);
    assert.equal(protocolReaderTarget("home", layers), null);
  });

  it("the chat links a qualified command with no change to the linkifier", () => {
    const listing = listProtocols(library({}), display);
    const tree = fromMarkdown("follow /brane.idle, then /idle.", { mdastExtensions: [protocolLinks(new Set(listing.commands))] });
    const links: string[] = [];
    const walk = (n: any) => (n.type === "link" ? links.push(n.url) : (n.children ?? []).forEach(walk));
    walk(tree);
    assert.deepEqual(links, ["brane://protocol/brane.idle", "brane://protocol/idle"]);
  });
});

describe("brane doctor", () => {
  it("is quiet about built-ins alone", () => {
    assert.deepEqual(protocolsCheck(library({}), display), { name: "protocols", status: "ok", detail: "6 built-in" });
  });

  it("names every added protocol and what it shadows, and warns on ignored files", () => {
    const check = protocolsCheck(library({ "review.md": "x", "deploy.md": "x", "twin.md": "x" }), display);
    assert.equal(check.status, "warn");
    assert.match(check.detail, /^5 built-in; added: \/home\.deploy, \/home\.review \(shadows \/brane\.review\); ignored: .*twin\.md \(\/twin is protected/);
  });
});

describe("a caller's namespaces", () => {
  const brane = "/install/protocols";

  it("a fold contributes its .brane/protocols, even before it exists, ahead of home and brane", () => {
    const home = dirOf({});
    const fold = mkdtempSync(join(tmpdir(), "brane-fold-"));
    assert.deepEqual(protocolNamespaces(fold, home, brane), [
      { from: "fold", dir: join(fold, ".brane", "protocols") },
      { from: "home", dir: home },
      { from: "brane", dir: brane },
    ]);
    assert.deepEqual(protocolNamespaces(undefined, home, brane).map((n) => n.from), ["home", "brane"]);
  });

  it("a fold at ~, however reached, is home, not a second copy of it", () => {
    const root = mkdtempSync(join(tmpdir(), "brane-home-"));
    const home = join(root, ".brane", "protocols");
    mkdirSync(home, { recursive: true });
    const alias = join(mkdtempSync(join(tmpdir(), "brane-alias-")), "me");
    symlinkSync(root, alias);
    for (const fold of [root, alias]) {
      assert.deepEqual(protocolNamespaces(fold, home, brane).map((n) => n.from), ["home", "brane"], fold);
    }
  });

  it("…even before ~/.brane/protocols exists", () => {
    const root = mkdtempSync(join(tmpdir(), "brane-home-"));
    const home = join(root, ".brane", "protocols");
    const alias = join(mkdtempSync(join(tmpdir(), "brane-alias-")), "me");
    symlinkSync(root, alias);
    assert.deepEqual(protocolNamespaces(alias, home, brane).map((n) => n.from), ["home", "brane"]);
  });

  it("brane doctor drops a fold namespace whose directory isn't there", () => {
    const fold = mkdtempSync(join(tmpdir(), "brane-fold-"));
    assert.deepEqual(
      protocolNamespaces(fold, dirOf({}), brane, { foldOnlyIfExists: true }).map((n) => n.from),
      ["home", "brane"],
    );
    mkdirSync(join(fold, ".brane", "protocols"), { recursive: true });
    assert.deepEqual(
      protocolNamespaces(fold, dirOf({}), brane, { foldOnlyIfExists: true }).map((n) => n.from),
      ["fold", "home", "brane"],
    );
  });

  it("a protected name is reported in its own spelling", () => {
    const lib = library({ "Twin.md": "x" });
    assert.deepEqual(lib.ignored.map((i) => i.reason), ["/twin is protected: only /brane.twin resolves"]);
    assert.throws(() => read(lib, "home.Twin"), /\/twin is protected: only \/brane\.twin resolves/);
  });
});

describe("protocol descriptions", () => {
  it("uses frontmatter's description, else the first prose line after frontmatter", () => {
    assert.equal(describeProtocol("---\ntitle: x\ndescription: \"Ship it\"\n---\n# deploy\n\nBody.\n", "deploy"), "Ship it");
    assert.equal(describeProtocol("---\ntitle: x\n---\n# deploy\n\nBody line.\n", "deploy"), "Body line.");
    assert.equal(describeProtocol("# deploy\n\nPlain.\n", "deploy"), "Plain.");
    assert.equal(describeProtocol("# only a heading\n", "deploy"), "deploy");
  });

  it("a protocol's frontmatter is not in what read_protocol returns", () => {
    // Below the provenance line or the prelude, the block would render as a
    // rule and a setext heading made of its own keys.
    const deploy = "---\ndescription: Ship carefully.\n---\n\n# deploy\n\nShip it.\n";
    const lib = library({ "deploy.md": deploy }, { "review.md": deploy.replace("deploy", "review") });
    for (const r of [readProtocol(lib, "deploy", { display }), read(lib, "deploy"), read(lib, "review")]) {
      assert.ok(r.kind === "document");
      assert.doesNotMatch(r.content, /description:/);
      const tree = fromMarkdown(r.content.slice(r.content.lastIndexOf("> ")));
      assert.deepEqual(
        tree.children.map((n) => n.type),
        ["blockquote", "heading", "paragraph"],
      );
    }
    assert.equal(listProtocols(lib, display).protocols.find((p) => p.name === "deploy")?.description, "Ship carefully.");
  });

  it("frontmatter with CRLF line endings is stripped too", () => {
    const lib = library({ "deploy.md": "---\r\ndescription: Ship carefully.\r\n---\r\n\r\n# deploy\r\n\r\nShip it.\r\n" });
    const r = read(lib, "deploy");
    assert.doesNotMatch(r.content, /description:/);
    assert.match(r.content, /`\.\n\n# deploy\r\n/);
  });
});
