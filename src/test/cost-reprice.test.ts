import { describe, it } from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import type Database from "better-sqlite3";

// No pricing.json may leak in from the real HOME: the current table must be
// exactly the built-in one for the amounts below to hold.
process.env.HOME = mkdtempSync(join(tmpdir(), "brane-reprice-home-"));

const { createTestDb } = await import("./helpers.js");
const { priceMessage, priceMessageV1 } = await import("../cost/pricing.js");
const { recoverCacheWrite1h, repriceLedger } = await import("../cost/reprice.js");
const { recordUsageEntries } = await import("../daemon/server.js");

interface Row {
  key: string;
  nid: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  w5: number;
  w1: number;
}

/** A row as the pre-split code wrote it: V1 amount, one cache_write count. */
function insertV1(db: Database.Database, r: Row): number {
  const amount = priceMessageV1(r.model, {
    input: r.input,
    output: r.output,
    cacheRead: r.cacheRead,
    cacheWrite5m: r.w5,
    cacheWrite1h: r.w1,
  });
  db.prepare(
    `INSERT INTO usage_ledger (key, narrative_id, session_id, agent_type, unit, amount, model,
       input, output, cache_read, cache_write, first_seen)
     VALUES (?, ?, 's', 'claude', 'USD', ?, ?, ?, ?, ?, ?, 0)`,
  ).run(r.key, r.nid, amount, r.model, r.input, r.output, r.cacheRead, r.w5 + r.w1);
  return amount;
}

const current = (r: Row) =>
  priceMessage(r.model, { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite5m: r.w5, cacheWrite1h: r.w1 });

function narrative(db: Database.Database, nid: string, cost: number | null) {
  db.prepare(
    `INSERT INTO narratives (id, brane_id, agent_type, role, created_at, status, cost_amount, cost_unit)
     VALUES (?, 'brane-test', 'claude', 'worker', 0, 'ended', ?, ?)`,
  ).run(nid, cost, cost === null ? null : "USD");
}

const col = (db: Database.Database, nid: string) =>
  (db.prepare("SELECT cost_amount FROM narratives WHERE id = ?").get(nid) as { cost_amount: number | null }).cost_amount;
const ledger = (db: Database.Database, key: string) =>
  db.prepare("SELECT amount, cache_write_1h FROM usage_ledger WHERE key = ?").get(key) as {
    amount: number;
    cache_write_1h: number | null;
  };

// Token shapes taken from real rows: a long session's cache-read-heavy turn,
// with mixed 5m / 1h writes so the split actually matters.
const FABLE51: Row = { key: "claude:f1", nid: "claude-f", model: "claude-fable-5-1", input: 6, output: 843, cacheRead: 203752, w5: 1200, w1: 16270 };
const OPUS55: Row = { key: "claude:o1", nid: "claude-o", model: "claude-opus-5-5", input: 2, output: 650, cacheRead: 227000, w5: 0, w1: 7000 };
const SONNET5: Row = { key: "claude:s1", nid: "claude-s", model: "claude-sonnet-5", input: 2, output: 332, cacheRead: 0, w5: 0, w1: 102607 };
const OPUS5: Row = { key: "claude:u1", nid: "claude-u", model: "claude-opus-5", input: 10, output: 900, cacheRead: 150000, w5: 300, w1: 4000 };

describe("recoverCacheWrite1h", () => {
  it("recovers the exact split from a V1 amount", () => {
    for (const r of [FABLE51, OPUS55, SONNET5, OPUS5]) {
      const amount = priceMessageV1(r.model, { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite5m: r.w5, cacheWrite1h: r.w1 });
      const row = { model: r.model, amount, input: r.input, output: r.output, cache_read: r.cacheRead, cache_write: r.w5 + r.w1 };
      assert.equal(recoverCacheWrite1h(row), r.w1, r.model);
    }
  });

  it("refuses an amount no split explains (e.g. priced under an override)", () => {
    const row = { model: "claude-opus-5", amount: 123.456, input: 1, output: 1, cache_read: 0, cache_write: 10 };
    assert.equal(recoverCacheWrite1h(row), null);
  });
});

