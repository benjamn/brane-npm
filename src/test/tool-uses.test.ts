import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.js";
import { adoptBindTokens } from "../db/tokens.js";
import { appendEvent } from "../db/events.js";
import {
  recordToolUse,
  readToolUseWindow,
  readToolUsesSince,
  maxToolUseRev,
  settleDaemonCall,
  readToolUse,
  LIST_EXCERPT_BYTES,
  prepareCaptureText,
  contentDedupKey,
  excerptForPush,
  shapeToolUsesForPush,
  toolUseCursor,
  toolUseFromClaudeHook,
  normalizeHookPayload,
} from "../db/tool-uses.js";
import { verifyNarrativeBind, numericConfig, fitToolUses, TOOL_USES_MAX_BYTES } from "../daemon/server.js";

function seedNarrative(db: ReturnType<typeof createTestDb>, id = "claude-test0001"): string {
  db.prepare(
    "INSERT INTO narratives (id, brane_id, agent_type, role, status, fold_path, created_at) VALUES (?, 'brane-test', 'claude', 'worker', 'active', '/tmp', ?)",
  ).run(id, Date.now());
  return id;
}

describe("recordToolUse", () => {
  it("anchors after_seq to the narrative's current head seq", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    appendEvent(db, nid, "narration", { content: "one" });
    appendEvent(db, nid, "narration", { content: "two" });

    const row = recordToolUse(db, nid, { name: "Bash", status: "completed", source: "hook" });
    assert.equal(row.after_seq, 2);
    assert.equal(row.rev, 1);
    assert.equal(row.status, "completed");
  });

  it("allocates monotonic rev per narrative and bumps it on every write", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);

    const a = recordToolUse(db, nid, { name: "Read", status: "completed", source: "hook", dedupKey: "a" });
    const b = recordToolUse(db, nid, { name: "Edit", status: "completed", source: "hook", dedupKey: "b" });
    assert.equal(a.rev, 1);
    assert.equal(b.rev, 2);

    // Upsert of an existing row must bump rev — rev is the sync cursor, and a
    // mutation that kept its old rev would be invisible to a resuming client.
    const a2 = recordToolUse(db, nid, { name: "Read", status: "failed", source: "hook", dedupKey: "a" });
    assert.equal(a2.rev, 3);
    assert.equal(a2.status, "failed");
    assert.equal(maxToolUseRev(db, nid), 3);
  });

  it("preserves after_seq and started_at on upsert — a row's position never moves", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    appendEvent(db, nid, "narration", { content: "one" });

    const first = recordToolUse(db, nid, {
      name: "Bash", status: "completed", source: "hook", dedupKey: "x", startedAt: 1000,
    });
    appendEvent(db, nid, "narration", { content: "two" });
    const second = recordToolUse(db, nid, {
      name: "Bash", status: "failed", source: "session_log", dedupKey: "x", startedAt: 9999,
    });

    assert.equal(first.after_seq, 1);
    assert.equal(second.after_seq, 1, "after_seq must not move on upsert");
    assert.equal(second.started_at, 1000, "started_at must not move on upsert");
    assert.equal(second.status, "failed");
    assert.equal(second.source, "session_log");
  });

  it("collapses live-hook and backfill delivery of the same call to one row", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    recordToolUse(db, nid, { name: "Bash", status: "completed", source: "hook", dedupKey: "toolu_01" });
    recordToolUse(db, nid, { name: "Bash", status: "completed", source: "session_log", dedupKey: "toolu_01" });
    const rows = readToolUseWindow(db, nid);
    assert.equal(rows.length, 1);
  });

  it("falls back to a content dedup key when the vendor supplies no id", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const row = recordToolUse(db, nid, {
      name: "Bash", input: "ls", status: "completed", source: "hook", startedAt: 1234,
    });
    assert.equal(row.dedup_key, contentDedupKey(nid, 1234, "Bash", prepareCaptureText("ls")));
  });

  it("keeps narratives' rev spaces independent", () => {
    const db = createTestDb();
    const a = seedNarrative(db, "claude-narra");
    const b = seedNarrative(db, "claude-narrb");
    recordToolUse(db, a, { name: "Read", status: "completed", source: "hook" });
    const rowB = recordToolUse(db, b, { name: "Read", status: "completed", source: "hook" });
    assert.equal(rowB.rev, 1);
  });
});

