/**
 * The presence gate (src/daemon/presence-gate.ts): which callers and acts it
 * holds, and how it behaves while a prompt is up. Every prompt here is a
 * fake `confirm`, so nothing appears on anyone's screen.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.js";
import { DbTokenStore } from "../db/tokens.js";
import { TokenRing, hashToken } from "../daemon/token-ring.js";
import {
  PRESENCE_PROMPTS,
  PresenceGate,
  gateStanding,
  revokeSignsOutDevice,
  type ConfirmPresence,
  type PendingPresence,
} from "../daemon/presence-gate.js";
import { parseMintBody, planRevoke, revokeTokenRoute } from "../daemon/token-routes.js";
import { cancelPresenceRoute, gatedMintRoute, gatedRemoteMintRoute, gatedRevokeRoute, gatedRotateRoute, type Caller } from "../daemon/gated-routes.js";
import type { TokenRecord } from "../daemon/token-ring.js";
import type { PresenceResult } from "../presence.js";
import { announcePresenceWait, presenceWaitNote } from "../commands/meld.js";

const T0 = Date.UTC(2026, 9, 5, 12);

/** A `confirm` the test answers by hand, recording what it was asked. */
function manualConfirm() {
  const asked: Array<{ reason: string; timeoutMs: number; signal: AbortSignal; answer: (r: PresenceResult) => void }> = [];
  const confirm: ConfirmPresence = (reason, { timeoutMs, signal }) =>
    new Promise((resolve) => {
      asked.push({ reason, timeoutMs, signal, answer: resolve });
      // As runPlan does: an abort kills the helper and reports `aborted`.
      signal.addEventListener("abort", () => resolve({ ok: false, method: "macos-local-auth", reason: "aborted" }), { once: true });
    });
  return { asked, confirm };
}

