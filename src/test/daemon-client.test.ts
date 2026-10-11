import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type Database from "better-sqlite3";
import { createTestDb } from "./helpers.js";
import {
  buildDaemonBaseUrl,
  readDaemonAddress,
  daemonRequest,
  type DaemonEndpoint,
} from "../daemon/client.js";

const TS_HOST = "myhost.tailnet.ts.net";

function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}

describe("buildDaemonBaseUrl", () => {
  it("uses loopback on the primary port when TLS is off", () => {
    assert.equal(
      buildDaemonBaseUrl({ port: "7777", tls: false }),
      "http://127.0.0.1:7777",
    );
  });

  it("prefers the HTTP fallback port under TLS (the cert never covers 127.0.0.1)", () => {
    assert.equal(
      buildDaemonBaseUrl({ port: "8443", tls: true, httpPort: "9001", tailscaleHost: TS_HOST }),
      "http://127.0.0.1:9001",
    );
  });

  it("falls back to the Tailscale hostname when no HTTP port is recorded yet", () => {
    assert.equal(
      buildDaemonBaseUrl({ port: "8443", tls: true, tailscaleHost: TS_HOST }),
      `https://${TS_HOST}:8443`,
    );
  });

  it("refuses to guess when TLS is on and neither route is available", () => {
    assert.throws(() => buildDaemonBaseUrl({ port: "8443", tls: true }), /TLS/);
  });
});

describe("readDaemonAddress", () => {
  let db: Database.Database;
  before(() => {
    db = createTestDb();
  });
  after(() => {
    db.close();
  });

  it("reports a plain-HTTP daemon and ignores any stale fallback port", () => {
    setMeta(db, "daemon_tls", "false");
    setMeta(db, "daemon_http_port", "9001");
    const addr = readDaemonAddress(db, "7777", { tailscaleHost: TS_HOST });
    assert.equal(addr.tls, false);
    assert.equal(addr.httpPort, undefined);
    assert.equal(addr.tailscaleHost, undefined);
  });

  it("carries the fallback port and cert hostname for a TLS daemon", () => {
    setMeta(db, "daemon_tls", "true");
    setMeta(db, "daemon_http_port", "9001");
    const addr = readDaemonAddress(db, "8443", { tailscaleHost: TS_HOST });
    assert.deepEqual(addr, {
      port: "8443",
      tls: true,
      httpPort: "9001",
      tailscaleHost: TS_HOST,
    });
  });
});

describe("daemonRequest", () => {
  let server: ReturnType<typeof createServer>;
  let endpoint: DaemonEndpoint;
  const seen: Array<{ method: string; url: string; auth?: string; body: string }> = [];

  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({
          method: req.method ?? "",
          url: req.url ?? "",
          auth: req.headers.authorization,
          body,
        });
        if (req.url === "/api/spawn") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ narrative: { id: "claude-abc12345" } }));
        } else if (req.url === "/api/boom") {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not a fold: ~/nope. Run `brane fold` first." }));
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("nope");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    endpoint = { baseUrl: `http://127.0.0.1:${port}`, token: "tok", port: String(port) };
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("POSTs JSON with a bearer token and returns the parsed body", async () => {
    const result = await daemonRequest<{ narrative: { id: string } }>(endpoint, "/api/spawn", {
      method: "POST",
      body: { agent: "claude", fold_path: "~/dev/brane" },
    });
    assert.equal(result.narrative.id, "claude-abc12345");
    const req = seen.find((r) => r.url === "/api/spawn");
    assert.equal(req?.method, "POST");
    assert.equal(req?.auth, "Bearer tok");
    assert.deepEqual(JSON.parse(req?.body ?? "{}"), {
      agent: "claude",
      fold_path: "~/dev/brane",
    });
  });

  it("surfaces the daemon's own error string verbatim", async () => {
    await assert.rejects(
      () => daemonRequest(endpoint, "/api/boom", { method: "POST", body: {} }),
      /^Error: Not a fold: ~\/nope\. Run `brane fold` first\.$/,
    );
  });

  it("falls back to a status-code message when the body carries no error", async () => {
    await assert.rejects(() => daemonRequest(endpoint, "/api/missing"), /404/);
  });
});