describe("readToolUseWindow / readToolUsesSince", () => {
  it("filters by since_rev and orders by display key", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);

    appendEvent(db, nid, "narration", { content: "one" });
    const r1 = recordToolUse(db, nid, { name: "Read", status: "completed", source: "hook", dedupKey: "1", startedAt: 10 });
    const r2 = recordToolUse(db, nid, { name: "Edit", status: "completed", source: "hook", dedupKey: "2", startedAt: 20 });
    appendEvent(db, nid, "narration", { content: "two" });
    recordToolUse(db, nid, { name: "Bash", status: "completed", source: "hook", dedupKey: "3", startedAt: 30 });

    const all = readToolUseWindow(db, nid);
    assert.deepEqual(all.map((r) => r.dedup_key), ["1", "2", "3"]);
    assert.deepEqual(all.map((r) => r.after_seq), [1, 1, 2]);

    const since = readToolUsesSince(db, nid, { sinceRev: r2.rev });
    assert.deepEqual(since.map((r) => r.dedup_key), ["3"]);
    assert.ok(since.every((r) => r.rev > r2.rev));
    assert.equal(r1.rev, 1);
  });

  it("returns a mutated row again after its rev bump (catch-up sees updates)", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const first = recordToolUse(db, nid, { name: "Bash", status: "completed", source: "hook", dedupKey: "x" });
    recordToolUse(db, nid, { name: "Bash", status: "failed", source: "hook", dedupKey: "x" });
    const caughtUp = readToolUsesSince(db, nid, { sinceRev: first.rev });
    assert.equal(caughtUp.length, 1);
    assert.equal(caughtUp[0].status, "failed");
  });

  // Paging back must fetch only the newly exposed band. Without the upper
  // bound each page-back re-downloaded the suffix it already held, so transfer
  // grew quadratically in the number of pages (claude-8fkbabsx:9, finding 1).
  it("windows half-open [gte, lt) so paging back never re-fetches the suffix", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    for (let i = 1; i <= 4; i++) {
      appendEvent(db, nid, "narration", { content: `e${i}` });
      recordToolUse(db, nid, { name: "Bash", status: "completed", source: "hook", dedupKey: `t${i}` });
    }

    const page = readToolUseWindow(db, nid, { afterSeqGte: 3 });
    assert.deepEqual(page.map((r) => r.dedup_key), ["t3", "t4"]);

    const band = readToolUseWindow(db, nid, { afterSeqGte: 1, afterSeqLt: 3 });
    assert.deepEqual(band.map((r) => r.dedup_key), ["t1", "t2"], "upper bound is exclusive");

    // The two together are the whole history, each row exactly once.
    assert.deepEqual([...band, ...page].map((r) => r.dedup_key), ["t1", "t2", "t3", "t4"]);
  });

  it("pages past a limit with no gap and no repeat, even when rows share an anchor", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    appendEvent(db, nid, "narration", { content: "one" });
    // A burst: five rows, one anchor, identical started_at. after_seq alone
    // could not order or resume these — the cursor carries the full sort key.
    for (let i = 0; i < 5; i++) {
      recordToolUse(db, nid, {
        name: "Bash", status: "completed", source: "hook", dedupKey: `k${i}`, startedAt: 500,
      });
    }

    const seen: string[] = [];
    let cursor = undefined as ReturnType<typeof toolUseCursor> | undefined;
    for (let page = 0; page < 10; page++) {
      const rows: ReturnType<typeof readToolUseWindow> = readToolUseWindow(db, nid, {
        limit: 2,
        after: cursor ?? undefined,
      });
      seen.push(...rows.map((r) => r.dedup_key));
      if (rows.length < 2) break;
      cursor = toolUseCursor(rows);
    }
    assert.deepEqual(seen, ["k0", "k1", "k2", "k3", "k4"]);
  });

  it("caps the page at limit and hands back a cursor that resumes exactly there", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    appendEvent(db, nid, "narration", { content: "one" });
    for (let i = 0; i < 3; i++) {
      recordToolUse(db, nid, {
        name: "Read", status: "completed", source: "hook", dedupKey: `k${i}`, startedAt: 100 + i,
      });
    }
    const first = readToolUseWindow(db, nid, { limit: 2 });
    assert.equal(first.length, 2);
    const rest = readToolUseWindow(db, nid, { after: toolUseCursor(first)! });
    assert.deepEqual(rest.map((r) => r.dedup_key), ["k2"]);
    assert.equal(toolUseCursor([]), null);
  });

  // The reason the two reads are separate functions (claude-8fkbabsx:14). A
  // client's watermark is the highest rev it has applied, so a truncated
  // catch-up page must never contain a high rev while lower revs are left
  // behind — that hole would be skipped forever. Ordering by rev is what makes
  // "highest received" and "highest contiguous" the same number.
  it("truncates the catch-up read in rev order, so a partial page can't skip a rev", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    // Later revs deliberately anchored *earlier* in display order, which is
    // exactly the arrangement display-ordered truncation gets wrong: it would
    // return the newest rev and drop the ones before it.
    appendEvent(db, nid, "narration", { content: "one" });
    recordToolUse(db, nid, { name: "A", status: "completed", source: "hook", dedupKey: "late", startedAt: 1 });
    appendEvent(db, nid, "narration", { content: "two" });
    recordToolUse(db, nid, { name: "B", status: "completed", source: "hook", dedupKey: "mid", startedAt: 2 });
    recordToolUse(db, nid, { name: "C", status: "completed", source: "hook", dedupKey: "early", startedAt: 3 });
    // Mutate the oldest row so its rev jumps to the top of the rev space
    // while its display position stays first.
    recordToolUse(db, nid, { name: "A", status: "failed", source: "hook", dedupKey: "late" });

    const page = readToolUsesSince(db, nid, { sinceRev: 0, limit: 2 });
    assert.equal(page.length, 2);
    const revs = page.map((r) => r.rev);
    assert.deepEqual(revs, [...revs].sort((a, b) => a - b), "catch-up pages come back in rev order");

    // The watermark a client would keep, and the rows it would then be owed.
    const watermark = page[page.length - 1].rev;
    const next = readToolUsesSince(db, nid, { sinceRev: watermark });
    const everySeen = [...page, ...next].map((r) => r.dedup_key).sort();
    assert.deepEqual(everySeen, ["early", "late", "mid"], "no row falls in the gap");
  });
});