function gate(confirm: ConfirmPresence, clock = { t: T0 }) {
  const changes: Array<PendingPresence | null> = [];
  const lines: string[] = [];
  const g = new PresenceGate({
    confirm,
    now: () => clock.t,
    timeoutMs: 45_000,
    cooldownMs: 15_000,
    onChange: (p) => changes.push(p),
    log: (l) => lines.push(l),
  });
  return { g, changes, lines, clock };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("who the gate holds", () => {
  it("asks this machine's shell, refuses an agent unasked, and lets a device by", () => {
    assert.equal(gateStanding({ kind: "local" }), "ask");
    assert.equal(gateStanding({ kind: "agent" }), "refuse");
    assert.equal(gateStanding({ kind: "device" }), "pass");
  });

  it("gates a revoke only when it signs out a device", () => {
    const db = createTestDb();
    const store = new DbTokenStore(db);
    const phone = store.insert(hashToken("phone"), "device", "phone", T0);
    const agent = store.insert(hashToken("agent"), "agent", "agent", T0);
    assert.equal(revokeSignsOutDevice(store, [phone.id]), true);
    assert.equal(revokeSignsOutDevice(store, [agent.id]), false);
    assert.equal(revokeSignsOutDevice(store, [agent.id, phone.id]), true);
    assert.equal(revokeSignsOutDevice(store, ["no-such-id"]), false);
  });

  it("words each prompt itself, the same every time", () => {
    assert.deepEqual(PRESENCE_PROMPTS, {
      meld: "add a device to brane",
      "meld-remote": "add a device to brane on another machine",
      "revoke-device": "sign out a device from brane",
      rotate: "sign out every other device from brane",
      enroll: "add a passkey or security key to brane",
    });
  });
});

describe("the presence gate", () => {
  it("lets an approved act through, announcing the prompt while it is up", async () => {
    const { asked, confirm } = manualConfirm();
    const { g, changes, lines } = gate(confirm);
    const outcome = g.check("meld", "this machine (daemon.sock)");
    await tick();
    assert.equal(asked.length, 1);
    assert.equal(asked[0].reason, "add a device to brane");
    assert.equal(asked[0].timeoutMs, 45_000);
    assert.deepEqual(g.current(), {
      id: "presence-1",
      act: "meld",
      prompt: "add a device to brane",
      by: "this machine (daemon.sock)",
      startedAt: T0,
      expiresAt: T0 + 45_000,
    });
    asked[0].answer({ ok: true, method: "macos-local-auth" });
    assert.deepEqual(await outcome, { ok: true });
    assert.equal(g.current(), null);
    assert.equal(changes.length, 2);
    assert.equal(changes[0]?.id, "presence-1");
    assert.equal(changes[1], null);
    assert.deepEqual(lines, ["[presence] meld for this machine (daemon.sock): approved (macos-local-auth)"]);
  });

  it("refuses a second request while a prompt is up, without queueing it", async () => {
    const { asked, confirm } = manualConfirm();
    const { g } = gate(confirm);
    const first = g.check("meld", "a");
    await tick();
    const second = await g.check("rotate", "b");
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.status, 409);
    assert.equal(second.ok === false && second.reason, "busy");
    assert.equal(asked.length, 1, "no second prompt was raised");
    // It names the prompt that is up and who asked, which may not be you.
    assert.match(second.ok === false ? second.error : "", /\("add a device to brane", asked by a\)/);
    assert.match(second.ok === false ? second.error : "", /If you did not start it/);
    asked[0].answer({ ok: true, method: "macos-local-auth" });
    assert.deepEqual(await first, { ok: true });
  });

  it("cools down after a prompt that was not approved, then asks again", async () => {
    const { asked, confirm } = manualConfirm();
    const { g, clock } = gate(confirm);
    const first = g.check("meld", "a");
    await tick();
    asked[0].answer({ ok: false, method: "macos-local-auth", reason: "canceled" });
    const refused = await first;
    assert.equal(refused.ok === false && refused.status, 403);
    assert.equal(refused.ok === false && refused.reason, "canceled");

    clock.t += 5_000;
    const cooling = await g.check("meld", "a");
    assert.equal(cooling.ok === false && cooling.status, 429);
    assert.equal(cooling.ok === false && cooling.retryAfterMs, 10_000);
    assert.equal(asked.length, 1);

    clock.t += 10_000;
    const again = g.check("meld", "a");
    await tick();
    assert.equal(asked.length, 2);
    asked[1].answer({ ok: true, method: "macos-local-auth" });
    assert.deepEqual(await again, { ok: true });
  });

  it("cools down after a timeout too", async () => {
    const { asked, confirm } = manualConfirm();
    const { g } = gate(confirm);
    const first = g.check("rotate", "a");
    await tick();
    asked[0].answer({ ok: false, method: "macos-local-auth", reason: "timeout" });
    assert.equal((await first).ok, false);
    const next = await g.check("rotate", "a");
    assert.equal(next.ok === false && next.reason, "cooldown");
  });

  it("does not cool down when nothing could be shown", async () => {
    const { asked, confirm } = manualConfirm();
    const { g } = gate(confirm);
    const first = g.check("meld", "a");
    await tick();
    asked[0].answer({ ok: false, method: null, reason: "unavailable", detail: "linux" });
    const refused = await first;
    assert.equal(refused.ok === false && refused.reason, "unavailable");
    assert.match(refused.ok === false ? refused.error : "", /cannot show a presence prompt \(linux\)/);
    const next = g.check("meld", "a");
    await tick();
    assert.equal(asked.length, 2, "asked again at once");
    asked[1].answer({ ok: true, method: "macos-local-auth" });
    await next;
  });

  it("closes the prompt when the asker withdraws, and cools down: giving up and asking again is the loop", async () => {
    const { asked, confirm } = manualConfirm();
    const { g } = gate(confirm);
    const request = new AbortController();
    const first = g.check("meld", "a", request.signal);
    await tick();
    request.abort();
    const refused = await first;
    assert.equal(refused.ok === false && refused.reason, "aborted");
    assert.equal(asked[0].signal.aborted, true, "the helper's signal fired");
    assert.equal(g.current(), null);
    const next = await g.check("meld", "a");
    assert.equal(next.ok === false && next.reason, "cooldown");
    assert.equal(asked.length, 1);
  });

  it("never prompts for a request already withdrawn", async () => {
    const { asked, confirm } = manualConfirm();
    const { g } = gate(confirm);
    const request = new AbortController();
    request.abort();
    const refused = await g.check("meld", "a", request.signal);
    assert.equal(refused.ok === false && refused.reason, "aborted");
    assert.equal(asked.length, 0);
  });

  it("lets any client cancel the prompt by its id, and only that prompt", async () => {
    const { asked, confirm } = manualConfirm();
    const { g } = gate(confirm);
    const first = g.check("meld", "a");
    await tick();
    assert.equal(g.cancel("presence-0"), false, "a stale id closes nothing");
    assert.equal(asked[0].signal.aborted, false);
    assert.equal(g.cancel("presence-1"), true);
    const refused = await first;
    assert.equal(refused.ok === false && refused.reason, "remote-cancel");
    assert.equal(g.cancel(), false, "nothing left to cancel");
    // A canceled prompt counts as declined.
    assert.equal((await g.check("meld", "a")).ok === false, true);
  });

  it("logs an attempt refused without a prompt, and leaves the gate free", async () => {
    const { asked, confirm } = manualConfirm();
    const { g, lines, changes } = gate(confirm);
    g.refuse("meld", "agent claude-aaaaaaaa", "an agent's token");
    assert.deepEqual(lines, ["[presence] meld for agent claude-aaaaaaaa: refused: an agent's token"]);
    assert.deepEqual(changes, [], "no prompt opened");
    // No cooldown: nothing was shown, so the shell is asked at once.
    const next = g.check("meld", "a");
    await tick();
    assert.equal(asked.length, 1);
    asked[0].answer({ ok: true, method: "macos-local-auth" });
    await next;
  });

  it("calls a confirm that throws a failure, and still closes the prompt", async () => {
    const { g, changes } = gate(() => Promise.reject(new Error("boom")));
    const refused = await g.check("meld", "a");
    assert.equal(refused.ok === false && refused.reason, "failed");
    assert.equal(g.current(), null);
    assert.equal(changes.at(-1), null);
  });
});

