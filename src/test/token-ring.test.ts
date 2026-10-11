import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TokenRing,
  MemoryTokenStore,
  ROTATION_GRACE_MS,
  hashToken,
  type TokenKind,
  type TokenStore,
} from "../daemon/token-ring.js";
import { DbTokenStore } from "../db/tokens.js";
import { createTestDb } from "./helpers.js";

// Rotation swaps on first use: a minted token changes nothing until a request
// presents it, so a lost response can never lock the requester out. Each test
// pins one step of that handshake with a fixed clock and a scripted mint.
//
// The store keeps hashes only, so the ring is checked through what it
// authenticates, never through a plaintext it could hand back.

type Seed = Array<{ token: string; kind: TokenKind; label?: string }>;

// Every case runs against both stores: the in-memory one, and the SQLite one
// the daemon uses, so what is pinned here is the real rotation, not a double.
const STORES: Array<[string, (seed: Seed) => TokenStore]> = [
  ["memory", (seed) => new MemoryTokenStore(seed)],
  [
    "sqlite",
    (seed) => {
      const store = new DbTokenStore(createTestDb());
      // Seeded as devices already in use: an unused device row minted at 0
      // would have lapsed long before these tests' real clock.
      for (const s of seed) store.insert(hashToken(s.token), s.kind, s.label ?? s.kind, 0, { used: true });
      return store;
    },
  ],
];