describe("toolUseFromClaudeHook", () => {
  it("maps the vendor payload onto a record call", () => {
    const opts = toolUseFromClaudeHook(
      {
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_response: "a\nb\n",
        tool_use_id: "toolu_01",
        duration_ms: 42,
        parent_tool_use_id: "toolu_parent",
      },
      { source: "hook", agentType: "claude" },
    );
    assert.deepEqual(opts, {
      dedupKey: "toolu_01",
      name: "Bash",
      input: { command: "ls" },
      status: "completed",
      output: "a\nb\n",
      durationMs: 42,
      error: undefined,
      source: "hook",
      agentType: "claude",
      parentId: "toolu_parent",
    });
  });

  // The same call, seen earlier. A PreToolUse payload describes something that
  // hasn't happened: no response, no duration, no outcome. Read through the
  // completion path — where "no error present" means success — it would report
  // every call as finished the instant it began.
  it("maps a PreToolUse payload to a pending row that opens at the call's start", () => {
    const opts = toolUseFromClaudeHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "toolu_01",
      },
      { source: "hook", agentType: "claude", now: 1_000 },
    );
    assert.equal(opts!.status, "pending");
    assert.equal(opts!.startedAt, 1_000);
    assert.equal(opts!.durationMs, undefined);
    assert.equal(opts!.output, undefined);
  });

  // The two hooks are independent HTTP calls and can land out of order. A late
  // `pending` must not strand a finished call as permanently running.
  it("keeps started_at from the pending row and never regresses a completion", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    recordToolUse(db, nid, {
      name: "Bash", status: "pending", source: "hook", dedupKey: "k", startedAt: 1_000,
    });
    const done = recordToolUse(db, nid, {
      name: "Bash", status: "completed", source: "hook", dedupKey: "k",
      startedAt: 9_999, durationMs: 40, output: "ok",
    });
    assert.equal(done.started_at, 1_000, "the call began when it was announced");
    assert.equal(done.duration_ms, 40);

    const late = recordToolUse(db, nid, {
      name: "Bash", status: "pending", source: "hook", dedupKey: "k", startedAt: 1_000,
    });
    assert.equal(late.status, "completed", "a late pending must not undo a completion");
    assert.equal(late.output, "ok");
  });

  it("reads failure from either an error field or is_error on the response", () => {
    const byError = toolUseFromClaudeHook(
      { tool_name: "Bash", error: "exit 1" },
      { source: "hook" },
    );
    assert.equal(byError?.status, "failed");
    assert.equal(byError?.error, "exit 1");

    const byResponse = toolUseFromClaudeHook(
      { tool_name: "Bash", tool_response: { is_error: true, content: "no matches found" } },
      { source: "hook" },
    );
    assert.equal(byResponse?.status, "failed");

    const ok = toolUseFromClaudeHook(
      { tool_name: "Bash", tool_response: { is_error: false, content: "ok" } },
      { source: "hook" },
    );
    assert.equal(ok?.status, "completed");
  });

  it("survives a payload with nothing but tool_name, and rejects one without it", () => {
    const bare = toolUseFromClaudeHook({ tool_name: "Read" }, { source: "hook" });
    assert.equal(bare?.name, "Read");
    assert.equal(bare?.dedupKey, undefined, "no vendor id — recordToolUse content-hashes instead");
    assert.equal(bare?.status, "completed");

    assert.equal(toolUseFromClaudeHook({}, { source: "hook" }), null);
    assert.equal(toolUseFromClaudeHook({ tool_name: "" }, { source: "hook" }), null);
  });

  // goose's PreToolUse and PostToolUse payloads are byte-identical apart from
  // the event name — {event, matcher_context, session_id, tool_input,
  // tool_name, working_dir}, captured live. No call id anywhere in either, so
  // there is nothing but the content to pair the two halves with.
  describe("pairing a vendor that sends no call id", () => {
    const goose = (event: string, command: string) =>
      normalizeHookPayload({
        event,
        session_id: "20260816_4",
        matcher_context: "developer__shell",
        tool_name: "developer__shell",
        tool_input: { command },
        working_dir: "/Users/ben/dev/goose",
      });

    function report(
      db: ReturnType<typeof createTestDb>,
      nid: string,
      event: string,
      command: string,
      now: number,
    ) {
      const opts = toolUseFromClaudeHook(goose(event, command), { source: "hook", now })!;
      // A completion carries no time of its own, so the daemon stamps its
      // arrival — exactly as the HTTP handler does.
      return recordToolUse(db, nid, opts.status === "pending" ? opts : { ...opts, startedAt: now });
    }

    it("closes the pending row instead of opening a second one", () => {
      const db = createTestDb();
      const nid = seedNarrative(db);

      report(db, nid, "PreToolUse", "sleep 3", 1_000);
      assert.equal(readToolUseWindow(db, nid).length, 1);
      const done = report(db, nid, "PostToolUse", "sleep 3", 4_000);

      const rows = readToolUseWindow(db, nid);
      assert.equal(rows.length, 1, "one call is one row");
      assert.equal(done.status, "completed");
      assert.equal(done.started_at, 1_000, "the call began when it was announced");
    });

    // The vendor timed nothing, but the daemon did: the two hooks bracket the
    // call, so the gap between their arrivals is the real duration.
    it("derives a duration from the two hooks' arrival times", () => {
      const db = createTestDb();
      const nid = seedNarrative(db);
      report(db, nid, "PreToolUse", "sleep 3", 1_000);
      assert.equal(report(db, nid, "PostToolUse", "sleep 3", 4_050).duration_ms, 3_050);
    });

    // The timestamp in contentDedupKey was what told two identical calls apart,
    // and dropping it must not merge them. It doesn't, because only a
    // completion claims, and claiming requires the row still be pending — so
    // the second completion cannot take the row the first one closed.
    it("keeps two identical concurrent calls as two rows, both closed", () => {
      const db = createTestDb();
      const nid = seedNarrative(db);

      report(db, nid, "PreToolUse", "date", 1_000);
      report(db, nid, "PreToolUse", "date", 1_001);
      assert.equal(readToolUseWindow(db, nid).length, 2, "two calls in");

      report(db, nid, "PostToolUse", "date", 2_000);
      report(db, nid, "PostToolUse", "date", 2_001);

      const rows = readToolUseWindow(db, nid);
      assert.equal(rows.length, 2, "two rows out — neither call swallowed the other");
      assert.ok(
        rows.every((r) => r.status === "completed"),
        "and neither is left running forever",
      );
    });

    // An agent killed mid-call leaves a pending row that will never close. The
    // next identical call must claim its *own* row, not be absorbed by the
    // corpse — otherwise the fresh row is orphaned and the stale one lies.
    it("claims the newest pending row, so a stale one can't absorb a fresh call", () => {
      const db = createTestDb();
      const nid = seedNarrative(db);

      const stale = report(db, nid, "PreToolUse", "date", 1_000);
      const fresh = report(db, nid, "PreToolUse", "date", 500_000);
      report(db, nid, "PostToolUse", "date", 500_100);

      const byKey = new Map(readToolUseWindow(db, nid).map((r) => [r.dedup_key, r]));
      assert.equal(byKey.get(fresh.dedup_key)!.status, "completed");
      assert.equal(byKey.get(stale.dedup_key)!.status, "pending", "the corpse is left as it is");
    });

    it("does not reach past the pairing window", () => {
      const db = createTestDb();
      const nid = seedNarrative(db);
      report(db, nid, "PreToolUse", "date", 1_000);
      // Later than any call brane asks a client to allow. Degrades to the old
      // two-row behaviour rather than to a wrong pairing.
      report(db, nid, "PostToolUse", "date", 1_000 + 66 * 60 * 1000);
      assert.equal(readToolUseWindow(db, nid).length, 2);
    });

    // `leanLoopCapture` rewrites a narrate's input once the result proves the
    // text reached the log — but only on the half that carries the seq. If the
    // twin lookup matched the *stored* value, a completion would go looking for
    // the shrunk form while its own pending row still held the whole payload,
    // find nothing, and open a second row: this pairing's own defect
    // reappearing on the tool whose rows the operator reads most.
    it("matches on the call as it came, not on the leaner thing stored", () => {
      const db = createTestDb();
      const nid = seedNarrative(db);
      const say = { say: "hello", meta: { summary: "working" } };

      recordToolUse(db, nid, {
        name: "mcp__brane__narrate", input: say, status: "pending", source: "hook", startedAt: 1_000,
      });
      recordToolUse(db, nid, {
        name: "mcp__brane__narrate", input: say, status: "completed", source: "hook", startedAt: 1_200,
        // A result with a seq is what triggers the rewrite.
        output: { nid, seq: 7 },
      });

      const rows = readToolUseWindow(db, nid);
      assert.equal(rows.length, 1, "the narrate is one row, not two");
      assert.equal(rows[0].status, "completed");
      assert.equal(rows[0].duration_ms, 200);
    });

    // Everything above must stay confined to vendors that send no id: an agent
    // whose payload carries tool_use_id is matched on it and nothing else.
    it("never claims when the vendor supplied an id", () => {
      const db = createTestDb();
      const nid = seedNarrative(db);
      recordToolUse(db, nid, {
        name: "Bash", input: { command: "date" }, status: "pending", source: "hook",
        dedupKey: "toolu_01", startedAt: 1_000,
      });
      recordToolUse(db, nid, {
        name: "Bash", input: { command: "date" }, status: "completed", source: "hook",
        dedupKey: "toolu_02", startedAt: 2_000,
      });
      const rows = readToolUseWindow(db, nid);
      assert.equal(rows.length, 2, "two ids are two calls, whatever they look like");
      assert.equal(rows[0].status, "pending");
    });
  });

  it("reads failure from the out-of-band flag the other harnesses send", () => {
    const flagged = toolUseFromClaudeHook(
      { tool_name: "shell", failed: true, tool_response: "partial output" },
      { source: "hook" },
    );
    assert.equal(flagged?.status, "failed");
    assert.equal(flagged?.error, undefined, "no message was sent, so none is invented");
    assert.equal(flagged?.output, "partial output", "the output it did produce is still kept");
  });
});

