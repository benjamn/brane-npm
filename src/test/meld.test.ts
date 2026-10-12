import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import { createTestDb } from "./helpers.js";
import { buildMeldUrl, meldLink } from "../commands/meld.js";
import { cleanAppHost } from "../shared/app-origin.js";
import { statusAppDomain } from "../daemon/server.js";

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

  it("points at the app_domain config, which --app overrides, and a literal never decides", () => {
    setTls(db, true);
    // Default: the shipped default, brane's own shell.
    db.prepare("DELETE FROM meta WHERE key = 'config.app_domain'").run();
    assert.equal(buildMeldUrl({ db, daemon, tailscaleHost: TS_HOST }).appHost, "brane.organelle.dev");
    // `brane config set app_domain …`: a staging hostname, or a fork's shell.
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('config.app_domain', 'main.brane.organelle.dev')").run();
    const configured = buildMeldUrl({ db, daemon, tailscaleHost: TS_HOST });
    assert.equal(configured.appHost, "main.brane.organelle.dev");
    assert.equal(new URL(configured.url).host, "main.brane.organelle.dev");
    assert.equal(new URLSearchParams(new URL(configured.url).hash.slice(1)).get("host"), `${TS_HOST}:${daemon.port}`);
    // --app, for one QR.
    const once = buildMeldUrl({ db, daemon, tailscaleHost: TS_HOST, app: "https://fork.example/" });
    assert.equal(once.appHost, "fork.example");
    assert.equal(new URL(once.url).origin, "https://fork.example");
    // --local ignores it: the QR is the daemon's own.
    const local = buildMeldUrl({ db, daemon, tailscaleHost: TS_HOST, local: true, app: "fork.example" });
    assert.equal(new URL(local.url).host, `${TS_HOST}:${daemon.port}`);
    db.prepare("DELETE FROM meta WHERE key = 'config.app_domain'").run();
  });

  it("meldLink falls back to the shipped default for a reply that names no app host", () => {
    // A remote brane from before appHost was part of `--connection`'s reply.
    const url = meldLink({ daemonHost: "h.ts.net:8443", scheme: "https", useLocal: false }, "tok");
    assert.equal(new URL(url).host, "brane.organelle.dev");
    const named = meldLink({ daemonHost: "h.ts.net:8443", scheme: "https", useLocal: false, appHost: "fork.example" }, "tok");
    assert.equal(new URL(named).host, "fork.example");
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

describe("cleanAppHost", () => {
  it("takes a bare host, or the host of a URL, lower-cased, port kept", () => {
    assert.equal(cleanAppHost("brane.organelle.dev"), "brane.organelle.dev");
    assert.equal(cleanAppHost(" Main.Brane.Organelle.dev "), "main.brane.organelle.dev");
    assert.equal(cleanAppHost("https://fork.example/"), "fork.example");
    assert.equal(cleanAppHost("http://localhost:8081/claude-abc?x=1#y"), "localhost:8081");
    assert.equal(cleanAppHost("fork.example/path"), "fork.example");
  });
});

describe("statusAppDomain", () => {
  it("reports the config reduced to a host, as meld reads it, so Isolate and the QR agree", () => {
    const db = createTestDb();
    // With a cert, so the QR is the shared app's and names the host.
    setTls(db, true);
    assert.equal(statusAppDomain(db), "brane.organelle.dev");
    // Stored as a URL by `brane config`: the app must not build https://https://…
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('config.app_domain', 'https://staging.example/')").run();
    assert.equal(statusAppDomain(db), "staging.example");
    assert.equal(statusAppDomain(db), buildMeldUrl({ db, daemon, tailscaleHost: TS_HOST }).appHost);
    // Blanked: means the default, on both sides, never a QR for https:///.
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('config.app_domain', '  ')").run();
    assert.equal(statusAppDomain(db), "brane.organelle.dev");
    const blank = buildMeldUrl({ db, daemon, tailscaleHost: TS_HOST });
    assert.equal(blank.appHost, "brane.organelle.dev");
    assert.equal(new URL(blank.url).host, "brane.organelle.dev");
    assert.equal(buildMeldUrl({ db, daemon, tailscaleHost: TS_HOST, app: "" }).appHost, "brane.organelle.dev");
    db.close();
  });
});
