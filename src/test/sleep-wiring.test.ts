import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviveKeepingLauncher } from "../daemon/server.js";
import { ManifestRestorer, Sleeper, carryManifest, readSleepManifest, restoresOnConnect, sleepActAnswer, writeSleepManifest } from "../daemon/sleep.js";
import { mintAgentToken } from "../db/tokens.js";
import { createTestDb } from "./helpers.js";

/** The parts of server.ts the sleep work wires together, without a daemon
 *  (claude-46sy2xmw:8, finding 4). */
describe("boot revive keeps the launcher", () => {
  function narrative(db: ReturnType<typeof createTestDb>, id: string, launchedBy: string | null) {
    db.prepare(
      "INSERT INTO narratives (id, brane_id, agent_type, role, status, fold_path, created_at, launched_by) VALUES (?, 'brane-test', 'claude', 'worker', 'ended', '/tmp', ?, ?)",
    ).run(id, Date.now(), launchedBy);
  }
  const minted = (db: ReturnType<typeof createTestDb>, nid: string) =>
    db.prepare("SELECT minted_by FROM tokens WHERE kind = 'agent' AND owner_nid = ? AND revoked_at IS NULL").get(nid) as { minted_by: string | null };

  it("on the revived narrative's new agent token, so revoking that device still cascades", () => {
    const db = createTestDb();
    narrative(db, "claude-aaaaaaaa", "device-1");
    const result = reviveKeepingLauncher(db, "claude-aaaaaaaa", "woke", (d, nid) => {
      mintAgentToken(d, nid);
      return { status: "revived", nid, agent: "claude" };
    });
    assert.equal(result.nid, "claude-aaaaaaaa");
    assert.equal(minted(db, "claude-aaaaaaaa").minted_by, "device-1");
  });

  it("on a twin, when the revive continued the narrative in another", () => {
    const db = createTestDb();
    narrative(db, "claude-aaaaaaaa", "device-1");
    narrative(db, "claude-bbbbbbbb", null);
    reviveKeepingLauncher(db, "claude-aaaaaaaa", "woke", (d) => {
      mintAgentToken(d, "claude-bbbbbbbb");
      return { status: "continued", nid: "claude-bbbbbbbb", agent: "claude" };
    });
    const row = db.prepare("SELECT launched_by FROM narratives WHERE id = 'claude-bbbbbbbb'").get() as { launched_by: string | null };
    assert.equal(row.launched_by, "device-1");
    assert.equal(minted(db, "claude-bbbbbbbb").minted_by, "device-1");
  });

  it("and invents none for a narrative nobody's device launched", () => {
    const db = createTestDb();
    narrative(db, "claude-aaaaaaaa", null);
    reviveKeepingLauncher(db, "claude-aaaaaaaa", "woke", (d, nid) => {
      mintAgentToken(d, nid);
      return { status: "revived", nid, agent: "claude" };
    });
    assert.equal(minted(db, "claude-aaaaaaaa").minted_by, null);
  });
});

describe("POST /api/sleep's answer", () => {
  it("is 202 naming the agents it will record, then 409 once the sleep is under way", async () => {
    const shutdowns: number[] = [];
    const sleeper = new Sleeper({
      braneDir: createTmpDir(),
      liveNarratives: () => [
        { id: "claude-aaaaaaaa", role: "worker" },
        { id: "zsh-00000001", role: "utility" },
      ],
      idleMinutes: () => null,
      bootRevive: () => true,
      tailscaleDown: () => false,
      shutdown: () => void shutdowns.push(1),
    });
    assert.deepEqual(sleepActAnswer(sleeper), { status: 202, body: { ok: true, narratives: ["claude-aaaaaaaa"] } });
    const running = sleeper.sleep("operator");
    assert.equal(sleepActAnswer(sleeper).status, 409);
    await running;
    assert.equal(shutdowns.length, 1);
  });
});

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "brane-sleep-wiring-"));
}

describe("the manifest is restored by an operator connecting, not by a wake", () => {
  it("counts a melded device or this machine's own client, never an agent's token", () => {
    assert.equal(restoresOnConnect("device"), true);
    assert.equal(restoresOnConnect("local"), true);
    assert.equal(restoresOnConnect("agent"), false);
  });

  it("runs once, on the first operator connection, and not while the host is going back to sleep", () => {
    let runs = 0;
    let sleeping = false;
    const r = new ManifestRestorer(async () => void runs++, () => sleeping);
    assert.equal(r.onConnect("agent"), false);
    assert.equal(runs, 0, "a wake and an agent's bridge restore nothing");
    sleeping = true;
    assert.equal(r.onConnect("device"), false);
    sleeping = false;
    assert.equal(r.onConnect("device"), true);
    assert.equal(r.onConnect("device"), false);
    assert.equal(r.onConnect("local"), false);
    assert.equal(runs, 1);
  });
});

describe("a wake nobody follows keeps the waiting manifest", () => {
  it("the idle sleep after it carries the earlier sleep's agents over, with its time and reason", async () => {
    const dir = createTmpDir();
    writeSleepManifest(dir, { slept_at: 1_000, reason: "operator", narratives: ["claude-aaaaaaaa"], host: "h" });
    const sleeper = new Sleeper({
      braneDir: dir,
      liveNarratives: () => [],
      idleMinutes: () => null,
      bootRevive: () => true,
      tailscaleDown: () => false,
      shutdown: () => {},
    });
    await sleeper.sleep("idle");
    const kept = readSleepManifest(dir)!;
    assert.deepEqual([kept.slept_at, kept.reason, kept.narratives], [1_000, "operator", ["claude-aaaaaaaa"]]);
  });

  it("joins anything live now, once each", () => {
    const waiting = { slept_at: 1, reason: "operator" as const, narratives: ["a", "b"], host: "h" };
    const next = { slept_at: 9, reason: "idle" as const, narratives: ["b", "c"], host: "h2" };
    assert.deepEqual(carryManifest(waiting, next), { slept_at: 1, reason: "operator", narratives: ["a", "b", "c"], host: "h2" });
    assert.deepEqual(carryManifest(null, next), next);
    assert.deepEqual(carryManifest({ ...waiting, narratives: [] }, next), next);
  });
});