// Payload samples below are the shapes each harness reported first-hand from
// its own running session (goose: claude-pasen1co:20, crush: :24, cline: :28).
describe("normalizeHookPayload", () => {
  it("leaves a payload that already speaks the contract untouched", () => {
    const claude = {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: "a\nb\n",
      tool_use_id: "toolu_01",
      duration_ms: 42,
      parent_tool_use_id: "toolu_parent",
    };
    assert.deepEqual(normalizeHookPayload(claude), claude);
  });

  // The bug this whole function exists for: goose and crush both announce a
  // call as `event`, which the mapper doesn't recognize — so without this the
  // pre-hook takes the completion path and the call is recorded as finished
  // before it has run.
  it("recognizes `event` as the pre-hook, so a starting call stays pending", () => {
    const goosePre = normalizeHookPayload({
      event: "PreToolUse",
      session_id: "20260816_2",
      tool_name: "developer__shell",
      tool_input: { command: "sleep 25" },
      working_dir: "/Users/ben/dev/goose",
    });
    assert.equal(goosePre.hook_event_name, "PreToolUse");
    assert.equal(goosePre.tool_name, "developer__shell");

    const opts = toolUseFromClaudeHook(goosePre, { source: "hook", now: 1_000 });
    assert.equal(opts?.status, "pending");
    assert.equal(opts?.startedAt, 1_000);
  });

  it("accepts the case and separator variants goose and crush accept", () => {
    for (const event of ["PreToolUse", "pretooluse", "pre_tool_use", "PRE-TOOL-USE"]) {
      assert.equal(normalizeHookPayload({ event, tool_name: "x" }).hook_event_name, "PreToolUse");
    }
  });

  it("maps goose's post payload, including its separate failure event", () => {
    const post = normalizeHookPayload({
      event: "PostToolUse",
      session_id: "20260816_2",
      tool_name: "developer__text_editor",
      tool_input: { path: "/tmp/x" },
      tool_output: { content: ["ok"] },
    });
    assert.equal(post.hook_event_name, "PostToolUse");
    assert.deepEqual(post.tool_response, { content: ["ok"] }, "tool_output is the response");
    assert.equal(post.failed, undefined);
    assert.equal(toolUseFromClaudeHook(post, { source: "hook" })?.status, "completed");

    const failure = normalizeHookPayload({
      event: "PostToolUseFailure",
      tool_name: "developer__shell",
      tool_input: { command: "false" },
    });
    assert.equal(failure.failed, true);
    assert.equal(failure.error, undefined, "goose sends no message with the event");
    assert.equal(toolUseFromClaudeHook(failure, { source: "hook" })?.status, "failed");
  });

  it("maps cline's nested call and outcome, and its success flag", () => {
    const pre = normalizeHookPayload({
      hookName: "tool_call",
      clineVersion: "3.0.55",
      taskId: "1786899559349_f9dpo",
      iteration: 3,
      tool_call: { id: "brane__narrate_0", name: "brane__narrate", input: { say: "hi" } },
      preToolUse: { toolName: "brane__narrate", parameters: { say: "hi" } },
    });
    // cline names its hooks after the thing rather than the phase, so its
    // pre-hook arrives as `tool_call`. Read literally that is not "PreToolUse"
    // and the call would be recorded as finished before it ran.
    assert.equal(pre.hook_event_name, "PreToolUse");
    assert.equal(toolUseFromClaudeHook(pre, { source: "hook" })?.status, "pending");
    assert.equal(pre.tool_name, "brane__narrate");
    assert.equal(pre.tool_use_id, "brane__narrate_0");
    assert.deepEqual(pre.tool_input, { say: "hi" });

    const post = normalizeHookPayload({
      hookName: "tool_result",
      tool_result: { id: "brane__narrate_0", name: "brane__narrate", input: { say: "hi" }, output: "seq 7" },
      postToolUse: {
        toolName: "brane__narrate",
        parameters: { say: "hi" },
        result: "seq 7",
        success: true,
        executionTimeMs: 210,
      },
    });
    assert.equal(post.tool_use_id, "brane__narrate_0", "same id — pre and post collapse to one row");
    assert.equal(post.tool_response, "seq 7");
    assert.equal(post.duration_ms, 210);
    assert.equal(post.failed, undefined);

    const failed = normalizeHookPayload({
      hookName: "tool_result",
      tool_result: { id: "run_commands_2", name: "run_commands", output: "" },
      postToolUse: { toolName: "run_commands", result: "", success: false, executionTimeMs: 12 },
    });
    assert.equal(failed.failed, true);
    assert.equal(toolUseFromClaudeHook(failed, { source: "hook" })?.status, "failed");
  });

  it("maps crush's pre payload, whose tool_input is already Claude-shaped", () => {
    const crush = normalizeHookPayload({
      event: "PreToolUse",
      session_id: "e662a552-ce21-4384-abb6-4e2c72bb58bc",
      cwd: "/Users/ben/dev/crush",
      tool_name: "bash",
      tool_input: { command: "ls" },
    });
    assert.equal(crush.hook_event_name, "PreToolUse");
    assert.deepEqual(crush.tool_input, { command: "ls" });
    // Crush's pre payload carries no call id, and crush has no post event at
    // all — which is why its completions come from the session-log tail rather
    // than from a second hook. Nothing here can invent the id.
    assert.equal(crush.tool_use_id, undefined);
  });

  it("ignores junk without inventing fields", () => {
    assert.deepEqual(normalizeHookPayload({}), {});
    assert.deepEqual(normalizeHookPayload(null), {});
    assert.deepEqual(normalizeHookPayload("nonsense"), {});
    // Wrong types are dropped rather than passed through to be stored.
    const wrong = normalizeHookPayload({ tool_name: 7, duration_ms: "fast", tool_use_id: 3 });
    assert.deepEqual(wrong, {});
  });

  it("does not read cline's parent_agent_id as a parent tool call", () => {
    const nested = normalizeHookPayload({
      hookName: "tool_call",
      tool_call: { id: "x_1", name: "x", input: {} },
      agent_id: "agent-2",
      parent_agent_id: "agent-1",
    });
    assert.equal(nested.parent_tool_use_id, undefined, "a sub-agent is not a parent tool call");
  });
});

