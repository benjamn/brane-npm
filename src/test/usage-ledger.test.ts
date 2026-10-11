import { before, describe, it } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.js";
import { recordUsageEntries, recordUsageHighWater, ledgerTotal, sampleNarrativeCostDetailed } from "../daemon/server.js";
import type { UsageEntriesReading } from "../agents.js";

const tok = (n: number) => ({ input: n, output: n, cacheRead: 0, cacheWrite: 0 });

function reading(sessionId: string, sig: string, entries: Array<[string, number]>): UsageEntriesReading {
  return {
    sessionId,
    sig,
    unit: "USD",
    entries: entries.map(([key, amount]) => ({ key, amount, tokens: tok(1) })),
  };
}

describe("usage ledger", () => {
  it("sums a narrative's entries, with a token breakdown", () => {
    const db = createTestDb();
    recordUsageEntries(db, "claude-a", "claude", [reading("sess-1", "1", [["claude:m1", 1.5], ["claude:m2", 2.25]])]);
    assert.deepEqual(ledgerTotal(db, "claude-a"), { amount: 3.75, unit: "USD", tokens: tok(2) });
    assert.equal(ledgerTotal(db, "claude-nobody"), null);
  });

  it("credits a fork-copied message to the narrative that saw it first, and never moves it", () => {
    const db = createTestDb();
    // Original session A, then fork B which carries m1 forward and adds m2.
    recordUsageEntries(db, "claude-a", "claude", [reading("sess-a", "1", [["claude:m1", 1]])]);
    recordUsageEntries(db, "claude-b", "claude", [reading("sess-b", "1", [["claude:m1", 1], ["claude:m2", 2]])]);
    assert.equal(ledgerTotal(db, "claude-a")?.amount, 1);
    assert.equal(ledgerTotal(db, "claude-b")?.amount, 2);
  });

  it("survives the original transcript being purged: re-reading only the fork changes nothing", () => {
    const db = createTestDb();
    recordUsageEntries(db, "claude-a", "claude", [
      reading("sess-a", "1", [["claude:m1", 1], ["claude:m2", 2]]),
      reading("sess-b", "1", [["claude:m1", 1], ["claude:m2", 2], ["claude:m3", 4]]),
    ]);
    assert.equal(ledgerTotal(db, "claude-a")?.amount, 7);
    // sess-a is gone; sess-b is all the harness can show us now, and it has
    // changed (new sig) — still nothing to add, nothing to lose.
    recordUsageEntries(db, "claude-a", "claude", [
      reading("sess-b", "2", [["claude:m1", 1], ["claude:m2", 2], ["claude:m3", 4]]),
    ]);
    assert.equal(ledgerTotal(db, "claude-a")?.amount, 7);
  });

  it("skips a session whose signature is unchanged, and picks up new entries when it changes", () => {
    const db = createTestDb();
    recordUsageEntries(db, "claude-a", "claude", [reading("sess-1", "sig1", [["claude:m1", 1]])]);
    // Same sig, new key: not written (the real reader can't produce this, but
    // it proves the memo short-circuits).
    recordUsageEntries(db, "claude-a", "claude", [reading("sess-1", "sig1", [["claude:m1", 1], ["claude:m2", 5]])]);
    assert.equal(ledgerTotal(db, "claude-a")?.amount, 1);
    recordUsageEntries(db, "claude-a", "claude", [reading("sess-1", "sig2", [["claude:m1", 1], ["claude:m2", 5]])]);
    assert.equal(ledgerTotal(db, "claude-a")?.amount, 6);
  });

  it("keeps the model with the row, and fills it in on a row written without one", () => {
    const db = createTestDb();
    const modelOf = () =>
      (db.prepare("SELECT model, amount FROM usage_ledger WHERE key = 'claude:m1'").get() as { model: string | null; amount: number });
    recordUsageEntries(db, "claude-a", "claude", [reading("s1", "1", [["claude:m1", 1]])]);
    assert.deepEqual(modelOf(), { model: null, amount: 1 });
    recordUsageEntries(db, "claude-b", "claude", [
      { sessionId: "s2", sig: "1", unit: "USD", entries: [{ key: "claude:m1", amount: 99, model: "claude-fable-5" }] },
    ]);
    // Model filled in; credit (claude-a) and amount untouched.
    assert.deepEqual(modelOf(), { model: "claude-fable-5", amount: 1 });
    assert.equal(ledgerTotal(db, "claude-b"), null);
  });

  it("high-water rows only ever rise", () => {
    const db = createTestDb();
    recordUsageHighWater(db, "codex-a", "codex", "s1", { amount: 100, unit: "TOK", tokens: tok(100) });
    recordUsageHighWater(db, "codex-a", "codex", "s1", { amount: 250, unit: "TOK", tokens: tok(250) });
    recordUsageHighWater(db, "codex-a", "codex", "s1", { amount: 40, unit: "TOK", tokens: tok(40) });
    assert.deepEqual(ledgerTotal(db, "codex-a"), { amount: 250, unit: "TOK", tokens: tok(250) });
    // A second session adds, rather than replaces.
    recordUsageHighWater(db, "codex-a", "codex", "s2", { amount: 10, unit: "TOK" });
    assert.equal(ledgerTotal(db, "codex-a")?.amount, 260);
  });

  it("a high-water row ignores a reading in a different unit", () => {
    const db = createTestDb();
    recordUsageHighWater(db, "x-a", "codex", "s1", { amount: 100, unit: "TOK" });
    recordUsageHighWater(db, "x-a", "codex", "s1", { amount: 999, unit: "USD" });
    assert.deepEqual(ledgerTotal(db, "x-a"), { amount: 100, unit: "TOK" });
  });

  it("never sums across units: the unit with the most rows wins", () => {
    const db = createTestDb();
    recordUsageHighWater(db, "x-a", "copilot", "s1", { amount: 100, unit: "AIC" });
    recordUsageHighWater(db, "x-a", "copilot", "s2", { amount: 5, unit: "AIC" });
    recordUsageHighWater(db, "x-a", "goose", "s3", { amount: 9, unit: "USD" });
    assert.deepEqual(ledgerTotal(db, "x-a"), { amount: 105, unit: "AIC" });
  });
});

