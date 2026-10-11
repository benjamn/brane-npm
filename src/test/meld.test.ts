import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import { createTestDb } from "./helpers.js";
import { buildMeldUrl } from "../commands/meld.js";

function setTls(db: Database.Database, value: boolean): void {
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('daemon_tls', ?)",
  ).run(value ? "true" : "false");
}

const daemon = { port: "8443", token: "tok" };
const TS_HOST = "myhost.tailnet.ts.net";

describe("buildMeldUrl", () => {
  let db: Database.Database;
  before(() => {
    db = createTestDb();
  });
  after(() => {
    db.close();
  });

  it("emits an HTTPS Tailscale URL when a cert is present (healthy path)", () => {
    setTls(db, true);
    const r = buildMeldUrl({ db, daemon, tailscaleHost: TS_HOST });
    assert.equal(r.scheme, "https");
    assert.equal(r.useLocal, false);
    assert.equal(r.isLoopbackFallback, false);
    assert.equal(r.tlsDegraded, false);
    assert.ok(r.url.includes("brane.organelle.dev"));
  });

  it("carries host and token in the fragment, never the query string", () => {
    // The shared SPA is served by a third party (Cloudflare). A query string
    // is part of the request it receives; a fragment never leaves the browser.
    setTls(db, true);
    const u = new URL(buildMeldUrl({ db, daemon, tailscaleHost: TS_HOST }).url);
    assert.equal(u.search, "");
    const conn = new URLSearchParams(u.hash.slice(1));
    // daemonHost is host:port unless the TLS port is 443; the round trip
    // through the fragment must keep the port, which is what a phone dials.
    assert.equal(conn.get("host"), `${TS_HOST}:${daemon.port}`);
    assert.equal(conn.get("token"), daemon.token);
    assert.ok(!u.href.includes("?"), u.href);
  });

  it("the direct daemon URL carries only the token, in the fragment", () => {
    setTls(db, false);
    const u = new URL(buildMeldUrl({ db, daemon, tailscaleHost: undefined }).url);
    assert.equal(u.search, "");
    const conn = new URLSearchParams(u.hash.slice(1));
    assert.equal(conn.get("host"), null);
    assert.equal(conn.get("token"), daemon.token);
  });

  it("keeps the fragment after a path", () => {
    setTls(db, true);
    const u = new URL(buildMeldUrl({ db, daemon, tailscaleHost: TS_HOST, path: "claude-abc123" }).url);
    assert.equal(u.pathname, "/claude-abc123");
    assert.equal(new URLSearchParams(u.hash.slice(1)).get("token"), daemon.token);
  });

  it("flags tlsDegraded when Tailscale is up but no cert exists", () => {
    setTls(db, false);
    const r = buildMeldUrl({ db, daemon, tailscaleHost: TS_HOST });
    assert.equal(r.scheme, "http");
    assert.equal(r.useLocal, true);
    assert.equal(r.isLoopbackFallback, false);
    assert.equal(r.tlsDegraded, true, "should warn: Tailscale up, no cert");
    assert.ok(r.daemonHost.startsWith(TS_HOST));
  });

  it("does not flag tlsDegraded when --local is forced", () => {
    setTls(db, false);
    const r = buildMeldUrl({ db, daemon, tailscaleHost: TS_HOST, local: true });
    assert.equal(r.tlsDegraded, false, "explicit --local is a deliberate choice");
    assert.equal(r.useLocal, true);
  });

  it("falls back to loopback (not tlsDegraded) when Tailscale is absent", () => {
    setTls(db, false);
    const r = buildMeldUrl({ db, daemon, tailscaleHost: undefined });
    assert.equal(r.isLoopbackFallback, true);
    assert.equal(r.tlsDegraded, false);
    assert.ok(r.daemonHost.startsWith("127.0.0.1"));
  });

  it("does not flag tlsDegraded when advertising a custom --host", () => {
    // A custom host that isn't the Tailscale hostname isn't a degraded TLS
    // case — the operator chose to advertise something else.
    setTls(db, false);
    const r = buildMeldUrl({ db, daemon, tailscaleHost: TS_HOST, host: "192.168.1.5" });
    assert.equal(r.tlsDegraded, false);
    assert.equal(r.isLoopbackFallback, false);
  });
});