// The hook endpoint sits *before* the bearer-token check, so this is the only
// thing standing between an unauthenticated POST and a narrative's rows.
describe("verifyNarrativeBind", () => {
  function seedWithToken(db: ReturnType<typeof createTestDb>, id: string, token: string | null) {
    db.prepare(
      "INSERT INTO narratives (id, brane_id, agent_type, role, status, fold_path, created_at, bind_token) VALUES (?, 'brane-test', 'claude', 'worker', 'active', '/tmp', ?, ?)",
    ).run(id, Date.now(), token);
    adoptBindTokens(db);
  }

  it("accepts the matching secret and reports the narrative's agent type", () => {
    const db = createTestDb();
    seedWithToken(db, "claude-bind0001", "s3cret");
    assert.deepEqual(verifyNarrativeBind(db, "claude-bind0001", "s3cret"), {
      nid: "claude-bind0001",
      agentType: "claude",
    });
  });

  it("refuses a wrong secret, an unknown narrative, and a null bind_token alike", () => {
    const db = createTestDb();
    seedWithToken(db, "claude-bind0001", "s3cret");
    seedWithToken(db, "claude-legacy01", null);

    assert.equal(verifyNarrativeBind(db, "claude-bind0001", "wrong"), null);
    assert.equal(verifyNarrativeBind(db, "claude-bind0001", ""), null);
    assert.equal(verifyNarrativeBind(db, "claude-nosuch01", "s3cret"), null);
    // No grace path here, unlike resolveMcpBind: a hook has no session to
    // save, so a pre-bind-token narrative is refused rather than trusted.
    assert.equal(verifyNarrativeBind(db, "claude-legacy01", ""), null);
    assert.equal(verifyNarrativeBind(db, "claude-legacy01", "anything"), null);
  });
});

describe("numericConfig", () => {
  it("falls back on absent or non-numeric values instead of yielding NaN", () => {
    assert.equal(numericConfig("250", 999), 250);
    assert.equal(numericConfig(undefined, 999), 999);
    assert.equal(numericConfig(null, 999), 999);
    assert.equal(numericConfig("", 999), 999);
    // The case that used to disable coalescing in silence: NaN fails every
    // comparison, so the buffer never flushed on size and the timer fired
    // next tick (claude-8fkbabsx:9, finding 6).
    assert.equal(numericConfig("twenty", 20), 20);
    assert.equal(numericConfig("abc", 250), 250);
    assert.equal(numericConfig("0", 250), 0, "an explicit 0 is a real setting, not a fallback");
  });
});

describe("prepareCaptureText", () => {
  it("passes text through unchanged and JSON-stringifies structures", () => {
    assert.equal(prepareCaptureText("npm test"), "npm test");
    assert.equal(prepareCaptureText({ cmd: "ls" }), '{"cmd":"ls"}');
    assert.equal(prepareCaptureText(undefined), null);
    assert.equal(prepareCaptureText(null), null);
  });

  it("stores verbatim — no redaction, no cap (operator ruling, claude-xlolbv6l:94)", () => {
    const sensitive = "Authorization: Bearer abcdefghijklmnop1234 AKIAIOSFODNN7EXAMPLE";
    assert.equal(prepareCaptureText(sensitive), sensitive);
    const big = "x".repeat(100_000);
    assert.equal(prepareCaptureText(big), big);
  });
});

