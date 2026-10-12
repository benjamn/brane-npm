/**
 * The Devices list: where each token was first presented from, the list
 * itself, and revoking one device. The store tests run on a real (test)
 * database because the sighting is a column the migration ladder adds.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.js";
import { DbTokenStore, adoptBindTokens, legacyTokenWarning, mintAgentToken, normalizeRemoteAddr, recordLauncher, verifyAgentToken } from "../db/tokens.js";
import { TokenRing, UNUSED_TOKEN_LAPSE_MS, WS_CLOSE_TOKEN_ROTATED, hashToken } from "../daemon/token-ring.js";
import { closeSocketsOf, closesOnRevoke, listTokensRoute, mintDeviceTokenRoute, revokeTokenRoute, socketOwners } from "../daemon/token-routes.js";
import { resolveMcpBind } from "../daemon/server.js";
import { buildDaemonEnv } from "../commands/daemon.js";
import { INHERITED_AGENT_ENV, unsetAgentEnvPrefix } from "../agent-env.js";
import { newSessionLine, newTmuxSession, tmuxQuote } from "../tmux.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeUserAgent } from "../user-agent.js";
import { formatTokenList } from "../commands/token.js";

const T0 = Date.UTC(2026, 9, 3, 12);
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

function setup() {
  const db = createTestDb();
  const store = new DbTokenStore(db);
  const queue: string[] = [];
  const ring = new TokenRing(store, () => queue.shift() ?? "unexpected-mint");
  const local = store.insert(hashToken("local"), "local", "this machine", T0);
  const phone = store.insert(hashToken("phone"), "device", "phone", T0 + 1);
  const laptop = store.insert(hashToken("laptop"), "device", "laptop", T0 + 2);
  const row = (id: string) =>
    db.prepare("SELECT user_agent, remote_addr, revoked_at FROM tokens WHERE id = ?").get(id) as {
      user_agent: string | null;
      remote_addr: string | null;
      revoked_at: number | null;
    };
  return { db, store, ring, queue, local, phone, laptop, row };
}

describe("a token's first sighting", () => {
  it("is recorded on first presentation and never overwritten", () => {
    const { ring, phone, row } = setup();
    ring.authenticate("phone", T0 + 1, { userAgent: IPHONE_SAFARI, remoteAddr: "::ffff:100.101.1.2" });
    assert.deepEqual(
      { ...row(phone.id), revoked_at: undefined },
      { user_agent: IPHONE_SAFARI, remote_addr: "100.101.1.2", revoked_at: undefined },
    );
    // Someone else presenting the same token later does not rename the row.
    ring.authenticate("phone", T0 + 2, { userAgent: MAC_CHROME, remoteAddr: "192.168.1.9" });
    assert.equal(row(phone.id).user_agent, IPHONE_SAFARI);
    assert.equal(row(phone.id).remote_addr, "100.101.1.2");
  });

  it("survives a restart: a new store does not overwrite what an old one wrote", () => {
    const { db, phone, row } = setup();
    new DbTokenStore(db).find(hashToken("phone"), T0 + 1, { userAgent: IPHONE_SAFARI });
    new DbTokenStore(db).find(hashToken("phone"), T0 + 2, { userAgent: MAC_CHROME });
    assert.equal(row(phone.id).user_agent, IPHONE_SAFARI);
  });

  it("is written by a later request when the first one carried nothing", () => {
    const { ring, phone, row } = setup();
    ring.authenticate("phone", T0 + 1, {});
    ring.authenticate("phone", T0 + 2, { userAgent: IPHONE_SAFARI });
    assert.equal(row(phone.id).user_agent, IPHONE_SAFARI);
  });

  it("strips control characters, so a header cannot forge a line in the list", () => {
    const { ring, phone, row } = setup();
    ring.authenticate("phone", T0 + 1, { userAgent: "evil\nlocal  this machine" });
    assert.equal(row(phone.id).user_agent, "evil local  this machine");
  });

  it("is carried by a rotation's replacement, which is the requester's device", () => {
    const { ring, queue, phone, store } = setup();
    queue.push("phone-2");
    ring.beginRotation(phone, T0 + 1);
    const auth = ring.authenticate("phone-2", T0 + 2, { userAgent: IPHONE_SAFARI, remoteAddr: "100.101.1.2" });
    assert.ok(auth.ok);
    const listed = store.get(auth.record.id);
    assert.equal(listed?.user_agent, IPHONE_SAFARI);
    assert.equal(listed?.remote_addr, "100.101.1.2");
  });

  it("normalizes a v4-mapped address, and leaves real IPv6 alone", () => {
    assert.equal(normalizeRemoteAddr("::ffff:127.0.0.1"), "127.0.0.1");
    assert.equal(normalizeRemoteAddr("fd7a:115c:a1e0::1"), "fd7a:115c:a1e0::1");
    assert.equal(normalizeRemoteAddr(undefined), null);
  });
});

describe("GET /api/tokens", () => {
  it("lists every live token, marks the requester, and names the device", () => {
    const { ring, store, local, phone, laptop } = setup();
    ring.authenticate("phone", T0 + 1, { userAgent: IPHONE_SAFARI });
    const { body } = listTokensRoute(store, phone, T0 + 2);
    assert.deepEqual(body.tokens.map((t) => t.id), [local.id, phone.id, laptop.id]);
    const me = body.tokens.find((t) => t.id === phone.id)!;
    assert.equal(me.current, true);
    assert.equal(me.device, "Safari on iPhone");
    assert.equal(body.tokens.find((t) => t.id === laptop.id)!.current, false);
  });

  it("shows an unscanned QR with its deadline, and drops it once it has lapsed", () => {
    const { store, phone } = setup();
    const qr = store.insert(hashToken("qr"), "device", "melded", T0);
    const before = listTokensRoute(store, phone, T0 + 1).body.tokens.find((t) => t.id === qr.id);
    assert.equal(before?.unused, true);
    assert.equal(before?.expires_at, T0 + UNUSED_TOKEN_LAPSE_MS);
    const after = listTokensRoute(store, phone, T0 + UNUSED_TOKEN_LAPSE_MS).body.tokens;
    assert.equal(after.some((t) => t.id === qr.id), false);
  });

  it("leaves revoked rows out", () => {
    const { store, phone, laptop } = setup();
    store.revoke([laptop.id], T0 + 1);
    assert.equal(listTokensRoute(store, phone, T0 + 2).body.tokens.some((t) => t.id === laptop.id), false);
  });
});

describe("POST /api/tokens/:id/revoke", () => {
  it("revokes another device, which then stops authenticating", () => {
    const { ring, store, phone, laptop, row } = setup();
    const res = revokeTokenRoute(store, ring, phone, laptop.id, T0 + 1);
    assert.equal(res.status, 200);
    assert.equal(res.status === 200 && res.body.kind, "device", "the log names the kind it revoked");
    assert.equal(row(laptop.id).revoked_at, T0 + 1);
    assert.equal(ring.authenticate("laptop", T0 + 2).ok, false);
    assert.equal(ring.authenticate("phone", T0 + 2).ok, true, "the requester is untouched");
  });

  it("works from this account too (the CLI)", () => {
    const { ring, store, local, laptop } = setup();
    assert.equal(revokeTokenRoute(store, ring, local, laptop.id, T0 + 1).status, 200);
  });

  it("refuses this machine's own row, the requester's own, and an id that is not live", () => {
    const { ring, store, local, phone, laptop, row } = setup();
    assert.equal(revokeTokenRoute(store, ring, phone, local.id, T0 + 1).status, 400);
    assert.equal(revokeTokenRoute(store, ring, phone, phone.id, T0 + 1).status, 409);
    assert.equal(revokeTokenRoute(store, ring, phone, "no-such-id", T0 + 1).status, 404);
    store.revoke([laptop.id], T0 + 1);
    assert.equal(revokeTokenRoute(store, ring, phone, laptop.id, T0 + 2).status, 404, "already revoked");
    assert.equal(row(local.id).revoked_at, null);
    assert.equal(row(phone.id).revoked_at, null);
  });

  it("abandons a rotation the revoked device had begun, so it cannot write itself back in", () => {
    const { ring, store, queue, phone, laptop } = setup();
    queue.push("laptop-2");
    ring.beginRotation(laptop, T0 + 1);
    const res = revokeTokenRoute(store, ring, phone, laptop.id, T0 + 2);
    assert.ok(res.status === 200);
    assert.equal(res.body.abandonedRotation, true);
    // The pending token is dead: confirming it would otherwise have revoked
    // the phone and installed the laptop afresh.
    assert.equal(ring.authenticate("laptop-2", T0 + 3).ok, false);
    assert.equal(ring.authenticate("phone", T0 + 3).ok, true);
  });

  it("leaves someone else's pending rotation alone", () => {
    const { ring, store, queue, phone, laptop } = setup();
    queue.push("phone-2");
    ring.beginRotation(phone, T0 + 1);
    const res = revokeTokenRoute(store, ring, phone, laptop.id, T0 + 2);
    assert.ok(res.status === 200);
    assert.equal(res.body.abandonedRotation, false);
    assert.equal(ring.authenticate("phone-2", T0 + 3).ok, true);
  });
});

describe("closeSocketsOf", () => {
  it("closes exactly the revoked row's sockets, with the signed-out code", () => {
    const closed: Array<[string, number | undefined]> = [];
    const sock = (name: string) => ({ close: (code?: number) => closed.push([name, code]) });
    const a = sock("laptop-tab-1");
    const b = sock("laptop-tab-2");
    const c = sock("phone");
    const sockets = new Map([[a, "laptop"], [b, "laptop"], [c, "phone"]]);
    assert.equal(closeSocketsOf(sockets, ["laptop"]), 2);
    assert.deepEqual(closed, [["laptop-tab-1", WS_CLOSE_TOKEN_ROTATED], ["laptop-tab-2", WS_CLOSE_TOKEN_ROTATED]]);
    assert.deepEqual([...sockets.values()], ["phone"]);
  });
});

describe("describeUserAgent", () => {
  const cases: Array<[string | null, string | null]> = [
    [IPHONE_SAFARI, "Safari on iPhone"],
    [MAC_CHROME, "Chrome on macOS"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1", "Chrome on iPhone"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", "Web app on iPhone"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0", "Firefox on macOS"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0", "Edge on Windows"],
    ["Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36", "Chrome on Android"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15", "Safari on macOS"],
    ["node", "node"],
    ["curl/8.7.1", "curl"],
    ["", null],
    [null, null],
  ];
  for (const [ua, want] of cases) {
    it(`${want ?? "nothing"} for ${JSON.stringify(ua?.slice(0, 40) ?? ua)}`, () => {
      assert.equal(describeUserAgent(ua), want);
    });
  }
});

describe("which app a device runs", () => {
  const MAIN = "https://main.brane.organelle.dev";
  const APEX = "https://brane.organelle.dev";
  const origins = (db: ReturnType<typeof setup>["db"], id: string) =>
    db.prepare("SELECT app_origin, last_app_origin FROM tokens WHERE id = ?").get(id) as {
      app_origin: string | null;
      last_app_origin: string | null;
    };

  it("is recorded from the first request that carries an Origin, and the first is never overwritten", () => {
    const { ring, phone, db } = setup();
    // A same-origin GET carries no Origin: the device is named, the app not yet.
    ring.authenticate("phone", T0 + 1, { userAgent: IPHONE_SAFARI, remoteAddr: "100.101.1.2" });
    assert.deepEqual(origins(db, phone.id), { app_origin: null, last_app_origin: null });
    // The control socket's upgrade carries one. Inside the once-a-minute
    // throttle of the last-seen stamp, so the first write must carry both.
    ring.authenticate("phone", T0 + 2, { userAgent: IPHONE_SAFARI, remoteAddr: "100.101.1.2", origin: MAIN });
    assert.deepEqual(origins(db, phone.id), { app_origin: MAIN, last_app_origin: MAIN });
    // The same token from another copy of the app: the first stands, the latest moves.
    ring.authenticate("phone", T0 + 2 + 60_000, { userAgent: IPHONE_SAFARI, remoteAddr: "100.101.1.2", origin: APEX });
    assert.deepEqual(origins(db, phone.id), { app_origin: MAIN, last_app_origin: APEX });
    // A request with no Origin after that leaves the latest alone.
    ring.authenticate("phone", T0 + 2 + 120_000, { userAgent: IPHONE_SAFARI, remoteAddr: "100.101.1.2" });
    assert.deepEqual(origins(db, phone.id), { app_origin: MAIN, last_app_origin: APEX });
  });

  it("is listed, and shown as a host", () => {
    const { ring, store, local, phone, db } = setup();
    ring.authenticate("phone", T0 + 1, { userAgent: IPHONE_SAFARI, remoteAddr: "100.101.1.2", origin: MAIN });
    const listed = listTokensRoute(store, local, T0 + 2).body.tokens.find((t) => t.id === phone.id)!;
    assert.equal(listed.app_origin, MAIN);
    assert.match(formatTokenList([listed]), /via main\.brane\.organelle\.dev/);
    // A daemon's own bundle is an origin like any other, port included.
    ring.authenticate("laptop", T0 + 1, { userAgent: MAC_CHROME, remoteAddr: "100.101.1.3", origin: "https://mac.tail1234.ts.net:47443" });
    assert.match(formatTokenList(listTokensRoute(store, local, T0 + 2).body.tokens), /via mac\.tail1234\.ts\.net:47443/);
    assert.equal(origins(db, local.id).app_origin, null);
  });

  it("is stored as text a list can show: control characters become spaces, and it is capped", () => {
    const { ring, phone, db } = setup();
    ring.authenticate("phone", T0 + 1, { userAgent: IPHONE_SAFARI, origin: "https://evil.example\r\nX-Forged: row" + "a".repeat(300) });
    const { app_origin } = origins(db, phone.id);
    assert.ok(app_origin && !/[\r\n]/.test(app_origin));
    assert.ok(app_origin.length <= 256);
  });

  it("treats the opaque origin `null` as no origin, so it never names a device", () => {
    // A sandboxed iframe or a file:// page sends the literal `Origin: null`.
    // Stored, it would read "via null" for good, since the first origin is
    // never overwritten; so it must not take the slot a real one would fill.
    const { ring, phone, db } = setup();
    ring.authenticate("phone", T0 + 1, { userAgent: IPHONE_SAFARI, origin: "null" });
    assert.deepEqual(origins(db, phone.id), { app_origin: null, last_app_origin: null });
    ring.authenticate("phone", T0 + 2, { userAgent: IPHONE_SAFARI, origin: MAIN });
    assert.deepEqual(origins(db, phone.id), { app_origin: MAIN, last_app_origin: MAIN });
    ring.authenticate("phone", T0 + 2 + 60_000, { userAgent: IPHONE_SAFARI, origin: "null" });
    assert.deepEqual(origins(db, phone.id), { app_origin: MAIN, last_app_origin: MAIN });
  });

  it("a rotation's replacement takes the origin of the request that confirms it", () => {
    const { store } = setup();
    const replacement = store.insert(hashToken("fresh"), "device", "phone", T0 + 3, {
      used: true,
      seen: { userAgent: IPHONE_SAFARI, remoteAddr: "100.101.1.2", origin: MAIN },
    });
    assert.equal(store.list(T0 + 4).find((t) => t.id === replacement.id)?.app_origin, MAIN);
  });
});

describe("formatTokenList", () => {
  it("puts the id first, and marks this machine, the requester and an unscanned QR", () => {
    const text = formatTokenList([
      { id: "L", kind: "local", label: "this machine", origin: "minted", created_at: T0, last_used_at: T0, device: "node", remote_addr: "127.0.0.1", current: true, unused: false, expires_at: null },
      { id: "Q", kind: "device", label: "melded", origin: "minted", created_at: T0, last_used_at: null, device: null, remote_addr: null, current: false, unused: true, expires_at: T0 + UNUSED_TOKEN_LAPSE_MS },
    ]);
    assert.match(text, /^L {2}this machine \(CLI\) \[this request\]/m);
    assert.match(text, /^Q {2}unknown device \[unscanned, lapses 2026-10-03 12:10Z\]/m);
    assert.match(text, /never used/);
  });
});

describe("which sockets a revoke closes", () => {
  // The regression: a device token can open /ws/mcp, which reaches every MCP
  // tool, and the first version of this list left that socket open after the
  // token was revoked (claude-yxany623:6).
  it("closes a device token's MCP socket along with its control and terminal sockets", () => {
    const device = { id: "d", kind: "device" as const, label: "phone" };
    assert.equal(closesOnRevoke("mcp", device), true);
    assert.equal(closesOnRevoke("control", device), true);
    assert.equal(closesOnRevoke("terminal", device), true);
  });

  it("leaves local MCP bridges alone, but not this account's viewer sockets", () => {
    const local = { id: "l", kind: "local" as const, label: "this machine" };
    assert.equal(closesOnRevoke("mcp", local), false);
    assert.equal(closesOnRevoke("control", local), true);
    assert.equal(closesOnRevoke("terminal", local), true);
  });
});

describe("who added a device", () => {
  it("records the minting token, and names it in the list", () => {
    const { db, ring, store, queue, local, phone } = setup();
    ring.authenticate("phone", T0 + 10, { userAgent: IPHONE_SAFARI });
    queue.push("laptop-2", "tablet");
    const byPhone = mintDeviceTokenRoute(ring, "", T0 + 20, phone);
    const byLocal = mintDeviceTokenRoute(ring, "", T0 + 30, local);
    assert.ok(byPhone.status === 200 && byLocal.status === 200);
    const listed = listTokensRoute(store, phone, T0 + 40).body.tokens;
    assert.equal(listed.find((t) => t.id === byPhone.body.id)?.minted_by_device, "Safari on iPhone");
    assert.equal(listed.find((t) => t.id === byLocal.body.id)?.minted_by_device, "this machine");
    assert.equal(listed.find((t) => t.id === phone.id)?.minted_by_device, null, "not recorded");
    // Still named after the minter is revoked: the join does not require a live row.
    store.revoke([phone.id], T0 + 50);
    assert.equal(listTokensRoute(store, local, T0 + 60).body.tokens.find((t) => t.id === byPhone.body.id)?.minted_by_device, "Safari on iPhone");
    assert.equal((db.prepare("SELECT minted_by FROM tokens WHERE id = ?").get(byPhone.body.id) as { minted_by: string }).minted_by, phone.id);
  });
});

describe("a token presented from somewhere else", () => {
  it("keeps the first sighting, records the latest, and flags the second address", () => {
    const { ring, store, phone } = setup();
    ring.authenticate("phone", T0 + 10, { userAgent: IPHONE_SAFARI, remoteAddr: "100.101.1.2" });
    assert.equal(store.get(phone.id)?.elsewhere_at, null, "one address is not a copy");
    ring.authenticate("phone", T0 + 20, { userAgent: MAC_CHROME, remoteAddr: "100.99.7.7" });
    const row = store.get(phone.id)!;
    assert.equal(row.user_agent, IPHONE_SAFARI, "the first sighting still names the row");
    assert.equal(row.remote_addr, "100.101.1.2");
    assert.equal(row.last_remote_addr, "100.99.7.7");
    assert.equal(row.last_user_agent, MAC_CHROME);
    assert.equal(row.elsewhere_at, T0 + 20, "flagged at once, not on the next minute's stamp");
    const listed = listTokensRoute(store, phone, T0 + 30).body.tokens.find((t) => t.id === phone.id)!;
    assert.equal(listed.device, "Safari on iPhone");
    assert.equal(listed.last_device, "Chrome on macOS");
  });

  it("counts every loopback spelling as one place", () => {
    const { ring, store, phone } = setup();
    ring.authenticate("phone", T0 + 10, { remoteAddr: "::1" });
    ring.authenticate("phone", T0 + 20, { remoteAddr: "127.0.0.1" });
    ring.authenticate("phone", T0 + 120_000, { remoteAddr: "::ffff:127.0.0.1" });
    assert.equal(store.get(phone.id)?.elsewhere_at, null, "the bridge and the CLI on one machine are not a copy");
    ring.authenticate("phone", T0 + 240_000, { remoteAddr: "100.99.7.7" });
    assert.equal(store.get(phone.id)?.elsewhere_at, T0 + 240_000, "another machine still is");
  });

  it("stays flagged once the real device is back on its own address", () => {
    const { ring, store, phone } = setup();
    ring.authenticate("phone", T0 + 10, { remoteAddr: "100.101.1.2" });
    ring.authenticate("phone", T0 + 20, { remoteAddr: "100.99.7.7" });
    ring.authenticate("phone", T0 + 120_000, { remoteAddr: "100.101.1.2" });
    const row = store.get(phone.id)!;
    assert.equal(row.elsewhere_at, T0 + 20);
    assert.equal(row.last_remote_addr, "100.101.1.2");
  });
});

describe("connected", () => {
  it("marks a token with a socket open now", () => {
    const { store, phone, laptop } = setup();
    const listed = listTokensRoute(store, phone, T0 + 10, new Set([laptop.id])).body.tokens;
    assert.equal(listed.find((t) => t.id === laptop.id)?.connected, true);
    assert.equal(listed.find((t) => t.id === phone.id)?.connected, false);
  });
});

describe("cascading revoke", () => {
  // phone added laptop, laptop added tablet; local added watch.
  function tree() {
    const t = setup();
    const laptop2 = t.store.insert(hashToken("laptop2"), "device", "laptop2", T0 + 3, { mintedBy: t.phone.id });
    const tablet = t.store.insert(hashToken("tablet"), "device", "tablet", T0 + 4, { mintedBy: laptop2.id });
    const watch = t.store.insert(hashToken("watch"), "device", "watch", T0 + 5, { mintedBy: t.local.id });
    return { ...t, laptop2, tablet, watch };
  }

  it("finds every device a device added, down the chain", () => {
    const { store, phone, laptop2, tablet } = tree();
    assert.deepEqual(new Set(store.descendants(phone.id)), new Set([laptop2.id, tablet.id]));
  });

  it("walks through a revoked link, but never returns a revoked row", () => {
    const { store, phone, laptop2, tablet } = tree();
    store.revoke([laptop2.id], T0 + 10);
    assert.deepEqual(store.descendants(phone.id), [tablet.id]);
  });

  it("never reaches the requester or anything the requester added", () => {
    const { store, phone, laptop2 } = tree();
    // Revoking the phone from the laptop it added: the laptop, and the tablet
    // the laptop added, stay.
    assert.deepEqual(store.descendants(phone.id, laptop2.id), []);
  });

  it("still cascades when the requester is an ancestor (this machine melded the phone)", () => {
    const t = setup();
    const phone2 = t.store.insert(hashToken("phone2"), "device", "phone2", T0 + 3, { mintedBy: t.local.id });
    const laptop3 = t.store.insert(hashToken("laptop3"), "device", "laptop3", T0 + 4, { mintedBy: phone2.id });
    const other = t.store.insert(hashToken("other"), "device", "other", T0 + 5, { mintedBy: t.local.id });
    assert.deepEqual(t.store.descendants(phone2.id, t.local.id), [laptop3.id]);
    assert.equal(t.store.descendants(phone2.id, t.local.id).includes(other.id), false, "a sibling is not a descendant");
  });

  it("revokes the device and the ones asked for, in one write", () => {
    const { ring, store, local, phone, laptop2, tablet, row } = tree();
    const res = revokeTokenRoute(store, ring, local, phone.id, T0 + 20, [laptop2.id, tablet.id]);
    assert.ok(res.status === 200);
    assert.deepEqual(res.body.ids, [phone.id, laptop2.id, tablet.id]);
    for (const id of res.body.ids) assert.equal(row(id).revoked_at, T0 + 20);
  });

  it("revokes only the checked ones", () => {
    const { ring, store, local, phone, laptop2, tablet, row } = tree();
    assert.equal(revokeTokenRoute(store, ring, local, phone.id, T0 + 20, [tablet.id]).status, 200);
    assert.equal(row(laptop2.id).revoked_at, null, "unchecked: the laptop you trust stays");
    assert.equal(row(tablet.id).revoked_at, T0 + 20);
  });

  it("refuses an id that is not a device this one added, and revokes nothing", () => {
    const { ring, store, local, phone, laptop, watch, row } = tree();
    const res = revokeTokenRoute(store, ring, local, phone.id, T0 + 20, [laptop.id, watch.id]);
    assert.equal(res.status, 400);
    assert.equal(row(phone.id).revoked_at, null);
    assert.equal(row(laptop.id).revoked_at, null);
  });

  it("lists each row's descendants, relative to the requester", () => {
    const { store, local, phone, laptop2, tablet } = tree();
    const fromLocal = listTokensRoute(store, local, T0 + 30).body.tokens;
    assert.deepEqual(new Set(fromLocal.find((t) => t.id === phone.id)!.descendants), new Set([laptop2.id, tablet.id]));
    assert.deepEqual(fromLocal.find((t) => t.id === local.id)!.descendants, [], "the local row is never revoked here");
    const fromLaptop = listTokensRoute(store, laptop2, T0 + 30).body.tokens;
    assert.deepEqual(fromLaptop.find((t) => t.id === phone.id)!.descendants, []);
  });
});

describe("agents a device started", () => {
  it("are listed under the token whose request last launched them", () => {
    const { db, store, phone, laptop } = setup();
    db.prepare("INSERT INTO narratives (id, brane_id, agent_type, created_at, status) VALUES ('claude-aaaaaaaa', 'b', 'claude', ?, 'active')").run(T0);
    db.prepare("INSERT INTO narratives (id, brane_id, agent_type, created_at, status) VALUES ('claude-bbbbbbbb', 'b', 'claude', ?, 'active')").run(T0);
    recordLauncher(db, "claude-aaaaaaaa", phone.id);
    recordLauncher(db, "claude-bbbbbbbb", phone.id);
    // A revive from the laptop makes it the laptop's.
    recordLauncher(db, "claude-bbbbbbbb", laptop.id);
    const listed = listTokensRoute(store, phone, T0 + 10).body.tokens;
    assert.deepEqual(listed.find((t) => t.id === phone.id)!.agents.map((a) => a.id), ["claude-aaaaaaaa"]);
    assert.deepEqual(listed.find((t) => t.id === laptop.id)!.agents.map((a) => a.id), ["claude-bbbbbbbb"]);
  });
});

describe("agent tokens", () => {
  function agentSetup() {
    const t = setup();
    t.db.prepare("INSERT INTO narratives (id, brane_id, agent_type, created_at, status) VALUES ('claude-agent001', 'b', 'claude', ?, 'active')").run(T0);
    const secret = mintAgentToken(t.db, "claude-agent001", T0 + 1);
    const auth = t.ring.authenticate(secret, T0 + 2);
    assert.ok(auth.ok);
    return { ...t, secret, agent: auth.record };
  }

  it("authenticate as an agent bound to its narrative", () => {
    const { agent } = agentSetup();
    assert.equal(agent.kind, "agent");
    assert.equal(agent.ownerNid, "claude-agent001");
  });

  it("are listed, and revoking one closes its bridge", () => {
    const { store, ring, phone, agent, row } = agentSetup();
    const listed = listTokensRoute(store, phone, T0 + 3).body.tokens.find((t) => t.id === agent.id);
    assert.equal(listed?.kind, "agent");
    assert.equal(closesOnRevoke("mcp", agent), true, "an agent's MCP socket is its bridge");
    assert.equal(revokeTokenRoute(store, ring, phone, agent.id, T0 + 4).status, 200);
    assert.equal(row(agent.id).revoked_at, T0 + 4);
  });

  it("are among the tokens revoking the device that launched them can take", () => {
    const { db, store, local, phone, agent } = agentSetup();
    recordLauncher(db, "claude-agent001", phone.id);
    assert.deepEqual(store.descendants(phone.id, local.id), [agent.id]);
  });

  it("never trigger the plaintext-token warning when adopted", () => {
    const db = createTestDb();
    db.prepare("INSERT INTO narratives (id, brane_id, agent_type, created_at, status, bind_token) VALUES ('claude-old00001', 'b', 'claude', 0, 'active', 'plain')").run();
    adoptBindTokens(db);
    assert.equal(legacyTokenWarning(db), null);
  });

  it("are not swept by the unused-token lapse", () => {
    const { store, agent, row } = agentSetup();
    store.lapseUnused(T0 + 365 * 24 * 3600_000);
    assert.equal(row(agent.id).revoked_at, null);
  });
});

describe("review fixes (claude-jrjh1e8w:13)", () => {
  it("an MCP socket belongs to its dialer and to its narrative's agent token", () => {
    const device = { id: "dev", kind: "device" as const, label: "phone" };
    const local = { id: "loc", kind: "local" as const, label: "this machine" };
    const agent = { id: "agt", kind: "agent" as const, label: "claude-x", ownerNid: "claude-x" };
    assert.deepEqual(socketOwners("mcp", device, "agt"), ["dev", "agt"]);
    assert.deepEqual(socketOwners("mcp", local, "agt"), ["agt"]);
    assert.deepEqual(socketOwners("mcp", agent, "agt"), ["agt"]);
    assert.deepEqual(socketOwners("control", device), ["dev"]);
    // And revoking either owner closes it.
    for (const revoked of ["dev", "agt"]) {
      const closed: string[] = [];
      const ws = { close: () => closed.push(revoked) };
      assert.equal(closeSocketsOf(new Map([[ws, socketOwners("mcp", device, "agt")]]), [revoked]), 1);
    }
  });

  it("an external records the token that dialed it, so it is in that token's cascade", () => {
    const { db, store, local, phone } = setup();
    const bind = resolveMcpBind(db, "b", "external-placeholder", undefined, phone.id);
    assert.ok(bind.minted && bind.secret);
    const agentRow = store.list(T0).find((t) => t.kind === "agent" && t.owner_nid === bind.nid)!;
    assert.equal(agentRow.minted_by, phone.id);
    assert.ok(store.descendants(phone.id, local.id).includes(agentRow.id));
  });

  it("a rotation retires externals the retired devices dialed in, not spawned agents, and keeps the requester's", () => {
    const { db, ring, queue, store, phone, laptop, row } = setup();
    const ext = resolveMcpBind(db, "b", "external-p1", undefined, laptop.id);
    const mine = resolveMcpBind(db, "b", "external-p2", undefined, phone.id);
    db.prepare("INSERT INTO narratives (id, brane_id, agent_type, created_at, status) VALUES ('claude-spawned1', 'b', 'claude', ?, 'active')").run(T0);
    mintAgentToken(db, "claude-spawned1", T0);
    recordLauncher(db, "claude-spawned1", laptop.id);
    const idOf = (nid: string) => store.list(T0).find((t) => t.kind === "agent" && t.owner_nid === nid)!.id;
    const [extId, mineId, spawnedId] = [idOf(ext.nid), idOf(mine.nid), idOf("claude-spawned1")];
    queue.push("phone-2");
    ring.beginRotation(phone, T0 + 10);
    const auth = ring.authenticate("phone-2", T0 + 11);
    assert.ok(auth.ok && auth.retired);
    assert.ok(auth.retired.ids.includes(extId), "the laptop's external is out, and its socket closes");
    assert.equal(row(extId).revoked_at, T0 + 11);
    assert.equal(row(spawnedId).revoked_at, null, "a spawned agent is not a device's to lose");
    assert.equal(row(mineId).revoked_at, null, "the requester's own external stays");
    assert.equal(store.get(mineId)?.minted_by, auth.record.id, "re-parented onto the replacement");
  });

  it("this account signing every device out takes the externals they dialed in, not its own or spawned agents", () => {
    const { db, ring, store, local, phone, laptop, row } = setup();
    const theirs = resolveMcpBind(db, "b", "external-s1", undefined, laptop.id);
    const mine = resolveMcpBind(db, "b", "external-s2", undefined, local.id);
    db.prepare("INSERT INTO narratives (id, brane_id, agent_type, created_at, status) VALUES ('claude-spawned2', 'b', 'claude', ?, 'active')").run(T0);
    mintAgentToken(db, "claude-spawned2", T0);
    recordLauncher(db, "claude-spawned2", phone.id);
    const idOf = (nid: string) => store.list(T0).find((t) => t.kind === "agent" && t.owner_nid === nid)!.id;
    const [theirsId, mineId, spawnedId] = [idOf(theirs.nid), idOf(mine.nid), idOf("claude-spawned2")];
    // Both devices have been presented, so each is one someone is signed in on.
    for (const t of ["phone", "laptop"]) ring.authenticate(t, T0 + 3);
    const out = ring.signOutDevices(local, T0 + 10);
    assert.equal(out.devices, 2);
    assert.deepEqual([...out.ids].sort(), [phone.id, laptop.id, theirsId].sort());
    assert.equal(row(theirsId).revoked_at, T0 + 10);
    assert.equal(row(mineId).revoked_at, null, "an external this account dialed in stays");
    assert.equal(row(spawnedId).revoked_at, null, "a spawned agent is not a device's to lose");
    assert.equal(row(local.id).revoked_at, null);
  });

  it("counts the devices that were signed in, not a QR nobody scanned, and revokes both", () => {
    const { ring, store, local, row } = setup();
    // setup()'s phone and laptop have been presented; this one never is.
    ring.authenticate("phone", T0 + 3);
    ring.authenticate("laptop", T0 + 3);
    const qr = store.insert(hashToken("unscanned"), "device", "melded 2026-10-05", T0 + 4);
    const out = ring.signOutDevices(local, T0 + 5);
    assert.equal(out.devices, 2);
    assert.equal(out.ids.length, 3);
    assert.equal(row(qr.id).revoked_at, T0 + 5);
  });

  it("adopts only running sessions' secrets", () => {
    const db = createTestDb();
    for (const id of ["claude-running1", "claude-dead0001"]) {
      db.prepare("INSERT INTO narratives (id, brane_id, agent_type, created_at, status, bind_token) VALUES (?, 'b', 'claude', 0, 'active', ?)").run(id, `secret-${id}`);
    }
    assert.equal(adoptBindTokens(db, T0, new Set(["claude-running1"])), 1);
    assert.ok(verifyAgentToken(db, "claude-running1", "secret-claude-running1"));
    assert.equal(verifyAgentToken(db, "claude-dead0001", "secret-claude-dead0001"), false, "a dead session's secret is no credential");
  });

  it("a restarted daemon carries no agent's identity", () => {
    const saved = { id: process.env.BRANE_NARRATIVE_ID, secret: process.env.BRANE_NARRATIVE_SECRET };
    process.env.BRANE_NARRATIVE_ID = "claude-someone";
    process.env.BRANE_NARRATIVE_SECRET = "their-token";
    try {
      const env = buildDaemonEnv();
      assert.equal(env.BRANE_NARRATIVE_ID, undefined);
      assert.equal(env.BRANE_NARRATIVE_SECRET, undefined);
    } finally {
      if (saved.id === undefined) delete process.env.BRANE_NARRATIVE_ID; else process.env.BRANE_NARRATIVE_ID = saved.id;
      if (saved.secret === undefined) delete process.env.BRANE_NARRATIVE_SECRET; else process.env.BRANE_NARRATIVE_SECRET = saved.secret;
    }
  });

  it("a restarted daemon carries no harness session either", () => {
    const names = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDECODE", "CLAUDE_CODE_USE_BEDROCK"] as const;
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    process.env.CLAUDE_CODE_SESSION_ID = "26f151d7-the-restarting-session";
    process.env.CLAUDE_CODE_MESSAGING_TOKEN = "its-messaging-token";
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    try {
      const env = buildDaemonEnv();
      assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined, "a crush agent would stamp narrations with it");
      assert.equal(env.CLAUDE_CODE_MESSAGING_TOKEN, undefined);
      assert.equal(env.CLAUDECODE, undefined);
      assert.equal(env.CLAUDE_CODE_USE_BEDROCK, "1", "operator configuration passes through");
    } finally {
      for (const n of names) if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n];
    }
  });

  it("utility sessions start with every inherited agent variable unset", () => {
    const prefix = unsetAgentEnvPrefix();
    for (const name of INHERITED_AGENT_ENV) assert.ok(prefix.includes(`-u ${name}`), name);
    assert.ok(prefix.startsWith("env "));
  });

  it("a launch command reaches tmux quoted, never as an argument", () => {
    const line = newSessionLine({
      name: "claude-x",
      cwd: "/Users/me/my fold",
      size: { cols: 80, rows: 24 },
      command: "BRANE_NARRATIVE_SECRET=abc claude --prompt 'it''s $HOME ~ #x;'",
    });
    assert.equal(
      line,
      "new-session -d -s 'claude-x' -c '/Users/me/my fold' -x 80 -y 24 " +
        "'BRANE_NARRATIVE_SECRET=abc claude --prompt '\\''it'\\'''\\''s $HOME ~ #x;'\\'''",
    );
    assert.equal(tmuxQuote("a'b"), "'a'\\''b'");
  });
});

describe("re-check fixes (claude-jrjh1e8w:22)", () => {
  it("a revoke takes the externals its device dialed in, with no ?also=", () => {
    const { db, ring, store, local, laptop, row } = setup();
    const ext = resolveMcpBind(db, "b", "external-q1", undefined, laptop.id);
    const extId = store.list(T0).find((t) => t.owner_nid === ext.nid)!.id;
    assert.deepEqual(listTokensRoute(store, local, T0).body.tokens.find((t) => t.id === laptop.id)!.descendants, [], "not offered as a choice");
    const res = revokeTokenRoute(store, ring, local, laptop.id, T0 + 5);
    assert.ok(res.status === 200);
    assert.ok(res.body.ids.includes(extId));
    assert.equal(row(extId).revoked_at, T0 + 5);
  });

  it("a rotation retires an external whose dialer was revoked earlier on its own", () => {
    const { db, ring, queue, store, phone, laptop, row } = setup();
    const ext = resolveMcpBind(db, "b", "external-q2", undefined, laptop.id);
    const extId = store.list(T0).find((t) => t.owner_nid === ext.nid)!.id;
    store.revoke([laptop.id], T0 + 1); // as an older daemon would have, leaving the external
    queue.push("phone-2");
    ring.beginRotation(phone, T0 + 2);
    const auth = ring.authenticate("phone-2", T0 + 3);
    assert.ok(auth.ok && auth.retired?.ids.includes(extId));
    assert.equal(row(extId).revoked_at, T0 + 3);
  });
});

describe("newTmuxSession against real tmux", () => {
  const tmux = (() => {
    try {
      return execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim() || null;
    } catch {
      return null;
    }
  })();
  it("starts a server when none is running, and keeps the command out of every argv", { skip: !tmux && "no tmux" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "brane-tmux-"));
    const socket = join(dir, "s");
    // Never the default server: every call names this private socket (which
    // wins over an inherited $TMUX), short enough for a Unix socket path.
    assert.ok(socket.startsWith(dir) && Buffer.byteLength(socket) < 104, socket);
    const run = (...args: string[]) => execFileSync(tmux!, ["-S", socket, ...args], { encoding: "utf8" });
    try {
      newTmuxSession({ name: "probe", cwd: dir, command: "BRANE_NARRATIVE_SECRET=not-in-argv sleep 30", socket });
      assert.match(run("list-sessions", "-F", "#{session_name}"), /^probe$/m);
      const pid = run("display-message", "-p", "-t", "probe", "#{pid}").trim();
      const argv = execFileSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" });
      assert.doesNotMatch(argv, /not-in-argv/, "the server's argv carries no secret");
      assert.throws(() => newTmuxSession({ name: "probe", cwd: dir, command: "sleep 1", socket }), "a duplicate name still fails");
    } finally {
      try { run("kill-server"); } catch {}
    }
  });
});