describe("the routes check before they ask", () => {
  it("parses a mint body without minting", () => {
    assert.deepEqual(parseMintBody('{"label":"ipad\\nforged"}', T0), { label: "ipad forged" });
    assert.deepEqual(parseMintBody("", T0), { label: "melded 2026-10-05" });
    assert.deepEqual(parseMintBody("[1]", T0), { error: "Body must be a JSON object" });
    assert.deepEqual(parseMintBody("{", T0), { error: "Body must be a JSON object" });
  });

  it("plans a revoke without doing it, refusing what the revoke would", () => {
    const db = createTestDb();
    const store = new DbTokenStore(db);
    const ring = new TokenRing(store, () => "unused");
    const local = store.insert(hashToken("local"), "local", "this machine", T0);
    const phone = store.insert(hashToken("phone"), "device", "phone", T0 + 1);
    assert.equal((planRevoke(store, local, "no-such-id") as { status: number }).status, 404);
    assert.equal((planRevoke(store, phone, local.id) as { status: number }).status, 400);
    assert.equal((planRevoke(store, phone, phone.id) as { status: number }).status, 409);
    const plan = planRevoke(store, local, phone.id);
    assert.ok(!("status" in plan));
    assert.deepEqual(plan.ids, [phone.id]);
    assert.ok(store.get(phone.id), "planning revoked nothing");
    assert.equal(revokeTokenRoute(store, ring, local, phone.id, T0 + 2).status, 200);
    // The revoke re-checks: what was planned is gone now.
    assert.equal(revokeTokenRoute(store, ring, local, phone.id, T0 + 3).status, 404);
  });
});

describe("the CLI's waiting line", () => {
  it("is not printed in an agent's session, which the daemon refuses unasked", () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      announcePresenceWait({ BRANE_NARRATIVE_SECRET: "s" });
      assert.deepEqual(lines, []);
      announcePresenceWait({});
      assert.equal(lines.length, 1);
    } finally {
      console.error = orig;
    }
  });

  it("names the prompt this machine shows", () => {
    assert.match(presenceWaitNote("darwin"), /Touch ID/);
    assert.match(presenceWaitNote("win32"), /Windows Hello/);
    assert.match(presenceWaitNote("linux"), /authentication prompt/);
  });
});