describe("excerptForPush", () => {
  it("returns the row untouched when input/output fit the push cap", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const row = recordToolUse(db, nid, {
      name: "Bash", input: "ls", output: "ok", status: "completed", source: "hook",
    });
    assert.equal(excerptForPush(row), row);
  });

  it("excerpts oversized fields for the wire while the stored row keeps the full value", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const big = "x".repeat(100_000);
    const row = recordToolUse(db, nid, {
      name: "Read", input: "file.txt", output: big, status: "completed", source: "hook",
    });
    assert.equal(row.output, big, "stored row is verbatim");

    const pushed = excerptForPush(row);
    assert.ok(Buffer.byteLength(pushed.output!, "utf-8") <= 16_384);
    assert.equal(pushed.output_truncated, true);
    assert.equal(pushed.input, "file.txt");
    assert.equal(pushed.input_truncated, undefined);

    const stored = readToolUseWindow(db, nid)[0];
    assert.equal(stored.output, big, "push excerpting never touches the database");
  });

  // The old excerpt sliced the *string* by character count, which can land
  // between the two halves of a surrogate pair and ship a lone surrogate that
  // renders as U+FFFD (claude-8fkbabsx:9, finding 7). Emoji are 2 UTF-16 code
  // units and 4 UTF-8 bytes, so a cap that isn't a multiple of 4 lands
  // mid-character on every pass.
  it("cuts multi-byte text on a character boundary, never mid-surrogate", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const emoji = "🙂".repeat(20_000);
    const row = recordToolUse(db, nid, {
      name: "Read", output: emoji, status: "completed", source: "hook",
    });

    const pushed = excerptForPush(row);
    const excerpt = pushed.output!;
    assert.ok(Buffer.byteLength(excerpt, "utf-8") <= 16_384);
    assert.equal(pushed.output_truncated, true);
    assert.ok(excerpt.length > 0, "the cap is large enough for many characters");
    // A lone surrogate is not a valid code point: round-tripping through UTF-8
    // would replace it with U+FFFD. Equality proves every character survived
    // whole.
    assert.equal(
      Buffer.from(excerpt, "utf-8").toString("utf-8"),
      excerpt,
      "excerpt must contain no unpaired surrogate",
    );
    // A prefix cut can only ever strand a *high* surrogate at the end.
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(excerpt), "no unpaired high surrogate");
    assert.ok(emoji.startsWith(excerpt), "excerpt is a true prefix of the original");
  });

  // The cap that broke the wire was `map`'s index. Nothing asks to excerpt a
  // payload to single digits, so a cap under the floor is a caller's slip and
  // is read as "no cap given" (claude-bk6vwpc8:9).
  it("ignores a nonsensical cap rather than blanking the field", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const row = recordToolUse(db, nid, {
      name: "Bash", input: '{"command":"ls"}', output: "ok", status: "completed", source: "hook",
    });

    for (const cap of [0, 1, 2, 63, Number.NaN, -1]) {
      const pushed = excerptForPush(row, cap);
      assert.equal(pushed.input, '{"command":"ls"}', `cap ${cap} must not empty the input`);
      assert.equal(pushed.input_truncated, undefined, `cap ${cap} must not claim truncation`);
    }
  });

  it("still honours a cap that a caller could plausibly mean", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const row = recordToolUse(db, nid, {
      name: "Read", output: "y".repeat(500), status: "completed", source: "hook",
    });

    const pushed = excerptForPush(row, 64);
    assert.equal(Buffer.byteLength(pushed.output!, "utf-8"), 64);
    assert.equal(pushed.output_truncated, true);
  });
});

/** The defect was in the *call*, not the callee: `.map(excerptForPush)` fed
 *  each row its own index as a byte cap. Every unit test above passed while the
 *  wire went out empty, so this exercises the shaping the flush path actually
 *  performs — the smallest thing that would have failed
 *  (claude-bk6vwpc8:9). */
describe("shapeToolUsesForPush", () => {
  it("keeps every row's input, whatever its position in the flush", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const rows = ["ls", "pwd", "whoami", "date", "uname"].map((cmd, i) =>
      recordToolUse(db, nid, {
        name: "Bash",
        input: { command: cmd },
        output: "ok",
        status: "completed",
        source: "hook",
        dedupKey: `toolu_${i}`,
        startedAt: 1_000 + i,
      }),
    );

    const shaped = shapeToolUsesForPush(rows);
    assert.equal(shaped.length, 5);
    shaped.forEach((row, i) => {
      // The first row is the one the old bug emptied outright: index 0 as a
      // cap excerpts to zero bytes.
      assert.ok(row.input, `row ${i} must reach the wire with its input`);
      assert.equal(JSON.parse(row.input!).command, ["ls", "pwd", "whoami", "date", "uname"][i]);
      assert.equal(row.input_truncated, undefined, `row ${i} must not be flagged truncated`);
    });
  });

  it("sorts by display key, so a client can insert-merge in one pass", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const late = recordToolUse(db, nid, {
      name: "Bash", input: "b", status: "completed", source: "hook",
      dedupKey: "toolu_late", startedAt: 2_000,
    });
    const early = recordToolUse(db, nid, {
      name: "Bash", input: "a", status: "completed", source: "hook",
      dedupKey: "toolu_early", startedAt: 1_000,
    });

    const shaped = shapeToolUsesForPush([late, early]);
    assert.deepEqual(
      shaped.map((r) => r.dedup_key),
      ["toolu_early", "toolu_late"],
    );
  });

  it("does not reorder the caller's array in place", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const late = recordToolUse(db, nid, {
      name: "Bash", input: "b", status: "completed", source: "hook",
      dedupKey: "toolu_late", startedAt: 2_000,
    });
    const early = recordToolUse(db, nid, {
      name: "Bash", input: "a", status: "completed", source: "hook",
      dedupKey: "toolu_early", startedAt: 1_000,
    });

    const given = [late, early];
    shapeToolUsesForPush(given);
    assert.deepEqual(given.map((r) => r.dedup_key), ["toolu_late", "toolu_early"]);
  });
});

