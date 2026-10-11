import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.js";
import { DbTokenStore } from "../db/tokens.js";
import { TokenRing, UNUSED_TOKEN_LAPSE_MS, hashToken } from "../daemon/token-ring.js";
import { mintDeviceTokenRoute } from "../daemon/token-routes.js";

const T0 = Date.UTC(2026, 9, 3, 12);
const LATE = T0 + UNUSED_TOKEN_LAPSE_MS;

function setup() {
  const db = createTestDb();
  const store = new DbTokenStore(db);
  const revokedAt = (id: string) =>
    (db.prepare("SELECT revoked_at FROM tokens WHERE id = ?").get(id) as { revoked_at: number | null }).revoked_at;
  return { db, store, revokedAt };
}

describe("unused device tokens lapse", () => {
  it("refuses a minted device token never used within the window, and revokes its row", () => {
    const { store, revokedAt } = setup();
    const rec = store.insert(hashToken("qr"), "device", "melded", T0);
    assert.equal(store.find(hashToken("qr"), LATE), null);
    assert.equal(revokedAt(rec.id), LATE);
    assert.equal(store.find(hashToken("qr"), LATE + 1), null, "and stays refused");
  });

  it("accepts it just inside the window", () => {
    const { store } = setup();
    const rec = store.insert(hashToken("qr"), "device", "melded", T0);
    assert.equal(store.find(hashToken("qr"), LATE - 1)?.id, rec.id);
  });

  it("keeps a token for good once it has been used", () => {
    const { store } = setup();
    store.insert(hashToken("qr"), "device", "melded", T0);
    assert.ok(store.find(hashToken("qr"), T0 + 1000));
    assert.ok(store.find(hashToken("qr"), T0 + 30 * 24 * 3600_000));
  });

  it("counts a first use recorded on disk by an earlier daemon", () => {
    const { db } = setup();
    const store = new DbTokenStore(db);
    store.insert(hashToken("qr"), "device", "melded", T0);
    store.find(hashToken("qr"), T0 + 1000);
    // A restart: a new store with no memory of that use.
    assert.ok(new DbTokenStore(db).find(hashToken("qr"), LATE + 1));
  });

  it("never lapses the local row or an adopted token", () => {
    const { store } = setup();
    store.insert(hashToken("local"), "local", "this machine", T0);
    store.adopt(hashToken("old-shared"), "device", "melded before hashing", T0);
    assert.ok(store.find(hashToken("local"), LATE * 2));
    assert.ok(store.find(hashToken("old-shared"), LATE * 2));
  });

  it("sweeps unused rows without anyone presenting them, and only those", () => {
    const { store, revokedAt } = setup();
    const unused = store.insert(hashToken("unscanned"), "device", "melded", T0);
    const used = store.insert(hashToken("scanned"), "device", "melded", T0);
    const fresh = store.insert(hashToken("just-minted"), "device", "melded", LATE - 1000);
    const local = store.insert(hashToken("local"), "local", "this machine", T0);
    store.find(hashToken("scanned"), T0 + 1000);
    assert.equal(store.lapseUnused(LATE), 1);
    assert.equal(revokedAt(unused.id), LATE);
    assert.equal(revokedAt(used.id), null);
    assert.equal(revokedAt(fresh.id), null);
    assert.equal(revokedAt(local.id), null);
    assert.equal(store.lapseUnused(LATE), 0, "a second sweep finds nothing");
  });

  it("does not lapse a token used in this process whose last_used_at write was lost", () => {
    const { db, store } = setup();
    const rec = store.insert(hashToken("qr"), "device", "melded", T0);
    assert.ok(store.find(hashToken("qr"), T0 + 1000));
    // Simulate the best-effort stamp having failed.
    db.prepare("UPDATE tokens SET last_used_at = NULL WHERE id = ?").run(rec.id);
    assert.equal(store.lapseUnused(LATE), 0);
    assert.ok(store.find(hashToken("qr"), LATE + 1));
  });

  it("writes a rotation's replacement as used, so a device that only holds a socket keeps it", () => {
    const { db, store } = setup();
    store.insert(hashToken("phone"), "device", "phone", T0);
    const ring = new TokenRing(store, () => "phone-2");
    assert.ok(ring.authenticate("phone", T0 + 1000).ok);
    const { token } = ring.beginRotation(store.find(hashToken("phone"), T0 + 1000)!, T0 + 2000);
    const auth = ring.authenticate(token, T0 + 3000);
    assert.ok(auth.ok && auth.retired);
    const row = db.prepare("SELECT last_used_at FROM tokens WHERE hash = ?").get(hashToken("phone-2")) as {
      last_used_at: number | null;
    };
    assert.equal(row.last_used_at, T0 + 3000);
    // Ten minutes of nothing but an open socket later, it still authenticates.
    assert.ok(new DbTokenStore(db).find(hashToken("phone-2"), T0 + 3000 + UNUSED_TOKEN_LAPSE_MS * 2));
  });

  it("tells the minting client when its token lapses", () => {
    const { store } = setup();
    const ring = new TokenRing(store, () => "qr");
    const res = mintDeviceTokenRoute(ring, "{}", T0);
    assert.ok(res.status === 200);
    assert.equal(res.body.expiresAt, LATE);
    assert.equal(res.body.validForMs, UNUSED_TOKEN_LAPSE_MS);
  });
});
