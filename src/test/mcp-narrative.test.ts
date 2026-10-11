import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.js";
import { adoptBindTokens } from "../db/tokens.js";
import { ensureMcpNarrative, mintExternalNarrative, mintExternalNarrativeWithSecret, resolveMcpBind, randomBase36 } from "../daemon/server.js";

interface NarrativeRow {
  id: string;
  brane_id: string;
  agent_type: string;
  role: string;
  status: string;
}

function getNarrative(db: ReturnType<typeof createTestDb>, id: string): NarrativeRow | undefined {
  return db
    .prepare("SELECT id, brane_id, agent_type, role, status FROM narratives WHERE id = ?")
    .get(id) as NarrativeRow | undefined;
}

function narrativeCount(db: ReturnType<typeof createTestDb>): number {
  return (db.prepare("SELECT COUNT(*) as n FROM narratives").get() as { n: number }).n;
}

describe("randomBase36", () => {
  it("produces a string of the requested length", () => {
    for (const len of [1, 8, 16, 64]) {
      assert.equal(randomBase36(len).length, len);
    }
  });

  it("uses only [0-9a-z]", () => {
    // Draw a large sample so every output character is exercised many times.
    const s = randomBase36(2000);
    assert.match(s, /^[0-9a-z]+$/);
  });

  it("covers the full alphabet without bias-induced gaps", () => {
    // Rejection sampling must still reach every symbol, including the high
    // ones (z = index 35) that a naive `byte % 36` would over- or
    // under-represent. With 5000 draws, all 36 symbols should appear.
    const seen = new Set(randomBase36(5000).split(""));
    assert.equal(seen.size, 36, `expected all 36 symbols, saw ${seen.size}`);
  });
});

