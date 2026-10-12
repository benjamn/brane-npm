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

describe("CORS: the token is the credential, not the origin", () => {
  test("any origin is answered the same way, and no origin is reflected", () => {
    // The daemon does not care which hostname serves the app: the hosted
    // shell, a staging hostname, a fork's deployment, its own bundle. A page
    // with no token gets a 401 whatever its origin, and a page with one has
    // the standing of curl with that token. So the answer is `*` for all of
    // them — never the request's own origin echoed back, which with
    // credentials would be the one dangerous combination.
    for (const origin of ["https://brane.organelle.dev", "https://main.brane.organelle.dev", "https://fork.example", "http://localhost:8081"]) {
      const { req, res, headers } = exchange(origin);
      setCorsHeaders(req, res);
      assert.equal(headers.get("access-control-allow-origin"), "*", origin);
      assert.match(headers.get("access-control-allow-methods") ?? "", /GET/);
      assert.match(headers.get("access-control-allow-headers") ?? "", /Authorization/);
    }
  });

  test("credentials are never allowed", () => {
    // Brane sets no cookies, so the header would grant nothing — except that
    // a browser refuses `*` for a credentialed request, which is the guard
    // worth keeping. Sending `Allow-Credentials: true` would turn it off.
    const { req, res, headers } = exchange("https://brane.organelle.dev");
    setCorsHeaders(req, res);
    assert.equal(headers.get("access-control-allow-credentials"), undefined);
  });

  test("a preflight answer may be reused for at least an hour", () => {
    // Without this header Chrome caches a preflight for 5 seconds, which on a
    // fast link is indistinguishable from caching forever and on a slow one is
    // indistinguishable from not caching at all — every request pays its own
    // extra round trip. At 741ms RTT that was fatal rather than merely slow.
    const { req, res, headers } = exchange("https://brane.organelle.dev");
    setCorsHeaders(req, res);
    const maxAge = headers.get("access-control-max-age");
    assert.ok(maxAge, "preflight answers must be cacheable");
    assert.ok(Number(maxAge) >= 3600, `max-age ${maxAge} is too short to spare a slow link repeated preflights`);
  });

  test("a request with no Origin gets no CORS headers", () => {
    const { req, res, headers } = exchange();
    setCorsHeaders(req, res);
    assert.equal(headers.size, 0);
  });
});