describe("leanLoopCapture", () => {
  const NARRATE = "mcp__brane__narrate";
  const LISTEN = "mcp__brane__listen";

  it("drops the events a listen delivered, and keeps its cursors", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const row = recordToolUse(db, nid, {
      name: LISTEN,
      status: "completed",
      source: "hook",
      input: { after: { self: 29, "claude-peer0001": 15 }, tail: 50 },
      output: { events: { self: [{ seq: 30, content: "a whole narration" }] }, waited_ms: 12 },
      dedupKey: "toolu_listen",
    });
    // The events are the log itself, stored twice. The cursors stay: they
    // implicitly encode one session's chunking, which the operator weighed and
    // accepted, and they are the only record of who was being watched.
    assert.equal(row.output, null);
    assert.deepEqual(JSON.parse(row.input!), {
      after: { self: 29, "claude-peer0001": 15 },
      tail: 50,
    });
  });

  it("keeps a narration's text until the result proves it reached the log", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    // PreToolUse: no result yet, so no proof — the words stay.
    const pre = recordToolUse(db, nid, {
      name: NARRATE, status: "pending", source: "hook",
      input: { say: "a long narration", meta: { summary: "working" } },
      dedupKey: "toolu_self",
    });
    assert.ok(pre.input!.includes("a long narration"));

    // PostToolUse: a seq means the narration is in `events`, and this copy is
    // redundant rather than unique.
    const post = recordToolUse(db, nid, {
      name: NARRATE, status: "completed", source: "hook",
      input: { say: "a long narration", meta: { summary: "working" } },
      output: { nid, seq: 12, events: { self: [] } },
      dedupKey: "toolu_self",
    });
    assert.deepEqual(JSON.parse(post.input!), {});
    assert.deepEqual(JSON.parse(post.output!), {});
  });

  it("never drops the words of a narrate that failed", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const row = recordToolUse(db, nid, {
      name: NARRATE, status: "failed", source: "hook",
      input: { nid: "claude-other001", say: "never landed" },
      error: "no such narrative",
      dedupKey: "toolu_failed_foreign",
    });
    // No seq, no proof, no event anywhere — this row is the only copy there is.
    assert.ok(row.input!.includes("never landed"));
  });

  it("keeps the pointer a foreign narrate creates, and only that", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const row = recordToolUse(db, nid, {
      name: NARRATE,
      status: "completed",
      source: "hook",
      input: { nid: "claude-other001", say: "a message that lives over there" },
      output: { nid: "claude-other001", seq: 7, events: { self: [] } },
      dedupKey: "toolu_foreign",
    });
    // The text belongs to the narrative that received it; the reference is the
    // only part of an outgoing message this side should carry.
    assert.deepEqual(JSON.parse(row.input!), { nid: "claude-other001" });
    assert.deepEqual(JSON.parse(row.output!), { nid: "claude-other001", seq: 7 });
  });

  it("reads the seq through the MCP result envelope some vendors wrap", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const row = recordToolUse(db, nid, {
      name: NARRATE, status: "completed", source: "hook",
      input: { nid: "claude-other001", say: "hello" },
      output: { content: [{ type: "text", text: JSON.stringify({ nid: "claude-other001", seq: 41 }) }] },
      dedupKey: "toolu_wrapped",
    });
    assert.deepEqual(JSON.parse(row.output!), { nid: "claude-other001", seq: 41 });
  });

  it("lets a Post payload without tool_input keep what Pre recorded", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    recordToolUse(db, nid, {
      name: "Bash", status: "pending", source: "hook",
      input: { command: "ls -la" }, dedupKey: "toolu_coalesce",
    });
    const post = recordToolUse(db, nid, {
      name: "Bash", status: "completed", source: "hook",
      output: "total 0\n", dedupKey: "toolu_coalesce",
    });
    assert.deepEqual(JSON.parse(post.input!), { command: "ls -la" });
  });

  it("leaves every other tool verbatim", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const row = recordToolUse(db, nid, {
      name: "Bash", status: "completed", source: "hook",
      input: { command: "ls -la" }, output: "total 0\n",
      dedupKey: "toolu_bash",
    });
    assert.deepEqual(JSON.parse(row.input!), { command: "ls -la" });
    assert.equal(row.output, "total 0\n");
  });

  it("tells two self-narrations apart even though neither keeps its text", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    // Identity comes from the call, not from what survives capture — same
    // start, same name, both compacted to `{}`, and still two rows.
    const startedAt = Date.now();
    const a = recordToolUse(db, nid, {
      name: NARRATE, status: "completed", source: "session_log", startedAt,
      input: { say: "first" }, output: { nid, seq: 1 },
    });
    const b = recordToolUse(db, nid, {
      name: NARRATE, status: "completed", source: "session_log", startedAt,
      input: { say: "second" }, output: { nid, seq: 2 },
    });
    assert.equal(a.input, "{}");
    assert.equal(b.input, "{}");
    assert.notEqual(a.dedup_key, b.dedup_key);
    assert.equal(readToolUseWindow(db, nid, {}).length, 2);
  });
});

