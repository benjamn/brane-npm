import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createWakeListener, wakePort, DEFAULT_WAKE_PORT } from "../fly/wake-listener.js";

describe("wake listener", () => {
  let server: Server;
  let base: string;
  let wakes = 0;

  before(async () => {
    server = createWakeListener({ onWake: () => { wakes++; } });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("answers GET /wake with an empty, uncacheable 204", async () => {
    const before = wakes;
    const res = await fetch(`${base}/wake`);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(await res.text(), "");
    assert.equal(wakes, before + 1);
  });

  it("answers HEAD /wake and a query string the same way", async () => {
    assert.equal((await fetch(`${base}/wake`, { method: "HEAD" })).status, 204);
    assert.equal((await fetch(`${base}/wake?t=1`)).status, 204);
  });

  it("answers everything else with an empty 404, and doesn't count it", async () => {
    const before = wakes;
    for (const [method, path] of [
      ["GET", "/"],
      ["GET", "/wake/x"],
      ["GET", "/wakeup"],
      ["GET", "/api/status"],
      ["POST", "/wake"],
      ["PUT", "/wake"],
    ] as const) {
      const res = await fetch(`${base}${path}`, {
        method,
        body: method === "GET" ? undefined : "ignored",
      });
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.equal(await res.text(), "", `${method} ${path}`);
    }
    assert.equal(wakes, before);
  });

  it("reads WAKE_PORT, defaulting to 8080", () => {
    assert.equal(DEFAULT_WAKE_PORT, 8080);
    assert.equal(wakePort({}), 8080);
    assert.equal(wakePort({ WAKE_PORT: "" }), 8080);
    assert.equal(wakePort({ WAKE_PORT: "9090" }), 9090);
    assert.throws(() => wakePort({ WAKE_PORT: "0" }));
    assert.throws(() => wakePort({ WAKE_PORT: "http" }));
    assert.throws(() => wakePort({ WAKE_PORT: "70000" }));
  });
});
