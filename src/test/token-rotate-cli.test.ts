/**
 * `brane token rotate` is a thin client of POST /api/token/rotate, and from
 * the shell it is one request: this machine holds no token, so there is none
 * to swap and nothing to confirm — the daemon signs every device out before
 * it answers. This pins that shape against a scripted daemon, and that an
 * older daemon's two-step answer is reported instead of being taken for a
 * sign-out that never happened.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { DaemonEndpoint } from "../daemon/client.js";
import { rotateDaemonToken, formatRotateResult } from "../commands/token.js";

describe("brane token rotate", () => {
  let server: ReturnType<typeof createServer>;
  let endpoint: DaemonEndpoint;
  let answer: unknown;
  const seen: Array<[string, string]> = [];

  before(async () => {
    server = createServer((req, res) => {
      seen.push([req.method ?? "", req.url ?? ""]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    // Over TCP with a token only so the test needs no socket; who may ask is
    // the daemon's business (src/test/presence-gate.test.ts).
    endpoint = { baseUrl: `http://127.0.0.1:${port}`, token: "t", port: String(port) };
  });

  beforeEach(() => {
    seen.length = 0;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("is one request, with nothing to confirm", async () => {
    answer = { signed_out: 2, replaced: false };
    assert.deepEqual(await rotateDaemonToken(endpoint), { signed_out: 2, replaced: false });
    assert.deepEqual(seen, [["POST", "/api/token/rotate"]]);
  });

  it("reports an older daemon's two-step answer rather than claiming a sign-out", async () => {
    answer = { token: "new", expires_at: 0, replaced: false };
    await assert.rejects(rotateDaemonToken(endpoint), /older brane.*nobody was signed out.*brane daemon restart/);
    assert.deepEqual(seen, [["POST", "/api/token/rotate"]], "and never presents the token it was handed");
  });

  it("prints what changed and what did not", () => {
    const text = formatRotateResult({ signed_out: 2, replaced: false });
    assert.match(text, /Signed out 2 devices/);
    assert.match(text, /This shell and running agents are unaffected/);
    assert.match(text, /brane meld/);
    assert.doesNotMatch(text, /pending/);
    assert.match(formatRotateResult({ signed_out: 1, replaced: false }), /Signed out 1 device\./);
    assert.match(formatRotateResult({ signed_out: 0, replaced: false }), /no devices/);
    assert.match(formatRotateResult({ signed_out: 1, replaced: true }), /never confirmed was pending/);
  });
});