describe("wire size", () => {
  it("excerpts a list row to 1KB, not to the old 16KB push cap", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const row = recordToolUse(db, nid, {
      name: "Read", output: "x".repeat(200_000), status: "completed", source: "hook",
    });
    const listed = excerptForPush(row);
    assert.ok(Buffer.byteLength(listed.output!, "utf-8") <= LIST_EXCERPT_BYTES);
    assert.equal(listed.output_truncated, true);
    // The stored row is untouched — the excerpt is a wire concern, and the
    // single-row read is what serves the rest.
    assert.equal(readToolUse(db, nid, row.dedup_key)!.output!.length, 200_000);
  });

  it("keeps a foreign narrate's pointer whole, since it fits the cap easily", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const row = recordToolUse(db, nid, {
      name: "mcp__brane__narrate", status: "completed", source: "hook",
      input: { nid: "claude-other001", say: "a".repeat(50_000) },
      output: { nid: "claude-other001", seq: 7 },
    });
    const listed = excerptForPush(row);
    assert.deepEqual(JSON.parse(listed.output!), { nid: "claude-other001", seq: 7 });
    assert.equal(listed.output_truncated, undefined);
  });

  it("holds a byte budget the row count cannot express", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    // Excerpting to 1KB means the 500-row limit already implies ~500KB, so the
    // budget is a backstop rather than the working mechanism. Reach past the
    // row limit to prove the backstop is real: 700 heavy rows, asked for whole.
    const rows = Array.from({ length: 700 }, (_, i) =>
      recordToolUse(db, nid, {
        name: "Read", status: "completed", source: "hook",
        output: "y".repeat(100_000), dedupKey: `toolu_${i}`,
      }));

    const fitted = fitToolUses(rows, 700);
    assert.ok(fitted.truncated, "a page this heavy must not go out whole");
    assert.ok(fitted.rows.length < rows.length);
    const bytes = fitted.rows.reduce(
      (n, r) => n + (r.input?.length ?? 0) + (r.output?.length ?? 0),
      0,
    );
    assert.ok(bytes <= TOOL_USES_MAX_BYTES, `page was ${bytes} bytes`);
  });

  it("fits a real narrative's worth of rows into a page a phone can pull", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    // The shape that started this: 265 rows carrying multi-KB payloads was a
    // 3.65MB response, and on a ~60KB/s link that request never finished
    // (claude-n1izig04:74).
    const rows = Array.from({ length: 265 }, (_, i) =>
      recordToolUse(db, nid, {
        name: "Read", status: "completed", source: "hook",
        output: "y".repeat(13_000), dedupKey: `toolu_${i}`,
      }));
    const verbatim = rows.reduce((n, r) => n + (r.output?.length ?? 0), 0);
    const fitted = fitToolUses(rows, 500);
    const shipped = fitted.rows.reduce((n, r) => n + (r.output?.length ?? 0), 0);

    assert.equal(fitted.rows.length, 265, "every row still ships — just lighter");
    assert.ok(verbatim > 3_000_000, `sanity: ${verbatim} bytes stored`);
    assert.ok(shipped < 300_000, `page was ${shipped} bytes`);
  });

  it("always yields one row, even when that row alone exceeds the budget", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    // A page that returned zero rows with truncated: true would hand the client
    // a cursor pointing at the row it just refused, and it would page forever.
    const heavy = recordToolUse(db, nid, {
      name: "Read", status: "completed", source: "hook",
      output: "z".repeat(5_000_000), dedupKey: "toolu_heavy",
    });
    const fitted = fitToolUses([heavy], 500);
    assert.equal(fitted.rows.length, 1);
    assert.equal(fitted.truncated, false);
  });

  it("reads one row whole by dedup_key, and misses with null", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    recordToolUse(db, nid, {
      name: "Bash", status: "completed", source: "hook",
      input: { command: "ls" }, output: "q".repeat(80_000), dedupKey: "toolu_one",
    });
    assert.equal(readToolUse(db, nid, "toolu_one")!.output!.length, 80_000);
    assert.equal(readToolUse(db, nid, "toolu_absent"), null);
  });
});

describe("settleDaemonCall", () => {
  const LISTEN = "mcp__brane__listen";

  it("replaces the harness's background-cutoff stamp with the real duration", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const startedAt = Date.now() - 600_000;
    // What the hooks leave behind for a listen that outlived two minutes:
    // PreToolUse opened it, PostToolUse closed it at Claude Code's 120s
    // background cutoff while it was still blocking.
    recordToolUse(db, nid, {
      name: LISTEN, status: "completed", source: "hook",
      startedAt, durationMs: 120_004, dedupKey: "toolu_long",
    });

    const settled = settleDaemonCall(db, nid, LISTEN, startedAt, startedAt + 600_000);
    assert.equal(settled?.duration_ms, 600_000);
    assert.equal(settled?.status, "completed");
    assert.equal(settled?.dedup_key, "toolu_long");
  });

  it("bumps rev, so a resuming client sees the correction", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const startedAt = Date.now() - 300_000;
    const before = recordToolUse(db, nid, {
      name: LISTEN, status: "pending", source: "hook", startedAt, dedupKey: "toolu_pending",
    });

    const settled = settleDaemonCall(db, nid, LISTEN, startedAt, startedAt + 300_000);
    assert.ok(settled);
    assert.ok(settled.rev > before.rev, "a settle that kept its rev would be invisible");
    assert.equal(settled.status, "completed", "a call the daemon answered did not stay pending");
    assert.equal(maxToolUseRev(db, nid), settled.rev);
  });

  it("only extends: a shorter answer is not this call's ending", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const startedAt = Date.now() - 60_000;
    recordToolUse(db, nid, {
      name: LISTEN, status: "completed", source: "hook",
      startedAt, durationMs: 60_000, dedupKey: "toolu_done",
    });

    assert.equal(settleDaemonCall(db, nid, LISTEN, startedAt, startedAt + 5_000), null);
    const row = readToolUseWindow(db, nid, {}).find((r) => r.dedup_key === "toolu_done");
    assert.equal(row?.duration_ms, 60_000, "a stray settle must not rewrite a finished call");
  });

  it("keeps a failure's verdict while fixing its clock", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const startedAt = Date.now() - 200_000;
    recordToolUse(db, nid, {
      name: LISTEN, status: "failed", source: "hook",
      startedAt, durationMs: 120_004, error: "bridge closed", dedupKey: "toolu_failed",
    });

    const settled = settleDaemonCall(db, nid, LISTEN, startedAt, startedAt + 200_000);
    assert.equal(settled?.status, "failed", "settling is not evidence against a recorded failure");
    assert.equal(settled?.duration_ms, 200_000);
  });

  it("ignores rows outside the call's own window, and misses quietly", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const now = Date.now();
    // An older listen, long finished — a settle for a call that started a
    // minute later must not reach back and rewrite it.
    recordToolUse(db, nid, {
      name: LISTEN, status: "completed", source: "hook",
      startedAt: now - 3_600_000, durationMs: 1_000, dedupKey: "toolu_ancient",
    });

    assert.equal(settleDaemonCall(db, nid, LISTEN, now, now + 1_000), null);
    // No row at all is the ordinary case for a listen that resolved before its
    // PreToolUse hook landed; it must not throw.
    assert.equal(settleDaemonCall(db, "claude-nosuch", LISTEN, now, now + 1), null);
  });

  it("settles the listen, not a neighbouring call of another name", () => {
    const db = createTestDb();
    const nid = seedNarrative(db);
    const startedAt = Date.now() - 120_000;
    recordToolUse(db, nid, {
      name: "Bash", status: "pending", source: "hook", startedAt, dedupKey: "toolu_bash",
    });

    assert.equal(settleDaemonCall(db, nid, LISTEN, startedAt, startedAt + 120_000), null);
    const bash = readToolUseWindow(db, nid, {}).find((r) => r.dedup_key === "toolu_bash");
    assert.equal(bash?.status, "pending", "an unrelated tool keeps whatever its own hooks said");
  });
});
