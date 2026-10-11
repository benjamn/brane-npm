import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.js";
import { adoptBindTokens, mintAgentToken, settleAgentLaunch, verifyAgentToken } from "../db/tokens.js";
import { braneTmuxEnv, ensureBindToken, buildGooseExtensionArg } from "../commands/spawn.js";

describe("braneTmuxEnv", () => {
  it("emits BRANE_NARRATIVE_ID and BRANE_NARRATIVE_SECRET when a token is present", () => {
    const env = braneTmuxEnv("claude-abc123", "tok-xyz");
    assert.equal(env, "BRANE_NARRATIVE_ID=claude-abc123 BRANE_NARRATIVE_SECRET=tok-xyz");
  });

  it("omits the secret assignment when the token is absent (migration grace)", () => {
    assert.equal(braneTmuxEnv("claude-abc123", null), "BRANE_NARRATIVE_ID=claude-abc123");
    assert.equal(braneTmuxEnv("claude-abc123"), "BRANE_NARRATIVE_ID=claude-abc123");
    assert.equal(braneTmuxEnv("claude-abc123", ""), "BRANE_NARRATIVE_ID=claude-abc123");
  });
});

describe("ensureBindToken", () => {
  // Every launch hands its session a fresh agent token and revokes the one
  // its previous launch held; the daemon keeps only the hash.
  function insert(db: ReturnType<typeof createTestDb>, id: string, token: string | null): void {
    db.prepare(
      `INSERT INTO narratives (id, brane_id, agent_type, role, created_at, status, bind_token)
       VALUES (?, 'brane-test', 'claude', 'worker', 0, 'active', ?)`,
    ).run(id, token);
  }

  it("mints an agent token for the narrative, kept only as a hash", () => {
    const db = createTestDb();
    insert(db, "claude-alpha", null);
    const secret = ensureBindToken(db, "claude-alpha");
    assert.ok(verifyAgentToken(db, "claude-alpha", secret));
    assert.equal(verifyAgentToken(db, "claude-beta", secret), false, "bound to its own narrative");
    const row = db.prepare("SELECT bind_token FROM narratives WHERE id = ?").get("claude-alpha") as { bind_token: string | null };
    assert.equal(row.bind_token, null, "no plaintext on the narrative");
    const stored = db.prepare("SELECT COUNT(*) AS n FROM tokens WHERE hash = ?").get(secret) as { n: number };
    assert.equal(stored.n, 0, "the table holds its hash, not the secret");
  });

  it("revokes the previous launch's token, so one is live per narrative", () => {
    const db = createTestDb();
    insert(db, "claude-alpha", "existing-token");
    adoptBindTokens(db);
    assert.ok(verifyAgentToken(db, "claude-alpha", "existing-token"), "an adopted pre-agent-token secret works");
    const next = ensureBindToken(db, "claude-alpha");
    assert.notEqual(next, "existing-token");
    assert.equal(verifyAgentToken(db, "claude-alpha", "existing-token"), false);
    assert.ok(verifyAgentToken(db, "claude-alpha", next));
    const live = db
      .prepare("SELECT COUNT(*) AS n FROM tokens WHERE kind = 'agent' AND owner_nid = ? AND revoked_at IS NULL")
      .get("claude-alpha") as { n: number };
    assert.equal(live.n, 1);
  });

  it("a revive that fails to launch leaves the running session's token alone", () => {
    const db = createTestDb();
    insert(db, "claude-alpha", null);
    const running = ensureBindToken(db, "claude-alpha");
    const loser = mintAgentToken(db, "claude-alpha", Date.now(), undefined, false);
    assert.ok(verifyAgentToken(db, "claude-alpha", running), "still live while the launch is pending");
    settleAgentLaunch(db, "claude-alpha", loser, false);
    assert.ok(verifyAgentToken(db, "claude-alpha", running));
    assert.equal(verifyAgentToken(db, "claude-alpha", loser), false);
  });

  it("a revive that launches retires the previous token", () => {
    const db = createTestDb();
    insert(db, "claude-alpha", null);
    const old = ensureBindToken(db, "claude-alpha");
    const fresh = mintAgentToken(db, "claude-alpha", Date.now(), undefined, false);
    settleAgentLaunch(db, "claude-alpha", fresh, true);
    assert.equal(verifyAgentToken(db, "claude-alpha", old), false);
    assert.ok(verifyAgentToken(db, "claude-alpha", fresh));
  });

  it("adopting twice adds nothing, and never brings back a revoked secret", () => {
    const db = createTestDb();
    insert(db, "claude-alpha", "existing-token");
    assert.equal(adoptBindTokens(db), 1);
    ensureBindToken(db, "claude-alpha");
    assert.equal(adoptBindTokens(db), 0);
    assert.equal(verifyAgentToken(db, "claude-alpha", "existing-token"), false);
  });
});

describe("buildGooseExtensionArg", () => {
  it("carries the bind secret inline in the goose extension env", () => {
    const arg = buildGooseExtensionArg("goose-xyz", "tok-goose");
    assert.match(arg, /^BRANE_NARRATIVE_ID=goose-xyz BRANE_NARRATIVE_SECRET=tok-goose /);
  });

  it("omits the secret when absent", () => {
    const arg = buildGooseExtensionArg("goose-xyz");
    assert.match(arg, /^BRANE_NARRATIVE_ID=goose-xyz /);
    assert.ok(!arg.includes("BRANE_NARRATIVE_SECRET"));
  });
});