for (const [storeName, makeStore] of STORES) {

function ring(...minted: string[]) {
  const queue = [...minted];
  const store = makeStore([
    { token: "local", kind: "local", label: "this machine" },
    { token: "phone", kind: "device", label: "phone" },
    { token: "laptop", kind: "device", label: "laptop" },
  ]);
  const r = new TokenRing(store, () => queue.shift() ?? "unexpected-mint");
  const record = (token: string) => {
    const a = r.authenticate(token);
    assert.ok(a.ok, `${token} should authenticate`);
    return a.record;
  };
  return { r, store, record };
}

describe(`TokenRing (${storeName} store)`, () => {
  it("authenticates live tokens and nothing else", () => {
    const { r } = ring();
    assert.equal(r.authenticate("local").ok, true);
    assert.equal(r.authenticate("phone").ok, true);
    assert.deepEqual(r.authenticate("nope"), { ok: false });
    assert.deepEqual(r.authenticate(null), { ok: false });
    assert.deepEqual(r.authenticate(""), { ok: false });
  });

  it("stores only hashes", () => {
    const store = makeStore([]);
    const r = new TokenRing(store, () => "minted");
    const { token, record } = r.issue("device", "tablet");
    assert.equal(token, "minted");
    assert.deepEqual(store.find(hashToken("minted"), 0), record);
    assert.equal(store.find("minted", 0), null);
  });

  it("beginRotation mints a pending token and leaves every live token in place", () => {
    const { r, record } = ring("new");
    const t0 = 1_000;
    assert.deepEqual(r.beginRotation(record("phone"), t0), {
      token: "new",
      expiresAt: t0 + ROTATION_GRACE_MS,
      replaced: false,
    });
    // Nothing durable has moved: every token still authenticates, without consequence.
    for (const t of ["local", "phone", "laptop"]) {
      const a = r.authenticate(t, t0 + 1);
      assert.equal(a.ok, true);
      assert.equal(a.ok && a.retired, undefined);
    }
  });

  it("first use of the pending token retires the requester and every other device, exactly once", () => {
    const { r, record } = ring("new");
    const phone = record("phone");
    const laptop = record("laptop");
    r.beginRotation(phone, 0);
    const confirmed = r.authenticate("new", 10);
    assert.ok(confirmed.ok);
    assert.equal(confirmed.record.kind, "device");
    assert.equal(confirmed.record.label, "phone");
    assert.deepEqual(new Set(confirmed.retired?.ids), new Set([phone.id, laptop.id]));
    assert.equal(r.pendingRotation(10), null);
    // The retirement is reported on that one request only.
    const again = r.authenticate("new", 11);
    assert.ok(again.ok);
    assert.equal(again.retired, undefined);
    // And the old device tokens are dead from that moment.
    assert.deepEqual(r.authenticate("phone", 11), { ok: false });
    assert.deepEqual(r.authenticate("laptop", 11), { ok: false });
    // This machine rides through a device's rotation: the CLI and MCP
    // bridges are not "other devices".
    assert.equal(r.authenticate("local", 11).ok, true);
  });

  it("refuses to begin a rotation for this account, which would mint a token that opens the local row", () => {
    const { r, record } = ring("new-local");
    const local = record("local");
    assert.throws(() => r.beginRotation(local, 0), /holds no token to rotate/);
    assert.equal(r.pendingRotation(0), null);
    assert.deepEqual(r.authenticate("new-local", 1), { ok: false }, "nothing was minted");
    for (const t of ["local", "phone", "laptop"]) assert.equal(r.authenticate(t, 2).ok, true, `${t} is untouched`);
  });

  it("signOutDevices revokes every device at once, keeps this account, and voids a pending rotation", () => {
    const { r, record } = ring("phone-2");
    const local = record("local");
    r.beginRotation(record("phone"), 0);
    const out = r.signOutDevices(local, 1);
    assert.equal(out.devices, 2);
    assert.equal(out.ids.length, 2);
    assert.equal(out.replaced, true);
    for (const t of ["phone", "laptop"]) assert.deepEqual(r.authenticate(t, 2), { ok: false });
    assert.equal(r.authenticate("local", 2).ok, true);
    // The phone's pending token must not write it back in.
    assert.deepEqual(r.authenticate("phone-2", 2), { ok: false });
    assert.deepEqual(r.signOutDevices(local, 3), { ids: [], devices: 0, replaced: false });
  });

  it("a second rotate during the window replaces the pending token, never re-issues it", () => {
    // Anyone holding a token can call rotate. If the daemon answered a second
    // call with the token already pending, an attacker racing the operator
    // would be handed the new credential and could use it first — and the
    // operator's own confirm would still succeed, hiding the guest.
    const { r, record } = ring("first", "second");
    const a = r.beginRotation(record("phone"), 0);
    const b = r.beginRotation(record("laptop"), 30_000);
    assert.equal(a.replaced, false);
    assert.deepEqual(b, { token: "second", expiresAt: 30_000 + ROTATION_GRACE_MS, replaced: true });
    // The first pending token is dead: the requester who got it sees a 401
    // on confirm, which is the visible failure the design wants.
    assert.deepEqual(r.authenticate("first", 31_000), { ok: false });
    const confirmed = r.authenticate("second", 31_000);
    assert.ok(confirmed.ok && confirmed.retired);
    assert.equal(confirmed.record.label, "laptop");
  });

  it("an unused pending token lapses and every token simply remains", () => {
    const { r, record } = ring("new", "newer");
    const phone = record("phone");
    r.beginRotation(phone, 0);
    const late = ROTATION_GRACE_MS;
    assert.deepEqual(r.authenticate("new", late), { ok: false });
    assert.equal(r.authenticate("phone", late).ok, true);
    assert.equal(r.pendingRotation(late), null);
    // A fresh rotate after the lapse mints anew rather than reviving the stale one.
    // A lapsed pending token is gone, not "replaced" — nothing was live.
    assert.deepEqual(r.beginRotation(phone, late), {
      token: "newer",
      expiresAt: late + ROTATION_GRACE_MS,
      replaced: false,
    });
  });

  it("revoked tokens stay revoked across several rotations", () => {
    const { r, record } = ring("b", "c");
    r.beginRotation(record("phone"), 0);
    const b = r.authenticate("b", 1);
    assert.ok(b.ok);
    r.beginRotation(b.record, 2);
    const c = r.authenticate("c", 3);
    assert.ok(c.ok && c.retired);
    assert.deepEqual(c.retired.ids, [b.record.id]);
    for (const t of ["phone", "laptop", "b"]) assert.deepEqual(r.authenticate(t, 4), { ok: false });
    assert.equal(r.authenticate("c", 4).ok, true);
  });
});

describe(`TokenRing rotation is all or nothing (${storeName} store)`, () => {
  it("a failed write leaves every token as it was and the pending token usable", () => {
    const store = makeStore([
      { token: "phone", kind: "device" },
      { token: "laptop", kind: "device" },
    ]);
    const r = new TokenRing(store, () => "new");
    const phone = r.authenticate("phone");
    assert.ok(phone.ok);
    r.beginRotation(phone.record, 0);

    const revoke = store.revoke.bind(store);
    store.revoke = () => { throw new Error("disk full"); };
    assert.throws(() => r.authenticate("new", 1), /disk full/);
    // Nothing landed: the old tokens work, and the new one is not a row yet.
    assert.equal(r.authenticate("phone", 2).ok, true);
    assert.equal(r.authenticate("laptop", 2).ok, true);
    assert.equal(store.find(hashToken("new"), 2), null);

    // The pending token survived, so the retry completes the rotation.
    store.revoke = revoke;
    const retry = r.authenticate("new", 3);
    assert.ok(retry.ok && retry.retired);
    assert.equal(r.authenticate("phone", 4).ok, false);
  });
});

}
