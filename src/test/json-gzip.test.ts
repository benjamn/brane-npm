import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sendJson, trackRequest } from "../daemon/server.js";

/** The daemon's JSON responses go out through one function, and until now
 *  nothing tested it — `daemon-client.test.ts` stands up a *stub* server to
 *  exercise the CLI side, so the real handler had no HTTP coverage at all
 *  (claude-n1izig04:78). These tests drive the actual `sendJson` over a real
 *  socket, because content negotiation is exactly the kind of thing that looks
 *  right in review and is wrong on the wire. */
describe("sendJson content negotiation", () => {
  let server: Server;
  let base: string;
  // Comfortably past the compress-it threshold, and repetitive enough that a
  // failure to compress is unmistakable in the numbers.
  const big = { rows: Array.from({ length: 400 }, (_, i) => ({ i, text: "brane ".repeat(20) })) };
  const small = { ok: true };

  before(async () => {
    server = createServer((req, res) => {
      trackRequest(res, req);
      sendJson(res, 200, req.url === "/small" ? small : big);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => server.close());

  it("gzips a large body for a client that accepts it, byte-identical after decoding", async () => {
    const res = await fetch(`${base}/big`, { headers: { "accept-encoding": "gzip" } });
    assert.equal(res.headers.get("content-encoding"), "gzip");
    // Undici decodes transparently, so equality here proves the round trip.
    assert.deepEqual(await res.json(), big);
  });

  it("sets Vary, so a cache can't hand a gzipped body to a client that can't read it", async () => {
    const res = await fetch(`${base}/big`, { headers: { "accept-encoding": "gzip" } });
    assert.equal(res.headers.get("vary"), "Accept-Encoding");
    await res.arrayBuffer();
  });

  it("sends plain when the client didn't offer gzip", async () => {
    const res = await fetch(`${base}/big`, { headers: { "accept-encoding": "identity" } });
    assert.equal(res.headers.get("content-encoding"), null);
    assert.deepEqual(await res.json(), big);
  });

  it("leaves a small body alone — the header costs more than the saving", async () => {
    const res = await fetch(`${base}/small`, { headers: { "accept-encoding": "gzip" } });
    assert.equal(res.headers.get("content-encoding"), null);
    assert.deepEqual(await res.json(), small);
  });

  it("actually shrinks the bytes on the wire", async () => {
    const [zipped, plain] = await Promise.all([
      fetch(`${base}/big`, { headers: { "accept-encoding": "gzip" } }),
      fetch(`${base}/big`, { headers: { "accept-encoding": "identity" } }),
    ]);
    // Undici decodes the gzip stream before handing it over, so the honest
    // measure is what the server declared it was sending, not what the client
    // ended up holding.
    const zippedBytes = Number(zipped.headers.get("content-length"));
    const plainBytes = Number(plain.headers.get("content-length"));
    await Promise.all([zipped.arrayBuffer(), plain.arrayBuffer()]);
    assert.ok(plainBytes > 10_000, `sanity: plain body was ${plainBytes} bytes`);
    assert.ok(
      zippedBytes * 5 < plainBytes,
      `expected a real saving, got ${zippedBytes} vs ${plainBytes} bytes`,
    );
  });

  it("gzips regardless of how the client spells its accept-encoding", async () => {
    for (const header of ["gzip", "gzip, deflate", "deflate, gzip;q=1.0, *;q=0.5", "GZIP"]) {
      const res = await fetch(`${base}/big`, { headers: { "accept-encoding": header } });
      assert.equal(res.headers.get("content-encoding"), "gzip", `for "${header}"`);
      await res.arrayBuffer();
    }
  });
});
