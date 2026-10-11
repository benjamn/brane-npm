/**
 * The CLI commands that became daemon clients: `absorb`, `list`,
 * `fold`, `memory`. Each is a request builder plus a formatter around
 * `daemonRequest` / `daemonStream`, so that is what is pinned here — the
 * body each sends, the text each prints for a given daemon answer, and the
 * NDJSON transport absorb rides on. The daemon-side rule that moved with
 * them (fold registration: loopback keeps full reach, everyone else is
 * confined to $HOME) is pinned against a temp dir and an in-memory DB.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "./helpers.js";
import { daemonStream, type DaemonEndpoint } from "../daemon/client.js";
import {
  buildAbsorbBody,
  formatProgress,
  formatSummary,
  type AbsorbStreamLine,
} from "../commands/absorb.js";
import { runHistory } from "../commands/run.js";
import { formatNarrativeList } from "../commands/list.js";
import { formatFoldInfo, formatFoldList } from "../commands/fold.js";
import {
  buildRecentQuery,
  formatRecentNarratives,
  formatSearchResults,
  formatIndexResult,
} from "../commands/memory.js";
import { foldPathRefusal, registerFold, FoldRegistrationError } from "../folds.js";
import { isLoopbackAddress, parseRecentQuery, singleFlight } from "../daemon/server.js";
import { runAbsorb, AbsorbInputError, deriveBraneId, type AbsorbEvent } from "../absorb/run.js";
import type { AbsorbSummary } from "../absorb/types.js";

describe("buildAbsorbBody", () => {
  it("sends only what the operator said, so the daemon's defaults stay in charge", () => {
    assert.deepEqual(buildAbsorbBody({ provider: "organelle" }, "/work"), {
      provider: "organelle",
    });
  });

  it("resolves relative paths against this shell's cwd, not the daemon's", () => {
    assert.deepEqual(
      buildAbsorbBody({ provider: "chatgpt", path: "export", fold: "../proj" }, "/work/here"),
      { provider: "chatgpt", path: "/work/here/export", fold: "/work/proj" },
    );
  });

  it("leaves ~/ paths portable for the daemon to expand", () => {
    assert.deepEqual(
      buildAbsorbBody({ provider: "chatgpt", path: "/abs/export", fold: "~/proj" }, "/work"),
      { provider: "chatgpt", path: "/abs/export", fold: "~/proj" },
    );
  });

  it("maps --dry-run onto dry_run and passes identity and brane through", () => {
    assert.deepEqual(
      buildAbsorbBody(
        { provider: "chatgpt", fold: "~/p", identity: "me@x", brane: "self", dryRun: true },
        "/work",
      ),
      { provider: "chatgpt", fold: "~/p", identity: "me@x", brane: "self", dry_run: true },
    );
  });
});

describe("absorb formatting", () => {
  const summary: AbsorbSummary = {
    provider: "chatgpt",
    conversations: 3,
    messages: 40,
    oldest: { time: Date.UTC(2024, 0, 2), title: "first" },
    newest: { time: Date.UTC(2025, 5, 1), title: null },
    models: { "gpt-4o": 2, "o3": 1 },
    skipped: 1,
    appended: 1,
    assets: 2,
    assetsBytes: 2048,
    unresolvedAssets: 1,
  };

  it("prints the summary the in-process command printed", () => {
    assert.deepEqual(formatSummary(summary, false), [
      "Absorbed: 3 conversations, 40 messages (5 total parsed)",
      "Updated: 1 (new messages to append)",
      "Skipped: 1 (already absorbed)",
      "Assets: 2/3 resolved (2.0 KB)",
      "  Unresolved: 1 (files not included in export)",
      'Oldest: 2024-01-02 "first"',
      "Newest: 2025-06-01 null",
      "Models: gpt-4o (2), o3 (1)",
    ]);
  });

  it("switches verbs for a dry run and says where assets would go", () => {
    const lines = formatSummary(summary, true);
    assert.equal(lines[0], "Would absorb: 3 conversations, 40 messages (5 total parsed)");
    assert.equal(lines[1], "Would update: 1 (new messages to append)");
    assert.match(lines[3], /would copy to ~\/\.brane\/payloads\/$/);
  });

  it("labels organelle's models as agent types", () => {
    const lines = formatSummary({ ...summary, provider: "organelle", models: { claude: 4 } }, false);
    assert.equal(lines.at(-1), "Agent types: claude (4)");
  });

  it("truncates long titles on the progress line and pads to a fixed width", () => {
    const line = formatProgress(12, "a".repeat(60), false);
    assert.ok(line.startsWith("\r  12 absorbed: " + "a".repeat(47) + "..."));
    assert.equal(line.length, 80);
    assert.ok(formatProgress(1, null, true).startsWith("\r  1 scanned: (untitled)"));
  });
});

describe("daemonStream", () => {
  let server: ReturnType<typeof createServer>;
  let endpoint: DaemonEndpoint;
  let mode: "ok" | "midstream-error" | "reject" | "no-trailing-newline" = "ok";

  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (mode === "reject") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "--fold is required for chatgpt provider." }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(JSON.stringify({ type: "info", message: `got ${JSON.parse(body).provider}` }) + "\n");
        // Two records in one chunk, then one split across chunks.
        res.write(
          JSON.stringify({ type: "progress", done: 1, title: "a" }) + "\n" +
            JSON.stringify({ type: "progress", done: 2, title: "b" }) + "\n" +
            '{"type":"prog',
        );
        setTimeout(() => {
          res.write('ress","done":3,"title":null}\n');
          if (mode === "midstream-error") {
            res.end(JSON.stringify({ type: "error", error: "disk full" }) + "\n");
          } else if (mode === "no-trailing-newline") {
            res.end(JSON.stringify({ type: "info", message: "last" }));
          } else {
            res.end();
          }
        }, 5);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    endpoint = { baseUrl: `http://127.0.0.1:${port}`, token: "tok", port: String(port) };
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("delivers every record in order, whether packed together or split across chunks", async () => {
    mode = "ok";
    const seen: AbsorbStreamLine[] = [];
    await daemonStream<AbsorbStreamLine>(
      endpoint,
      "/api/absorb",
      { method: "POST", body: { provider: "chatgpt" } },
      (l) => seen.push(l),
    );
    assert.deepEqual(seen, [
      { type: "info", message: "got chatgpt" },
      { type: "progress", done: 1, title: "a" },
      { type: "progress", done: 2, title: "b" },
      { type: "progress", done: 3, title: null },
    ]);
  });

  it("hands a mid-stream error line to the caller rather than throwing — the daemon already accepted the request", async () => {
    mode = "midstream-error";
    const seen: AbsorbStreamLine[] = [];
    await daemonStream<AbsorbStreamLine>(endpoint, "/api/absorb", { body: { provider: "x" } }, (l) =>
      seen.push(l),
    );
    assert.deepEqual(seen.at(-1), { type: "error", error: "disk full" });
  });

  it("parses a final record the daemon ended without a newline", async () => {
    mode = "no-trailing-newline";
    const seen: AbsorbStreamLine[] = [];
    await daemonStream<AbsorbStreamLine>(endpoint, "/api/absorb", { body: { provider: "x" } }, (l) =>
      seen.push(l),
    );
    assert.deepEqual(seen.at(-1), { type: "info", message: "last" });
  });

  it("throws the daemon's own error string for a request it refused up front", async () => {
    mode = "reject";
    await assert.rejects(
      () => daemonStream(endpoint, "/api/absorb", { body: { provider: "chatgpt" } }, () => {}),
      /^Error: --fold is required for chatgpt provider\.$/,
    );
  });
});

describe("runHistory", () => {
  function narrative(db: ReturnType<typeof createTestDb>, id: string, agentType: string | null, role: string, createdAt: number, archived = 0) {
    db.prepare(
      `INSERT INTO narratives (id, brane_id, fold_path, agent_type, role, created_at, status, archived)
       VALUES (?, 'brane-test', '~/dev/x', ?, ?, ?, 'ended', ?)`,
    ).run(id, agentType, role, createdAt, archived);
  }

  it("groups utility runs by command, most recently used first, counting archived ones", () => {
    const db = createTestDb();
    narrative(db, "lazygit-1", "lazygit", "utility", 100, 1);
    narrative(db, "zsh-1", "zsh", "utility", 200, 1);
    narrative(db, "lazygit-2", "lazygit", "utility", 300, 1);
    narrative(db, "htop-1", "htop", "utility", 150);
    assert.deepEqual(runHistory(db), [
      { command: "lazygit", last_used: 300, use_count: 2 },
      { command: "zsh", last_used: 200, use_count: 1 },
      { command: "htop", last_used: 150, use_count: 1 },
    ]);
  });

  it("leaves out agents and rows with no command", () => {
    const db = createTestDb();
    narrative(db, "claude-1", "claude", "worker", 500);
    narrative(db, "blank-1", "", "utility", 400);
    narrative(db, "null-1", null, "utility", 300);
    narrative(db, "zsh-1", "zsh", "utility", 100);
    assert.deepEqual(runHistory(db).map((h) => h.command), ["zsh"]);
  });

  it("honors the limit", () => {
    const db = createTestDb();
    for (let i = 0; i < 5; i++) narrative(db, `c${i}-1`, `c${i}`, "utility", i);
    assert.deepEqual(runHistory(db, 2).map((h) => h.command), ["c4", "c3"]);
  });
});

describe("formatNarrativeList", () => {
  const now = Date.UTC(2026, 8, 4, 12, 0, 0);
  const narratives = [
    { id: "claude-aaaaaaaa", brane_id: "brane-home", agent_type: "claude", role: "worker", fold_path: "~/p", status: "active", summary: "Doing the thing that is quite long indeed and more than fifty", created_at: now - 90_000 },
    { id: "chatgpt-bbbbbbbb", brane_id: "brane-chatgpt-1", agent_type: "chatgpt", role: "absorbed", fold_path: "~/p", status: "ended", summary: null, created_at: now - 3 * 86_400_000 },
    { id: "claude-cccccccc", brane_id: "brane-home", agent_type: "claude", role: "worker", fold_path: "~/p", status: "ended", summary: null, created_at: now - 7_200_000 },
  ];
  const branes = [
    { brane_id: "brane-home", is_home: true },
    { brane_id: "brane-chatgpt-1", is_home: false },
  ];

  it("groups by brane in the order the daemon listed them, marking home", () => {
    assert.equal(
      formatNarrativeList(narratives, branes, { limit: 10, now }),
      [
        "",
        "  ● brane-home (home)  [1 active, 2 total]",
        "    ● claude-aaaaaaaa  Doing the thing that is quite long indeed and m...  1m ago",
        "    ○ claude-cccccccc  claude/worker  2h ago",
        "",
        "  ○ brane-chatgpt-1  [0 active, 1 total]",
        "    ○ chatgpt-bbbbbbbb  chatgpt/absorbed  3d ago",
        "",
      ].join("\n"),
    );
  });

  it("applies the per-brane limit and says how many it hid", () => {
    const out = formatNarrativeList(narratives, branes, { limit: 1, now });
    assert.match(out, /claude-aaaaaaaa/);
    assert.doesNotMatch(out, /claude-cccccccc/);
    assert.match(out, /\.\.\. and 1 more \(--limit 0 to show all\)/);
  });

  it("points at spawn when there is nothing to list", () => {
    assert.equal(
      formatNarrativeList([], branes, { limit: 10 }),
      "No narratives. Use `brane spawn <agent>` to start one.",
    );
  });
});

describe("fold formatting", () => {
  const fold = { path: "~/dev/p", created_at: Date.UTC(2026, 0, 1), last_spawned: null, brane_id: "brane-home", archived: 0 };

  it("shows only the narratives spawned from this fold", () => {
    const out = formatFoldInfo(fold, [
      { id: "claude-11111111", agent_type: "claude", role: "worker", status: "active", fold_path: "~/dev/p" },
      { id: "claude-22222222", agent_type: "claude", role: "worker", status: "ended", fold_path: "~/dev/other" },
    ]);
    assert.match(out, /^Fold: ~\/dev\/p\n/);
    assert.match(out, /last spawned: never  brane: brane-home/);
    assert.match(out, /● claude-11111111 \(claude, worker\)/);
    assert.doesNotMatch(out, /claude-22222222/);
  });

  it("lists folds and flags archived ones", () => {
    const out = formatFoldList([fold, { ...fold, path: "~/old", archived: 1 }]);
    assert.match(out, /^Registered folds:\n\n  ~\/dev\/p\n/);
    assert.match(out, /  ~\/old  \(archived\)\n/);
    assert.equal(formatFoldList([]), "No folds registered. Run `brane fold` in a directory to register it.");
  });
});

describe("memory formatting and queries", () => {
  it("builds the recent query with a cwd-resolved fold and a numeric limit", () => {
    const q = new URLSearchParams(
      buildRecentQuery({ since: "2d", search: "daemon restart", status: "active", limit: "abc", fold: "sub" }, "/work"),
    );
    assert.equal(q.get("since"), "2d");
    assert.equal(q.get("search"), "daemon restart");
    assert.equal(q.get("status"), "active");
    assert.equal(q.get("limit"), "20");
    assert.equal(q.get("fold"), "/work/sub");
    assert.equal(new URLSearchParams(buildRecentQuery({ since: "1h", limit: "5", fold: "~/p" }, "/w")).get("fold"), "~/p");
    assert.equal(q.get("archived"), null);
    assert.equal(new URLSearchParams(buildRecentQuery({ since: "1h", limit: "5", archived: true }, "/w")).get("archived"), "1");
  });

  it("parses the recent query the way the route does", () => {
    const ok = parseRecentQuery(new URLSearchParams("since=2d&search=x&status=active&fold=~/p&limit=0&archived=1&brane_ids=a, b,,c"));
    assert.ok("args" in ok);
    assert.deepEqual(ok.braneIds, ["a", "b", "c"]);
    assert.deepEqual(ok.args, { since: "2d", search: "x", status: "active", fold: "~/p", archived: true, limit: 0 });
    const bare = parseRecentQuery(new URLSearchParams(""));
    assert.ok("args" in bare);
    assert.deepEqual(bare.braneIds, []);
    assert.deepEqual(bare.args, { since: undefined, search: undefined, status: undefined, fold: undefined, archived: false });
    for (const bad of ["limit=abc", "limit=1.5", "limit=-1"]) {
      const r = parseRecentQuery(new URLSearchParams(bad));
      assert.ok("error" in r, bad);
    }
  });

  it("prints recent narratives with title, recency and event count", () => {
    const out = formatRecentNarratives(
      [
        { id: "claude-11111111", agent_type: "claude", role: "worker", status: "active", title: "Thin CLI", summary: "wrapping", last_activity: 0, last_activity_ago: "3m ago", event_count: 1 },
        { id: "goose-22222222", agent_type: "goose", role: "worker", status: "ended", title: null, summary: null, last_activity: 0, last_activity_ago: "2h ago", event_count: 12 },
      ],
      "24h",
    );
    assert.equal(
      out,
      ['● claude-11111111  "Thin CLI"  3m ago  (1 event)', "  Summary: wrapping", "○ goose-22222222  (goose)  2h ago  (12 events)"].join("\n"),
    );
    assert.equal(formatRecentNarratives([], "2d"), "No narratives active in the last 2d.");
  });

  it("prints search hits with an attach hint, and index stats", () => {
    const out = formatSearchResults([{ narrative_id: "claude-11111111", seq: 4, content: "x".repeat(130), score: 1.234 }]);
    assert.match(out, /^Found 1 results:\n\n1\. claude-11111111 \(seq 4\) - Score: 1\.23\n   "x{120}\.\.\."\n   > brane attach claude-11111111\n$/);
    assert.equal(formatSearchResults([]), "No results found.");
    assert.equal(
      formatIndexResult({ rebuild: false, narratives_scanned: 10, narratives_indexed: 2, chunks_created: 30 }),
      "Done. Scanned 10 narratives, indexed 2, created 30 chunks.",
    );
  });
});

describe("fold registration reach", () => {
  const root = mkdtempSync(join(tmpdir(), "brane-folds-"));
  const home = join(root, "home");
  const project = join(home, "project");
  const outside = join(root, "elsewhere");
  mkdirSync(project, { recursive: true });
  mkdirSync(outside, { recursive: true });

  it("recognizes loopback in every spelling and nothing else", () => {
    for (const a of ["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1"]) assert.ok(isLoopbackAddress(a), a);
    for (const a of ["100.101.102.103", "192.168.1.9", "::ffff:192.168.1.9", "", "localhost"]) assert.ok(!isLoopbackAddress(a), a);
  });

  it("confines a remote client to $HOME and refuses $HOME itself", () => {
    assert.equal(foldPathRefusal(project, { confineToHome: true, home })?.status, undefined);
    assert.equal(foldPathRefusal(outside, { confineToHome: true, home })?.status, 403);
    assert.equal(foldPathRefusal(home, { confineToHome: true, home })?.status, 403);
  });

  it("gives a loopback caller the operator's reach, but still wants a directory", () => {
    assert.equal(foldPathRefusal(outside, { confineToHome: false, home }), null);
    writeFileSync(join(outside, "file.txt"), "");
    assert.equal(foldPathRefusal(join(outside, "file.txt"), { confineToHome: false, home })?.status, 400);
    assert.equal(foldPathRefusal(join(outside, "missing"), { confineToHome: true, home: root })?.status, 400);
  });

  it("registers once, then rebinds the brane and un-archives on re-registration", () => {
    const db = createTestDb();
    const first = registerFold(db, outside, { confineToHome: false, braneId: "brane-a", home });
    assert.equal(first.created, true);
    assert.equal(first.fold.brane_id, "brane-a");
    db.prepare("UPDATE folds SET archived = 1 WHERE path = ?").run(first.fold.path);

    const again = registerFold(db, outside, { confineToHome: false, braneId: "brane-b", home });
    assert.equal(again.created, false);
    assert.equal(again.fold.brane_id, "brane-b");
    assert.equal(again.fold.archived, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM folds").get() as { n: number }).n, 1);

    assert.throws(
      () => registerFold(db, outside, { confineToHome: true, braneId: "brane-c", home }),
      (err: unknown) => err instanceof FoldRegistrationError && err.status === 403,
    );

    // Re-registering without naming a brane is a no-op on the binding.
    const kept = registerFold(db, outside, { confineToHome: false, home });
    assert.equal(kept.created, false);
    assert.equal(kept.fold.brane_id, "brane-b");
    db.close();
  });
});

describe("singleFlight", () => {
  it("never overlaps two passes, and a rejecting pass does not poison the next", async () => {
    const log: string[] = [];
    const gates: Array<() => void> = [];
    const flight = singleFlight(async (label: string) => {
      log.push(`start ${label}`);
      await new Promise<void>((r) => gates.push(r));
      log.push(`end ${label}`);
      if (label === "b") throw new Error("pass b failed");
      return label.toUpperCase();
    });
    const a = flight.run("a");
    const b = flight.run("b");
    const c = flight.run("c");
    assert.ok(flight.busy());
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(log, ["start a"]); // b and c are queued, not started
    gates.shift()!();
    assert.equal(await a, "A");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(log, ["start a", "end a", "start b"]);
    gates.shift()!();
    await assert.rejects(b, /pass b failed/);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(log, ["start a", "end a", "start b", "end b", "start c"]);
    gates.shift()!();
    assert.equal(await c, "C"); // c ran despite b's failure, and got its own result
    assert.ok(!flight.busy());
    await flight.inflight(); // resolves, never rejects
  });
});

describe("runAbsorb input validation", () => {
  const root = mkdtempSync(join(tmpdir(), "brane-absorb-"));

  it("derives a stable brane id from provider and identity", () => {
    assert.equal(deriveBraneId("chatgpt", "user-1"), deriveBraneId("chatgpt", "user-1"));
    assert.match(deriveBraneId("chatgpt", "user-1"), /^brane-chatgpt-[0-9a-f]{6}$/);
    assert.notEqual(deriveBraneId("chatgpt", "user-1"), deriveBraneId("organelle", "user-1"));
  });

  it("rejects before emitting anything, so the route can still answer 400", async () => {
    const db = createTestDb();
    const emitted: AbsorbEvent[] = [];
    const emit = (e: AbsorbEvent) => emitted.push(e);
    const opts = { confineFoldsToHome: false };

    await assert.rejects(
      () => runAbsorb(db, { provider: "nope", path: root }, emit, opts),
      (err: unknown) => err instanceof AbsorbInputError && /Unknown provider: nope/.test(err.message),
    );
    await assert.rejects(
      () => runAbsorb(db, { provider: "chatgpt", path: join(root, "missing"), fold: root }, emit, opts),
      (err: unknown) => err instanceof AbsorbInputError && /Not found/.test(err.message),
    );
    await assert.rejects(
      () => runAbsorb(db, { provider: "chatgpt", path: root }, emit, opts),
      (err: unknown) => err instanceof AbsorbInputError && /--fold is required/.test(err.message),
    );
    await assert.rejects(
      () => runAbsorb(db, { provider: "chatgpt", path: root, fold: root }, emit, opts),
      (err: unknown) => err instanceof AbsorbInputError && /No conversation files/.test(err.message),
    );
    // A fold the daemon would refuse is caught here too, not mid-stream —
    // and on a dry run, which never reaches registerFold.
    const exp = join(root, "export");
    mkdirSync(exp);
    writeFileSync(join(exp, "conversations.json"), "[]");
    writeFileSync(join(exp, "user.json"), JSON.stringify({ id: "u1", email: "u@x" }));
    await assert.rejects(
      () => runAbsorb(db, { provider: "chatgpt", path: exp, fold: join(root, "missing-fold"), dry_run: true }, emit, opts),
      (err: unknown) => err instanceof FoldRegistrationError && err.status === 400,
    );
    await assert.rejects(
      () => runAbsorb(db, { provider: "chatgpt", path: exp, fold: exp }, emit, { confineFoldsToHome: true }),
      (err: unknown) => err instanceof FoldRegistrationError && err.status === 403,
    );
    assert.deepEqual(emitted, []);
    db.close();
  });
});