describe("repriceLedger", () => {
  it("corrects mispriced rows, leaves correct ones, and records the recovered split", () => {
    const db = createTestDb();
    for (const r of [FABLE51, OPUS55, SONNET5, OPUS5]) {
      narrative(db, r.nid, null);
      insertV1(db, r);
    }
    const result = repriceLedger(db);
    assert.equal(result.scanned, 4);
    assert.equal(result.recovered, 4);
    assert.equal(result.unrecoverable, 0);
    assert.equal(result.changed, 3);
    for (const r of [FABLE51, OPUS55, SONNET5, OPUS5]) {
      const row = ledger(db, r.key);
      assert.ok(Math.abs(row.amount - current(r)) < 1e-12, r.model);
      assert.equal(row.cache_write_1h, r.w1, r.model);
    }
    // A second pass reads the recorded split and finds nothing to do.
    const again = repriceLedger(db);
    assert.equal(again.recovered, 0);
    assert.equal(again.changed, 0);
  });

  it("writes nothing on a dry run, and reports what the real run then does", () => {
    const db = createTestDb();
    narrative(db, FABLE51.nid, 5);
    const before = insertV1(db, FABLE51);
    const dry = repriceLedger(db, { dryRun: true });
    assert.equal(ledger(db, FABLE51.key).amount, before);
    assert.equal(ledger(db, FABLE51.key).cache_write_1h, null);
    assert.equal(col(db, FABLE51.nid), 5);
    const real = repriceLedger(db);
    assert.deepEqual({ ...dry, dry_run: false }, real);
  });

  it("moves the card total by the correction, keeping pre-ledger cost above the ledger sum", () => {
    const db = createTestDb();
    // The column holds $40 more than the ledger — cost from transcripts
    // that predate the ledger. The correction applies; that $40 survives.
    const amount = insertV1(db, FABLE51);
    narrative(db, FABLE51.nid, amount + 40);
    const result = repriceLedger(db);
    const delta = current(FABLE51) - amount;
    assert.ok(delta < 0);
    assert.ok(Math.abs(col(db, FABLE51.nid)! - (amount + 40 + delta)) < 1e-6);
    assert.equal(result.narratives[0].nid, FABLE51.nid);
  });

  it("brings a column equal to the ledger sum down to the new sum", () => {
    const db = createTestDb();
    const amount = insertV1(db, OPUS55);
    narrative(db, OPUS55.nid, amount);
    repriceLedger(db);
    assert.ok(Math.abs(col(db, OPUS55.nid)! - current(OPUS55)) < 1e-6);
  });

  it("leaves session high-water rows and model-less rows alone", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO usage_ledger (key, narrative_id, unit, amount, first_seen)
       VALUES ('session:goose:x', 'goose-a', 'USD', 22.09, 0)`,
    ).run();
    const result = repriceLedger(db);
    assert.equal(result.scanned, 0);
    assert.equal(ledger(db, "session:goose:x").amount, 22.09);
  });

  it("new rows carry the split and speed, so they reprice without inference", () => {
    const db = createTestDb();
    const u = { input: 1, output: 100, cacheRead: 1000, cacheWrite5m: 50, cacheWrite1h: 70, speed: "fast" };
    recordUsageEntries(db, "claude-n", "claude", [
      {
        sessionId: "s",
        sig: "1",
        unit: "USD",
        entries: [
          {
            key: "claude:n1",
            amount: priceMessage("claude-opus-5-5", u),
            model: "claude-opus-5-5",
            tokens: { input: 1, output: 100, cacheRead: 1000, cacheWrite: 120, cacheWrite1h: 70 },
            speed: "fast",
          },
        ],
      },
    ]);
    const row = db.prepare("SELECT cache_write_1h, speed FROM usage_ledger WHERE key = 'claude:n1'").get();
    assert.deepEqual({ ...(row as object) }, { cache_write_1h: 70, speed: "fast" });
    const result = repriceLedger(db);
    assert.equal(result.recovered, 0);
    assert.equal(result.changed, 0);
  });
});