// Drive the sampler itself over an adapter that has *both* readUsage and
// readUsageMany (cline is the only one), through the high-water branch.
// Cline's store is a brane-owned directory under /tmp keyed by narrative id,
// so the test can fabricate one for a narrative id nothing else uses.
describe("sampleNarrativeCostDetailed over a high-water adapter", () => {
  const NID = "cline-ledgertest";
  const store = join("/tmp", `brane-cline-${NID}`, "data", "sessions");
  const writeSession = (id: string, costs: number[]) => {
    mkdirSync(join(store, id), { recursive: true });
    writeFileSync(
      join(store, id, `${id}.messages.json`),
      JSON.stringify({ messages: costs.map((cost, i) => ({ id: `${id}-${i}`, metrics: { cost, inputTokens: 1, outputTokens: 1 } })) }),
    );
  };

  before(() => {
    writeSession("1000_aaaaa", [1, 2]); // bound
    writeSession("2000_bbbbb", [4]); // in the store, never captured by brane
  });

  it("prefers readUsageMany, so sessions brane never bound still count, as one narrative-keyed row", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO narratives (id, brane_id, agent_type, role, created_at, status, fold_path, agent_session_id, session_ids, cost_amount, cost_unit)
       VALUES (?, 'brane-test', 'cline', 'worker', 0, 'active', '/tmp', '1000_aaaaa', '["1000_aaaaa"]', 2.5, 'USD')`,
    ).run(NID);

    const dry = sampleNarrativeCostDetailed(db, NID, { dryRun: true });
    assert.equal(dry?.readable, 1);
    assert.equal(dry?.new_amount, 7);
    assert.equal(dry?.after, 7, "dry run projects the column");
    assert.equal(ledgerTotal(db, NID), null, "dry run writes nothing");

    const real = sampleNarrativeCostDetailed(db, NID);
    assert.deepEqual({ before: real?.before, after: real?.after }, { before: 2.5, after: 7 });
    const rows = db.prepare("SELECT key, amount FROM usage_ledger WHERE narrative_id = ?").all(NID) as Array<{ key: string; amount: number }>;
    assert.deepEqual(rows, [{ key: `session:cline:${NID}`, amount: 7 }]);

    // The harness loses a session: the row, and the card, hold.
    writeSession("2000_bbbbb", []);
    const again = sampleNarrativeCostDetailed(db, NID);
    assert.equal(again?.after, 7);
    assert.equal(ledgerTotal(db, NID)?.amount, 7);
  });
});
