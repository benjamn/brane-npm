import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "./helpers.js";
import { recordSessionId, getSessionIds, sumCostReadings, backfillCostLedger, ledgerTotal } from "../daemon/server.js";
import { getAgentAdapter } from "../agents.js";
import type { CostReading } from "../agents.js";
import { priceMessage } from "../cost/pricing.js";
import type { MessageUsage } from "../cost/pricing.js";

function seed(
  db: ReturnType<typeof createTestDb>,
  id: string,
  opts: { agent_session_id?: string | null; session_ids?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO narratives (id, brane_id, agent_type, role, created_at, status, agent_session_id, session_ids)
     VALUES (?, 'brane-test', 'claude', 'worker', 0, 'active', ?, ?)`,
  ).run(id, opts.agent_session_id ?? null, opts.session_ids ?? null);
}
function storedIds(db: ReturnType<typeof createTestDb>, id: string): string | null {
  return (db.prepare("SELECT session_ids FROM narratives WHERE id = ?").get(id) as { session_ids: string | null }).session_ids;
}

describe("recordSessionId", () => {
  it("appends the first session as a JSON array", () => {
    const db = createTestDb();
    seed(db, "claude-a");
    recordSessionId(db, "claude-a", "sess-1");
    assert.deepEqual(JSON.parse(storedIds(db, "claude-a")!), ["sess-1"]);
  });

  it("accumulates distinct sessions in order, deduping repeats", () => {
    const db = createTestDb();
    seed(db, "claude-a", { session_ids: '["sess-1"]' });
    recordSessionId(db, "claude-a", "sess-2");
    recordSessionId(db, "claude-a", "sess-1"); // dup — ignored
    recordSessionId(db, "claude-a", "sess-3");
    assert.deepEqual(JSON.parse(storedIds(db, "claude-a")!), ["sess-1", "sess-2", "sess-3"]);
  });

  it("is a no-op for an empty session id or unknown narrative", () => {
    const db = createTestDb();
    seed(db, "claude-a", { session_ids: '["sess-1"]' });
    recordSessionId(db, "claude-a", undefined);
    recordSessionId(db, "claude-a", "");
    recordSessionId(db, "claude-missing", "sess-x"); // no row → no throw
    assert.deepEqual(JSON.parse(storedIds(db, "claude-a")!), ["sess-1"]);
  });

  it("recovers from a malformed session_ids value by starting fresh", () => {
    const db = createTestDb();
    seed(db, "claude-a", { session_ids: "{not json" });
    recordSessionId(db, "claude-a", "sess-1");
    assert.deepEqual(JSON.parse(storedIds(db, "claude-a")!), ["sess-1"]);
  });
});

describe("session_ids migration backfill", () => {
  // Pins the exact backfill SQL from openDatabase(): seed the set from the
  // current session for rows that predate the column, and never clobber a set
  // that's already populated.
  const BACKFILL = `UPDATE narratives SET session_ids = '["' || agent_session_id || '"]'
       WHERE session_ids IS NULL AND agent_session_id IS NOT NULL`;

  it("seeds session_ids from agent_session_id for a pre-column row", () => {
    const db = createTestDb();
    seed(db, "claude-a", { agent_session_id: "550e8400-e29b-41d4-a716-446655440000", session_ids: null });
    db.exec(BACKFILL);
    assert.deepEqual(JSON.parse(storedIds(db, "claude-a")!), ["550e8400-e29b-41d4-a716-446655440000"]);
  });

  it("leaves an already-populated set untouched and skips session-less rows", () => {
    const db = createTestDb();
    seed(db, "claude-has-set", { agent_session_id: "sess-cur", session_ids: '["sess-old","sess-cur"]' });
    seed(db, "claude-no-session"); // both null
    db.exec(BACKFILL);
    assert.deepEqual(JSON.parse(storedIds(db, "claude-has-set")!), ["sess-old", "sess-cur"]);
    assert.equal(storedIds(db, "claude-no-session"), null);
  });
});

describe("getSessionIds", () => {
  it("returns the stored set unioned with the current agent_session_id", () => {
    const db = createTestDb();
    seed(db, "claude-a", { agent_session_id: "sess-2", session_ids: '["sess-1","sess-2"]' });
    assert.deepEqual(getSessionIds(db, "claude-a"), ["sess-1", "sess-2"]);
  });

  it("appends the current session when the set somehow missed it", () => {
    const db = createTestDb();
    seed(db, "claude-a", { agent_session_id: "sess-3", session_ids: '["sess-1","sess-2"]' });
    assert.deepEqual(getSessionIds(db, "claude-a"), ["sess-1", "sess-2", "sess-3"]);
  });

  it("falls back to agent_session_id for a legacy row with no set", () => {
    const db = createTestDb();
    seed(db, "claude-a", { agent_session_id: "sess-legacy", session_ids: null });
    assert.deepEqual(getSessionIds(db, "claude-a"), ["sess-legacy"]);
  });

  it("returns [] for a narrative with neither set nor current session, and for unknown ids", () => {
    const db = createTestDb();
    seed(db, "claude-a");
    assert.deepEqual(getSessionIds(db, "claude-a"), []);
    assert.deepEqual(getSessionIds(db, "claude-missing"), []);
  });
});

describe("sumCostReadings", () => {
  const r = (amount: number, unit = "USD", tokens?: CostReading["tokens"]): CostReading =>
    tokens ? { amount, unit, tokens } : { amount, unit };

  it("sums amounts across sessions of the same unit", () => {
    const total = sumCostReadings([r(1.5), r(2.25), r(0.25)]);
    assert.deepEqual(total, { amount: 4, unit: "USD" });
  });

  it("sums token breakdowns component-wise", () => {
    const total = sumCostReadings([
      r(1, "USD", { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 }),
      r(2, "USD", { input: 20, output: 7, cacheRead: 3, cacheWrite: 4 }),
    ]);
    assert.deepEqual(total, {
      amount: 3,
      unit: "USD",
      tokens: { input: 30, output: 12, cacheRead: 5, cacheWrite: 5 },
    });
  });

  it("skips null readings (transcript gone) and still totals the rest", () => {
    const total = sumCostReadings([r(1), null, r(3), null]);
    assert.deepEqual(total, { amount: 4, unit: "USD" });
  });

  it("returns null when there are no usable readings", () => {
    assert.equal(sumCostReadings([]), null);
    assert.equal(sumCostReadings([null, null]), null);
  });

  it("never adds across differing units — keeps the first, skips mismatches", () => {
    const total = sumCostReadings([r(1, "USD"), r(1000, "AIC"), r(2, "USD")]);
    assert.deepEqual(total, { amount: 3, unit: "USD" });
  });
});

// The claude adapter reads real transcripts under ~/.claude/projects/, and the
// pricing table overlays an optional ~/.brane/pricing.json — so both suites
// below sandbox HOME to a temp dir (same pattern as model-resolution.test.ts)
// and fabricate session JSONLs there.
describe("claude usage reading and pricing", () => {
  let origHome: string | undefined;
  let homeDir: string;

  const FOLD = "/work/proj-cost";
  const SESSION_A = "aaaaaaaa-0000-0000-0000-000000000001";
  const SESSION_B = "bbbbbbbb-0000-0000-0000-000000000002";
  const SESSION_GONE = "cccccccc-0000-0000-0000-000000000003";

  const usage = (input: number, output: number): MessageUsage => ({
    input,
    output,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
  });

  function usageLine(id: string | undefined, model: string, u: MessageUsage): string {
    return JSON.stringify({
      type: "assistant",
      message: {
        ...(id ? { id } : {}),
        model,
        role: "assistant",
        usage: {
          input_tokens: u.input,
          output_tokens: u.output,
          cache_read_input_tokens: u.cacheRead,
          cache_creation: {
            ephemeral_5m_input_tokens: u.cacheWrite5m,
            ephemeral_1h_input_tokens: u.cacheWrite1h,
          },
        },
      },
    });
  }

  // Session A: two id-bearing messages plus one id-less synthetic record.
  // Session B: fork of A — A's id-bearing lines copied verbatim (same ids),
  // then two genuinely new messages, one of them streamed twice (duplicate id
  // within the file).
  const A1 = { id: "msg_a1", model: "claude-opus-4-8", u: usage(1000, 500) };
  const A2 = { id: "msg_a2", model: "claude-opus-4-8", u: usage(2000, 700) };
  const A_SYNTH = { id: undefined, model: "<synthetic>", u: usage(10, 5) };
  const B1 = { id: "msg_b1", model: "claude-fable-5", u: usage(3000, 900) };
  const B2 = { id: "msg_b2", model: "claude-fable-5", u: usage(4000, 1100) };

  const cost = (m: { model: string; u: MessageUsage }) => priceMessage(m.model, m.u);
  const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
  const costA = round4(cost(A1) + cost(A2) + cost(A_SYNTH));
  const costAB = round4(cost(A1) + cost(A2) + cost(A_SYNTH) + cost(B1) + cost(B2));

  before(() => {
    origHome = process.env.HOME;
    homeDir = mkdtempSync(join(tmpdir(), "brane-cost-home-"));
    process.env.HOME = homeDir;

    const projectDir = join(homeDir, ".claude", "projects", FOLD.replace(/\//g, "-"));
    mkdirSync(projectDir, { recursive: true });
    const aLines = [
      usageLine(A1.id, A1.model, A1.u),
      usageLine(A2.id, A2.model, A2.u),
      usageLine(A_SYNTH.id, A_SYNTH.model, A_SYNTH.u),
    ];
    const bLines = [
      usageLine(A1.id, A1.model, A1.u), // fork-copied history, same ids
      usageLine(A2.id, A2.model, A2.u),
      usageLine(B1.id, B1.model, B1.u),
      usageLine(B1.id, B1.model, B1.u), // streamed duplicate within the file
      usageLine(B2.id, B2.model, B2.u),
    ];
    writeFileSync(join(projectDir, `${SESSION_A}.jsonl`), aLines.join("\n") + "\n");
    writeFileSync(join(projectDir, `${SESSION_B}.jsonl`), bLines.join("\n") + "\n");
  });

  after(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
  });

  describe("readUsage / readUsageMany fork dedup", () => {
    const claude = getAgentAdapter("claude");

    it("readUsage prices a single session, counting id-less records and deduping streamed duplicates", () => {
      const a = claude.readUsage!({ sessionId: SESSION_A, foldPath: FOLD });
      assert.equal(a?.amount, costA);
      assert.deepEqual(a?.tokens, {
        input: A1.u.input + A2.u.input + A_SYNTH.u.input,
        output: A1.u.output + A2.u.output + A_SYNTH.u.output,
        cacheRead: 0,
        cacheWrite: 0,
      });
      const b = claude.readUsage!({ sessionId: SESSION_B, foldPath: FOLD });
      assert.equal(b?.amount, round4(cost(A1) + cost(A2) + cost(B1) + cost(B2)));
    });

    it("readUsageMany counts fork-copied messages once: total = cost(A) + cost(B new only)", () => {
      const total = claude.readUsageMany!({ sessionIds: [SESSION_A, SESSION_B], foldPath: FOLD });
      assert.equal(total?.amount, costAB);
      assert.equal(total?.unit, "USD");
      assert.deepEqual(total?.tokens, {
        input: A1.u.input + A2.u.input + A_SYNTH.u.input + B1.u.input + B2.u.input,
        output: A1.u.output + A2.u.output + A_SYNTH.u.output + B1.u.output + B2.u.output,
        cacheRead: 0,
        cacheWrite: 0,
      });
    });

    it("repeated sampling is stable (memoized parse, same totals)", () => {
      const first = claude.readUsageMany!({ sessionIds: [SESSION_A, SESSION_B], foldPath: FOLD });
      const second = claude.readUsageMany!({ sessionIds: [SESSION_A, SESSION_B], foldPath: FOLD });
      assert.deepEqual(second, first);
    });

    it("readUsageEntries keys messages by id, and id-less records by file position", () => {
      const readings = claude.readUsageEntries!({ sessionIds: [SESSION_A, SESSION_B, SESSION_GONE], foldPath: FOLD });
      assert.equal(readings?.length, 2);
      const [a, b] = readings!;
      assert.equal(a.sessionId, SESSION_A);
      assert.equal(a.unit, "USD");
      assert.deepEqual(
        a.entries.map((e) => [e.key, e.amount]),
        [["claude:msg_a1", cost(A1)], ["claude:msg_a2", cost(A2)], [`claude:${SESSION_A}#2`, cost(A_SYNTH)]],
      );
      // Fork-copied ids repeat verbatim — the ledger's primary key is what
      // collapses them — while the in-file streamed duplicate is already gone.
      assert.deepEqual(
        b.entries.map((e) => e.key),
        ["claude:msg_a1", "claude:msg_a2", "claude:msg_b1", "claude:msg_b2"],
      );
      assert.ok(a.sig && b.sig);
      assert.equal(claude.readUsageEntries!({ sessionIds: [SESSION_GONE], foldPath: FOLD }), null);
    });

    it("skips missing session files, and returns null when none are readable", () => {
      const partial = claude.readUsageMany!({ sessionIds: [SESSION_A, SESSION_GONE], foldPath: FOLD });
      assert.equal(partial?.amount, costA);
      assert.equal(claude.readUsageMany!({ sessionIds: [SESSION_GONE], foldPath: FOLD }), null);
      assert.equal(claude.readUsageMany!({ sessionIds: [], foldPath: FOLD }), null);
    });
  });

  describe("backfillCostLedger", () => {
    function seedFold(db: ReturnType<typeof createTestDb>, id: string, createdAt: number, sessionId: string, cost?: number) {
      db.prepare(
        `INSERT INTO narratives (id, brane_id, agent_type, role, created_at, status, fold_path, agent_session_id, session_ids, cost_amount, cost_unit)
         VALUES (?, 'brane-test', 'claude', 'worker', ?, 'ended', ?, ?, ?, ?, ?)`,
      ).run(id, createdAt, FOLD, sessionId, JSON.stringify([sessionId]), cost ?? null, cost == null ? null : "USD");
    }

    it("walks oldest first, so the original claims fork-copied messages before its twin", () => {
      const db = createTestDb();
      // Inserted newest-first to prove the order comes from created_at, not rowid.
      seedFold(db, "claude-twin", 200, SESSION_B);
      seedFold(db, "claude-orig", 100, SESSION_A);
      const dry = backfillCostLedger(db, { dryRun: true });
      assert.equal(dry.scanned, 2);
      assert.deepEqual(dry.samples.map((s) => s.nid), ["claude-orig", "claude-twin"]);
      assert.equal(ledgerTotal(db, "claude-orig"), null, "dry run writes nothing");

      const real = backfillCostLedger(db);
      assert.equal(real.samples.length, 2);
      // The ledger keeps six decimals where the old reader rounded to four.
      assert.equal(round4(ledgerTotal(db, "claude-orig")!.amount), costA);
      assert.equal(round4(ledgerTotal(db, "claude-twin")!.amount), round4(cost(B1) + cost(B2)));
      const col = (id: string) =>
        (db.prepare("SELECT cost_amount FROM narratives WHERE id = ?").get(id) as { cost_amount: number }).cost_amount;
      assert.equal(round4(col("claude-orig")), costA);
      assert.equal(round4(col("claude-twin")), round4(cost(B1) + cost(B2)));
      // Idempotent: nothing new on a second pass.
      const again = backfillCostLedger(db);
      assert.ok(again.samples.every((s) => s.new_rows === 0 && s.before === s.after));
    });

    it("keeps a frozen column that exceeds what the surviving transcripts show", () => {
      const db = createTestDb();
      seedFold(db, "claude-frozen", 100, SESSION_A, 99.5);
      backfillCostLedger(db);
      assert.equal(round4(ledgerTotal(db, "claude-frozen")!.amount), costA);
      const col = (db.prepare("SELECT cost_amount FROM narratives WHERE id = ?").get("claude-frozen") as { cost_amount: number }).cost_amount;
      assert.equal(col, 99.5);
    });
  });

  describe("priceMessage tiers", () => {
    const oneMTokEach = usage(1e6, 1e6);

    it("prices fable and mythos at $10/$50 — exactly 2× opus for the same usage", () => {
      const opus = priceMessage("claude-opus-4-8", oneMTokEach);
      assert.equal(opus, 30);
      assert.equal(priceMessage("claude-fable-5", oneMTokEach), 2 * opus);
      assert.equal(priceMessage("claude-mythos-5", oneMTokEach), 2 * opus);
    });

    it("keeps cache multipliers relative to the fable input price", () => {
      const cacheOnly: MessageUsage = { input: 0, output: 0, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 };
      // 0.1× + 1.25× + 2× of the $10 input price.
      assert.equal(priceMessage("claude-fable-5", cacheOnly), 1 + 12.5 + 20);
    });

    it("prices unknown models at the most expensive known tier (fable)", () => {
      assert.equal(priceMessage("claude-newthing-9", oneMTokEach), 60);
    });
  });
});
