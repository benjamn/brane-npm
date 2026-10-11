/**
 * The token routes' own logic, outside the server closure: minting a device
 * token from a request body, and finishing a rotation — closing the sockets
 * the retired rows opened, and no others.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TokenRing, MemoryTokenStore, WS_CLOSE_TOKEN_ROTATED } from "../daemon/token-ring.js";
import { mintDeviceTokenRoute, retireTokens } from "../daemon/token-routes.js";

function freshRing(...minted: string[]) {
  const queue = [...minted];
  return new TokenRing(
    new MemoryTokenStore([
      { token: "local", kind: "local", label: "this machine" },
      { token: "phone", kind: "device", label: "phone" },
    ]),
    () => queue.shift() ?? "unexpected-mint",
  );
}

describe("mintDeviceTokenRoute", () => {
  it("mints a device token that authenticates", () => {
    const ring = freshRing("tablet-token");
    const res = mintDeviceTokenRoute(ring, JSON.stringify({ label: "tablet" }));
    assert.equal(res.status, 200);
    assert.ok(res.status === 200);
    assert.equal(res.body.token, "tablet-token");
    assert.equal(res.body.label, "tablet");
    const auth = ring.authenticate("tablet-token");
    assert.ok(auth.ok);
    assert.equal(auth.record.kind, "device");
  });

  it("labels by date when no label is given, empty body included", () => {
    const now = Date.UTC(2026, 9, 3);
    for (const body of [undefined, "", "{}", JSON.stringify({ label: "   " })]) {
      const res = mintDeviceTokenRoute(freshRing("t"), body, now);
      assert.ok(res.status === 200, `body ${JSON.stringify(body)}`);
      assert.equal(res.body.label, "melded 2026-10-03");
    }
  });

  it("caps a label at 200 characters", () => {
    const res = mintDeviceTokenRoute(freshRing("t"), JSON.stringify({ label: "x".repeat(500) }));
    assert.ok(res.status === 200);
    assert.equal(res.body.label.length, 200);
  });

  it("refuses a body that is not a JSON object, and mints nothing", () => {
    for (const body of ["not json", "null", "[]", "42"]) {
      const ring = freshRing("should-not-mint");
      const res = mintDeviceTokenRoute(ring, body);
      assert.equal(res.status, 400, `body ${body}`);
      assert.equal(ring.authenticate("should-not-mint").ok, false);
    }
  });
});

class FakeSocket {
  closed: Array<[number | undefined, string | undefined]> = [];
  close(code?: number, reason?: string) {
    this.closed.push([code, reason]);
  }
}

function rotate(ring: TokenRing, requester: string, next: string) {
  const r = ring.authenticate(requester);
  assert.ok(r.ok);
  ring.beginRotation(r.record);
  const confirmed = ring.authenticate(next);
  assert.ok(confirmed.ok && confirmed.retired);
  return { requester: r.record, confirmed: { record: confirmed.record, retired: confirmed.retired } };
}

describe("retireTokens", () => {
  it("closes only the sockets opened under revoked rows, with 4401", () => {
    const ring = freshRing("new-phone");
    const local = ring.authenticate("local");
    assert.ok(local.ok);
    const { requester, confirmed } = rotate(ring, "phone", "new-phone");
    const onOldPhone = new FakeSocket();
    const onLocal = new FakeSocket();
    const onNewPhone = new FakeSocket();
    const sockets = new Map<FakeSocket, string>([
      [onOldPhone, requester.id],
      [onLocal, local.record.id],
      [onNewPhone, confirmed.record.id],
    ]);
    const { closed } = retireTokens({ ...confirmed, viewerSockets: sockets });
    assert.equal(closed, 1);
    assert.deepEqual(onOldPhone.closed, [[WS_CLOSE_TOKEN_ROTATED, "token rotated"]]);
    assert.deepEqual(onLocal.closed, []);
    assert.deepEqual(onNewPhone.closed, []);
    assert.deepEqual([...sockets.keys()], [onLocal, onNewPhone]);
  });
});

describe("mintDeviceTokenRoute labels", () => {
  it("replaces control characters, so a label cannot forge a log line", () => {
    const res = mintDeviceTokenRoute(freshRing("t"), JSON.stringify({ label: "phone\n[token] minted device token \"x\"\u0007" }));
    assert.ok(res.status === 200);
    assert.doesNotMatch(res.body.label, /[\u0000-\u001f\u007f-\u009f]/);
    assert.equal(res.body.label, 'phone [token] minted device token "x"');
  });
});