describe("the gated routes", () => {
  const T = () => T0;
  function setup() {
    const db = createTestDb();
    const store = new DbTokenStore(db);
    const ring = new TokenRing(store, () => "minted-token");
    const local = store.insert(hashToken("local"), "local", "this machine", T0);
    const phone = store.insert(hashToken("phone"), "device", "phone", T0 + 1);
    const agent = store.insert(hashToken("agent"), "agent", "claude-aaaaaaaa", T0 + 2);
    const as = (record: TokenRecord): Caller => ({ record, by: record.label });
    return { store, ring, local, phone, agent, as };
  }
  /** A gate that records what it was asked and answers `ok`, after `during`. */
  function fakeGate(ok: boolean, during: () => void = () => {}) {
    const asked: string[] = [];
    const refused: string[] = [];
    return {
      asked,
      refused,
      refuse: (act: string, by: string, why: string) => void refused.push(`${act} for ${by}: ${why}`),
      check: async (act: string) => {
        asked.push(act);
        during();
        return ok
          ? ({ ok: true } as const)
          : ({ ok: false, status: 403, reason: "canceled", error: "declined" } as const);
      },
      cancel: (id?: string) => id === "presence-1",
    };
  }

  it("never asks a device", async () => {
    const { ring, store, phone, as } = setup();
    const gate = fakeGate(false);
    assert.equal((await gatedMintRoute({ gate, ring }, as(phone), "{}", undefined, T)).status, 200);
    const laptop = store.insert(hashToken("laptop"), "device", "laptop", T0 + 3);
    assert.equal((await gatedRevokeRoute({ gate, ring, store }, as(phone), laptop.id, [], undefined, T)).status, 200);
    assert.equal((await gatedRotateRoute({ gate, ring }, as(phone))).status, 200);
    assert.deepEqual(gate.asked, []);
  });

  it("asks this machine before minting", async () => {
    const { ring, local, as } = setup();
    const gate = fakeGate(false);
    const refused = await gatedMintRoute({ gate, ring }, as(local), "{}", undefined, T);
    assert.deepEqual(refused, { status: 403, body: { error: "declined", presence: "canceled" } });
    assert.deepEqual(gate.asked, ["meld"]);
    assert.equal((await gatedMintRoute({ gate: fakeGate(true), ring }, as(local), "{}", undefined, T)).status, 200);
  });

  it("refuses an agent every gated act without raising a prompt, even one that would be approved", async () => {
    const { ring, store, phone, agent, as } = setup();
    const gate = fakeGate(true);
    const mint = await gatedMintRoute({ gate, ring }, as(agent), "{}", undefined, T);
    assert.equal(mint.status, 403);
    assert.deepEqual((mint.body as { presence: string }).presence, "agent");
    assert.match((mint.body as { error: string }).error, /An agent cannot add a device/);
    const revoke = await gatedRevokeRoute({ gate, ring, store }, as(agent), phone.id, [], undefined, T);
    assert.equal(revoke.status, 403);
    assert.ok(store.get(phone.id), "nothing was revoked");
    assert.equal((await gatedRotateRoute({ gate, ring }, as(agent))).status, 403);
    assert.deepEqual(gate.asked, [], "no prompt was ever raised");
    // But each attempt is recorded, as one that was asked would be.
    assert.deepEqual(gate.refused, [
      "meld for claude-aaaaaaaa: an agent's token",
      "revoke-device for claude-aaaaaaaa: an agent's token",
      "rotate for claude-aaaaaaaa: an agent's token",
    ]);
    // Stopping an agent is still an agent's to do.
    const other = store.insert(hashToken("other-agent"), "agent", "claude-bbbbbbbb", T0 + 4);
    assert.equal((await gatedRevokeRoute({ gate, ring, store }, as(agent), other.id, [], undefined, T)).status, 200);
  });

  it("asks this machine before minting for a remote daemon, and stores nothing", async () => {
    const { store, local, phone, agent, as } = setup();
    const before = store.list(T0).length;
    const mint = () => ({ token: "remote-token", hash: hashToken("remote-token") });
    const declined = fakeGate(false);
    assert.deepEqual(await gatedRemoteMintRoute({ gate: declined, mint }, as(local)), {
      status: 403,
      body: { error: "declined", presence: "canceled" },
    });
    assert.deepEqual(declined.asked, ["meld-remote"]);
    const approved = fakeGate(true);
    assert.deepEqual(await gatedRemoteMintRoute({ gate: approved, mint }, as(local)), {
      status: 200,
      body: { token: "remote-token", hash: hashToken("remote-token") },
    });
    // A device is never asked; an agent is refused unasked.
    const gate = fakeGate(false);
    assert.equal((await gatedRemoteMintRoute({ gate, mint }, as(phone))).status, 200);
    const refused = await gatedRemoteMintRoute({ gate, mint }, as(agent));
    assert.equal(refused.status, 403);
    assert.match((refused.body as { error: string }).error, /An agent cannot add a device to a remote daemon/);
    assert.deepEqual(gate.asked, []);
    assert.equal(store.list(T0).length, before, "no row was written");
  });

  it("refuses a bad mint body without asking", async () => {
    const { ring, local, as } = setup();
    const gate = fakeGate(true);
    assert.equal((await gatedMintRoute({ gate, ring }, as(local), "[1]", undefined, T)).status, 400);
    assert.deepEqual(gate.asked, []);
  });

  it("asks before signing out a device, never before stopping an agent", async () => {
    const { ring, store, local, phone, agent, as } = setup();
    const gate = fakeGate(false);
    assert.equal((await gatedRevokeRoute({ gate, ring, store }, as(local), agent.id, [], undefined, T)).status, 200);
    assert.deepEqual(gate.asked, []);
    assert.equal((await gatedRevokeRoute({ gate, ring, store }, as(local), phone.id, [], undefined, T)).status, 403);
    assert.deepEqual(gate.asked, ["revoke-device"]);
    assert.ok(store.get(phone.id), "a declined revoke revoked nothing");
  });

  it("refuses what the revoke would refuse, without asking", async () => {
    const { ring, store, local, as } = setup();
    const gate = fakeGate(true);
    assert.equal((await gatedRevokeRoute({ gate, ring, store }, as(local), "no-such-id", [], undefined, T)).status, 404);
    assert.equal((await gatedRevokeRoute({ gate, ring, store }, as(local), local.id, [], undefined, T)).status, 400);
    assert.deepEqual(gate.asked, []);
  });

  it("checks the revoke again after the prompt", async () => {
    const { ring, store, local, phone, as } = setup();
    // The row goes while the prompt is up — revoked from the app, say.
    const gate = fakeGate(true, () => store.revoke([phone.id], T0 + 5));
    const answer = await gatedRevokeRoute({ gate, ring, store }, as(local), phone.id, [], undefined, T);
    assert.deepEqual(gate.asked, ["revoke-device"]);
    assert.equal(answer.status, 404);
  });

  it("never begins a rotation, or signs anyone out, when refused: a pending rotation survives", async () => {
    const { local, phone, agent, as } = setup();
    let begun = 0;
    let signedOut = 0;
    const ring = {
      beginRotation: () => {
        begun++;
        return { token: "new", expiresAt: T0 + 60_000, replaced: begun > 1 };
      },
      signOutDevices: () => {
        signedOut++;
        return { ids: ["d1", "d2", "x1"], devices: 2, replaced: false };
      },
    };
    const declined = fakeGate(false);
    assert.equal((await gatedRotateRoute({ gate: declined, ring }, as(local))).status, 403);
    assert.deepEqual([begun, signedOut], [0, 0], "a declined rotate reached neither");
    const forAgent = fakeGate(true);
    assert.equal((await gatedRotateRoute({ gate: forAgent, ring }, as(agent))).status, 403);
    assert.deepEqual(forAgent.asked, [], "an agent is refused unasked");
    assert.deepEqual([begun, signedOut], [0, 0]);
    // A device begins the two-step rotation, unasked.
    const forDevice = fakeGate(true);
    const begunAnswer = await gatedRotateRoute({ gate: forDevice, ring }, as(phone));
    assert.deepEqual(begunAnswer.body, { token: "new", expires_at: T0 + 60_000, replaced: false });
    assert.deepEqual(forDevice.asked, []);
    assert.deepEqual([begun, signedOut], [1, 0]);
  });

  it("signs every device out in the shell's one request, once approved, and hands back no token", async () => {
    const { local, as } = setup();
    const ring = {
      beginRotation: () => assert.fail("this account holds no token to rotate"),
      signOutDevices: () => ({ ids: ["d1", "d2", "x1"], devices: 2, replaced: true }),
    };
    const gate = fakeGate(true);
    const answer = await gatedRotateRoute({ gate, ring }, as(local));
    assert.deepEqual(gate.asked, ["rotate"]);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { signed_out: 2, replaced: true });
    assert.deepEqual(answer.signedOut?.ids, ["d1", "d2", "x1"], "what the server closes the sockets of");
  });

  it("lets only a device cancel a prompt", () => {
    const { local, phone, agent } = setup();
    const gate = fakeGate(true);
    assert.equal(cancelPresenceRoute(gate, local, "presence-1").status, 403);
    assert.equal(cancelPresenceRoute(gate, agent, "presence-1").status, 403);
    assert.deepEqual(cancelPresenceRoute(gate, phone, "presence-1"), { status: 200, body: { canceled: true } });
    assert.deepEqual(cancelPresenceRoute(gate, phone, "presence-0"), { status: 200, body: { canceled: false } });
  });

  it("passes the cooldown on as Retry-After", async () => {
    const { ring, local, as } = setup();
    const gate = {
      check: async () => ({ ok: false, status: 429, reason: "cooldown", retryAfterMs: 9_500, error: "wait" }) as const,
      refuse: () => {},
    };
    const answer = await gatedMintRoute({ gate, ring }, as(local), "{}", undefined, T);
    assert.equal(answer.status, 429);
    assert.equal(answer.retryAfterMs, 9_500);
  });
});
