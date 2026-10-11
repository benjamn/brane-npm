import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setCorsHeaders } from "../daemon/server.js";

/** Just enough of a request/response pair to read headers back off. */
function exchange(origin?: string) {
  const headers = new Map<string, string>();
  const req = { headers: origin ? { origin } : {} } as unknown as IncomingMessage;
  const res = {
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
  } as unknown as ServerResponse;
  return { req, res, headers };
}

const APP_DOMAIN = "brane.organelle.dev";

describe("CORS preflight caching", () => {
  test("an allowed origin is told how long it may reuse the answer", () => {
    // Without this header Chrome caches a preflight for 5 seconds, which on a
    // fast link is indistinguishable from caching forever and on a slow one is
    // indistinguishable from not caching at all — every request pays its own
    // extra round trip. At 741ms RTT that was fatal rather than merely slow.
    const { req, res, headers } = exchange(`https://${APP_DOMAIN}`);
    setCorsHeaders(req, res, APP_DOMAIN, 8080);

    const maxAge = headers.get("access-control-max-age");
    assert.ok(maxAge, "preflight answers must be cacheable");
    assert.ok(
      Number(maxAge) >= 3600,
      `max-age ${maxAge} is too short to spare a slow link repeated preflights`,
    );
  });

  test("the rest of the CORS contract is unchanged", () => {
    const { req, res, headers } = exchange(`https://${APP_DOMAIN}`);
    setCorsHeaders(req, res, APP_DOMAIN, 8080);

    assert.equal(headers.get("access-control-allow-origin"), `https://${APP_DOMAIN}`);
    assert.match(headers.get("access-control-allow-methods") ?? "", /GET/);
    assert.match(headers.get("access-control-allow-headers") ?? "", /Authorization/);
    assert.equal(headers.get("access-control-allow-credentials"), "true");
  });

  test("a disallowed origin is told nothing at all", () => {
    // Caching must not become a way to hand headers to an origin that would
    // otherwise have been refused.
    const { req, res, headers } = exchange("https://evil.example.com");
    setCorsHeaders(req, res, APP_DOMAIN, 8080);
    assert.equal(headers.size, 0);
  });

  test("a request with no Origin gets no CORS headers", () => {
    const { req, res, headers } = exchange();
    setCorsHeaders(req, res, APP_DOMAIN, 8080);
    assert.equal(headers.size, 0);
  });
});