describe("ensureMcpNarrative", () => {
  it("trusts an id that already names a narrative row (no INSERT, no event)", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO narratives (id, brane_id, agent_type, role, created_at, status)
       VALUES ('claude-deadbeef', 'brane-test', 'claude', 'reviewer', 0, 'ended')`,
    ).run();
    const before = narrativeCount(db);

    const result = ensureMcpNarrative(db, "brane-test", "claude-deadbeef");

    assert.equal(result, "claude-deadbeef");
    assert.equal(narrativeCount(db), before, "must not insert a new row");
    // No seeded event for an existing narrative.
    const events = db
      .prepare("SELECT COUNT(*) as n FROM events WHERE narrative_id = ?")
      .get("claude-deadbeef") as { n: number };
    assert.equal(events.n, 0);
  });

  it("mints a fresh server-side narrative for an unknown (unspawned) id", () => {
    const db = createTestDb();
    const result = ensureMcpNarrative(db, "brane-test", "external-clientchosen");

    // The client-chosen id is discarded; a server id of the canonical shape
    // is returned instead.
    assert.notEqual(result, "external-clientchosen");
    assert.match(result, /^external-[0-9a-z]{8}$/);
    assert.equal(getNarrative(db, "external-clientchosen"), undefined, "client id must not be persisted");

    const row = getNarrative(db, result);
    assert.ok(row, "minted narrative row should exist");
    assert.equal(row.brane_id, "brane-test");
    assert.equal(row.agent_type, "external");
    assert.equal(row.role, "external");
    assert.equal(row.status, "active");
  });

  it("seeds a single `started` event on the minted narrative", () => {
    const db = createTestDb();
    const result = ensureMcpNarrative(db, "brane-test", "external-clientchosen");

    const events = db
      .prepare("SELECT seq, type, content FROM events WHERE narrative_id = ? ORDER BY seq")
      .all(result) as Array<{ seq: number; type: string; content: string }>;
    assert.equal(events.length, 1);
    assert.equal(events[0].seq, 1);
    assert.equal(events[0].type, "started");
    assert.equal(events[0].content, "Connected external MCP client");
  });

  it("mints distinct, unique narratives across repeated unspawned connects", () => {
    // Exercises the uniqueness contract: every unspawned connect produces a
    // fresh row whose id collides with neither the client-supplied value nor
    // any previously minted id. (The internal PRIMARY KEY retry loop is a
    // vanishingly-rare defensive branch and isn't forced here.)
    const db = createTestDb();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      ids.add(ensureMcpNarrative(db, "brane-test", "external-placeholder"));
    }
    assert.equal(ids.size, 50, "every unspawned connect should mint a unique id");
    assert.equal(narrativeCount(db), 50);
  });
});

describe("resolveMcpBind (per-narrative bind token)", () => {
  // Seed a spawned narrative with a known bind_token + session, and return
  // helpers to inspect it after a bind attempt.
  function seedSpawned(
    db: ReturnType<typeof createTestDb>,
    id: string,
    bindToken: string | null,
    sessionId = "sess-A",
  ): void {
    db.prepare(
      `INSERT INTO narratives (id, brane_id, agent_type, role, created_at, status, agent_session_id, bind_token)
       VALUES (?, 'brane-test', 'claude', 'worker', 0, 'active', ?, ?)`,
    ).run(id, sessionId, bindToken);
    // As the daemon's start does: the plaintext becomes an agent token row.
    adoptBindTokens(db);
  }
  function eventCount(db: ReturnType<typeof createTestDb>, id: string): number {
    return (
      db.prepare("SELECT COUNT(*) as n FROM events WHERE narrative_id = ?").get(id) as { n: number }
    ).n;
  }
  function sessionOf(db: ReturnType<typeof createTestDb>, id: string): string | null {
    return (
      db.prepare("SELECT agent_session_id FROM narratives WHERE id = ?").get(id) as {
        agent_session_id: string | null;
      }
    ).agent_session_id;
  }

  it("binds to the claimed id when the secret matches", () => {
    const db = createTestDb();
    seedSpawned(db, "claude-alpha", "secret-alpha");

    const result = resolveMcpBind(db, "brane-test", "claude-alpha", "secret-alpha");

    assert.equal(result.nid, "claude-alpha");
    assert.equal(result.minted, false);
    assert.equal(result.rejected, undefined);
  });

  it("rejects a wrong secret: mints external, leaves the claimed narrative untouched", () => {
    const db = createTestDb();
    seedSpawned(db, "claude-alpha", "secret-alpha", "sess-A");

    const result = resolveMcpBind(db, "brane-test", "claude-alpha", "wrong-secret");

    assert.notEqual(result.nid, "claude-alpha");
    assert.match(result.nid, /^external-[0-9a-z]{8}$/);
    assert.equal(result.minted, true);
    assert.deepEqual(result.rejected, { claimedNid: "claude-alpha", reason: "secret_mismatch" });
    // The claimed narrative's session is preserved and nothing leaked into it.
    assert.equal(sessionOf(db, "claude-alpha"), "sess-A", "victim session must be preserved");
    assert.equal(eventCount(db, "claude-alpha"), 0, "no events leak into the claimed narrative");
  });

  it("rejects an absent secret (reason: secret_absent)", () => {
    const db = createTestDb();
    seedSpawned(db, "claude-alpha", "secret-alpha");

    const result = resolveMcpBind(db, "brane-test", "claude-alpha", undefined);

    assert.match(result.nid, /^external-[0-9a-z]{8}$/);
    assert.equal(result.minted, true);
    assert.deepEqual(result.rejected, { claimedNid: "claude-alpha", reason: "secret_absent" });
    assert.equal(sessionOf(db, "claude-alpha"), "sess-A");
  });

  it("mints a fresh external narrative for an unknown (unspawned) id", () => {
    const db = createTestDb();

    const result = resolveMcpBind(db, "brane-test", "external-clientchosen", undefined);

    assert.notEqual(result.nid, "external-clientchosen");
    assert.match(result.nid, /^external-[0-9a-z]{8}$/);
    assert.equal(result.minted, true);
    assert.equal(result.rejected, undefined);
    assert.equal(
      getNarrative(db, "external-clientchosen"),
      undefined,
      "client-chosen id must not be persisted",
    );
  });

  it("a row with a null bind_token is refused, not waved through", () => {
    // The migration grace that used to allow this bind is retired. Such a row
    // has no secret to check against, so there is no way to prove a claim to
    // it: the connection is minted a fresh external id like any other unproven
    // claimant, and the reason names the row rather than the client.
    const db = createTestDb();
    seedSpawned(db, "claude-legacy", null);

    const result = resolveMcpBind(db, "brane-test", "claude-legacy", undefined);

    assert.match(result.nid, /^external-[0-9a-z]{8}$/);
    assert.equal(result.minted, true);
    assert.deepEqual(result.rejected, { claimedNid: "claude-legacy", reason: "no_bind_token" });
    assert.equal(sessionOf(db, "claude-legacy"), "sess-A", "claimed narrative untouched");
    assert.equal(eventCount(db, "claude-legacy"), 0);
  });

  it("a matching secret string that differs from the token is still rejected", () => {
    // Guards against any accidental loose/prefix comparison.
    const db = createTestDb();
    seedSpawned(db, "claude-alpha", "secret-alpha");

    const result = resolveMcpBind(db, "brane-test", "claude-alpha", "secret-alph");
    assert.equal(result.minted, true);
    assert.deepEqual(result.rejected, { claimedNid: "claude-alpha", reason: "secret_mismatch" });
  });
});

describe("mintExternalNarrative", () => {
  it("creates an external-shaped row with a seeded started event", () => {
    const db = createTestDb();
    const nid = mintExternalNarrative(db, "brane-test");

    assert.match(nid, /^external-[0-9a-z]{8}$/);
    const row = getNarrative(db, nid);
    assert.ok(row);
    assert.equal(row.agent_type, "external");
    assert.equal(row.role, "external");
    assert.equal(row.status, "active");
    const events = db
      .prepare("SELECT type, content FROM events WHERE narrative_id = ?")
      .all(nid) as Array<{ type: string; content: string }>;
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "started");
  });

  it("gives the external a bind token, so its own reconnect authenticates", () => {
    // Externals used to be tokenless, and their reconnects relied on the
    // migration grace to get back to the same narrative. With the grace gone
    // that would fragment one client into a narrative per reconnect, so the
    // mint issues a real secret and `welcome` hands it to the bridge.
    const db = createTestDb();
    const { nid, secret } = mintExternalNarrativeWithSecret(db, "brane-test");
    assert.ok(secret, "minted externals carry an agent token");
    const { bind_token } = db.prepare("SELECT bind_token FROM narratives WHERE id = ?").get(nid) as { bind_token: string | null };
    assert.equal(bind_token, null, "and no plaintext of it is kept");
    assert.equal(resolveMcpBind(db, "brane-test", nid, secret).nid, nid);
  });
});
