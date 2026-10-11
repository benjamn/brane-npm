/**
 * A request over `daemon.sock` with no token acts as this Unix account — the
 * live `local` row — while the brane dir is owned by the daemon's uid with no
 * group or other bits. No token anywhere else is still refused, and clients
 * go tokenless only when they have nothing to present and a socket to use.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { createServer as createHttpServer } from "node:http";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer, connect as netConnect, type AddressInfo } from "node:net";
import { createTestDb } from "./helpers.js";
import { accountDirTrust, markUnixConnection } from "../daemon/local-socket.js";
import { authenticateRequest } from "../daemon/server.js";
import { MemoryTokenStore, TokenRing, hashToken } from "../daemon/token-ring.js";
import { bootstrapTokens, DbTokenStore } from "../db/tokens.js";
import { daemonRequest, resolveCredential, type DaemonEndpoint } from "../daemon/client.js";
import { mcpDialTarget } from "../commands/mcp.js";
import { leftoverTokenFile, shellReachProblem, tokenFileCheck } from "../commands/doctor.js";

const unixOnly = process.getuid === undefined ? "no Unix uids on this platform" : false;

function privateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "brane-acct-"));
  chmodSync(dir, 0o700);
  return dir;
}

/** A request as the CLI and bridge send one: `Host: localhost`, no Origin. */
function request(opts: { overSocket: boolean; remoteAddress?: string; headers?: Record<string, string> }): IncomingMessage {
  const socket: { remoteAddress?: string } = opts.overSocket ? {} : { remoteAddress: opts.remoteAddress ?? "127.0.0.1" };
  if (opts.overSocket) markUnixConnection(socket);
  return { headers: { host: "localhost", ...opts.headers }, socket } as unknown as IncomingMessage;
}

describe("accountDirTrust", { skip: unixOnly }, () => {
  it("trusts a directory this uid owns with no group or other bits", () => {
    assert.deepEqual(accountDirTrust(privateDir()), { ok: true });
  });

  it("refuses one other accounts can search, and says so", () => {
    const dir = privateDir();
    chmodSync(dir, 0o755);
    const trust = accountDirTrust(dir);
    assert.equal(trust.ok, false);
    assert.match((trust as { reason: string }).reason, /mode 755/);
  });

  it("refuses a directory that is not there", () => {
    assert.equal(accountDirTrust(join(privateDir(), "gone")).ok, false);
  });
});

describe("authenticateRequest", { skip: unixOnly }, () => {
  const ring = () => new TokenRing(new MemoryTokenStore([{ token: "local-tok", kind: "local", label: "this machine" }]), () => "minted");

  it("acts as the local row for a tokenless request over the socket", () => {
    const heard: Array<string | null> = [];
    const result = authenticateRequest(ring(), null, request({ overSocket: true }), privateDir(), (r) => heard.push(r));
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.record.kind, "local");
    // Told it was let in, so a later refusal is reported again.
    assert.deepEqual(heard, [null]);
  });

  it("treats an empty token as no token", () => {
    assert.equal(authenticateRequest(ring(), "", request({ overSocket: true }), privateDir(), () => {}).ok, true);
  });

  it("refuses a browser's request relayed to the socket: an Origin, or a Host other than localhost", () => {
    const reasons: Array<string | null> = [];
    const relayed = [
      request({ overSocket: true, headers: { origin: "https://evil.example" } }),
      request({ overSocket: true, headers: { host: "evil.example:9000" } }),
      request({ overSocket: true, headers: { host: "" } }),
    ];
    for (const req of relayed) {
      assert.deepEqual(authenticateRequest(ring(), null, req, privateDir(), (r) => reasons.push(r)), { ok: false });
    }
    assert.equal(reasons.filter((r) => r !== null).length, 3);
    // A presented token is still just checked: a relay with a token was
    // always as good as the token.
    const withToken = request({ overSocket: true, headers: { origin: "https://evil.example" } });
    assert.equal(authenticateRequest(ring(), "local-tok", withToken, privateDir(), () => {}).ok, true);
  });

  it("refuses the same request over TCP, loopback included", () => {
    const result = authenticateRequest(ring(), null, request({ overSocket: false, remoteAddress: "127.0.0.1" }), privateDir(), () => {});
    assert.deepEqual(result, { ok: false });
  });

  it("refuses it, and says why, when the brane dir is open to others", () => {
    const dir = privateDir();
    chmodSync(dir, 0o750);
    const reasons: Array<string | null> = [];
    const result = authenticateRequest(ring(), null, request({ overSocket: true }), dir, (r) => reasons.push(r));
    assert.deepEqual(result, { ok: false });
    assert.equal(reasons.length, 1);
    assert.match(reasons[0] ?? "", /mode 750/);
  });

  it("still checks a presented token, over the socket too", () => {
    const r = ring();
    assert.equal(authenticateRequest(r, "nope", request({ overSocket: true }), privateDir(), () => {}).ok, false);
    assert.equal(authenticateRequest(r, "local-tok", request({ overSocket: true }), privateDir(), () => {}).ok, true);
  });

  it("refuses when there is no live local row to act as", () => {
    const empty = new TokenRing(new MemoryTokenStore(), () => "minted");
    assert.deepEqual(authenticateRequest(empty, null, request({ overSocket: true }), privateDir(), () => {}), { ok: false });
  });
});

describe("DbTokenStore.account", () => {
  it("is the live local row, stamped with where it was seen, and nothing once revoked", () => {
    const db = createTestDb();
    const store = new DbTokenStore(db);
    // Last-used is stamped at most once a minute, so use a clock past that.
    const t = 10 * 60_000;
    const local = store.insert(hashToken("x"), "local", "this machine", 1000);
    const found = store.account(t, { userAgent: "node", remoteAddr: "daemon.sock" });
    assert.equal(found?.id, local.id);
    const row = db.prepare("SELECT remote_addr, last_used_at FROM tokens WHERE id = ?").get(local.id) as {
      remote_addr: string | null;
      last_used_at: number | null;
    };
    assert.equal(row.remote_addr, "daemon.sock");
    assert.equal(row.last_used_at, t);
    store.revoke([local.id], t + 1);
    assert.equal(store.account(t + 2), null);
  });
});

describe("clients without a token", () => {
  const closers: Array<() => Promise<void>> = [];
  after(async () => {
    for (const close of closers) await close();
  });

  it("present nothing outside an agent session, and that session's token inside one", () => {
    assert.equal(resolveCredential({}), null);
    assert.equal(resolveCredential({ BRANE_NARRATIVE_SECRET: "" }), null);
    assert.equal(resolveCredential({ BRANE_NARRATIVE_SECRET: "agent-secret" }), "agent-secret");
  });

  it("say what is wrong when there is no socket to present nothing on", async () => {
    const noSocket: DaemonEndpoint = { baseUrl: "http://127.0.0.1:1", token: null, port: "1" };
    await assert.rejects(daemonRequest(noSocket, "/api/status"), /running without its socket.*brane daemon logs/);
    const gone: DaemonEndpoint = { ...noSocket, socketPath: join(privateDir(), "daemon.sock") };
    await assert.rejects(daemonRequest(gone, "/api/status"), /could not connect to the daemon's socket.*brane daemon restart/);
  });

  it("send no Authorization over the socket", async () => {
    const socketPath = join(privateDir(), "daemon.sock");
    const seen: Array<string | undefined> = [];
    const server = createHttpServer((req, res) => {
      seen.push(req.headers.authorization);
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(socketPath, r));
    closers.push(() => new Promise((r) => server.close(() => r())));
    await daemonRequest({ baseUrl: "http://127.0.0.1:1", token: null, port: "1", socketPath }, "/api/status");
    assert.deepEqual(seen, [undefined]);
  });

  it("never fall back to TCP, where no token is only a 401", async () => {
    let tcpHits = 0;
    const tcp = createHttpServer((_req, res) => {
      tcpHits++;
      res.end("{}");
    });
    await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise((r) => tcp.close(() => r())));
    const port = (tcp.address() as AddressInfo).port;
    const endpoint: DaemonEndpoint = {
      baseUrl: `http://127.0.0.1:${port}`,
      token: null,
      port: String(port),
      socketPath: join(privateDir(), "daemon.sock"),
    };
    await assert.rejects(daemonRequest(endpoint, "/api/status"), /could not connect to the daemon's socket/);
    assert.equal(tcpHits, 0);
  });

  it("dial the bridge with no token in the URL", () => {
    assert.deepEqual(mcpDialTarget({ port: "4000", tls: true, token: null, socketPath: "/s" }), {
      url: "ws://localhost/ws/mcp?",
      socketPath: "/s",
    });
  });
});

describe("tokenless over a real socket", { skip: unixOnly }, () => {
  it("is let in while the dir is private, refused with a hint when it is not, and refused through a relay", async () => {
    const dir = privateDir();
    const socketPath = join(dir, "daemon.sock");
    const ring = new TokenRing(new MemoryTokenStore([{ token: "local-tok", kind: "local" }]), () => "minted");
    // The daemon's shape: mark socket connections, decide, answer.
    const server = createHttpServer((req, res) => {
      const auth = authenticateRequest(ring, null, req, dir, () => {});
      res.writeHead(auth.ok ? 200 : 401, { "Content-Type": "application/json" });
      res.end(JSON.stringify(auth.ok ? { kind: auth.record.kind } : { error: "Unauthorized" }));
    });
    server.on("connection", (s) => markUnixConnection(s));
    await new Promise<void>((r) => server.listen(socketPath, r));
    // A plain TCP relay in front of the socket, as `ssh -L` or socat would be.
    const piped = new Set<import("node:net").Socket>();
    const relay = createNetServer((c) => {
      const upstream = netConnect(socketPath);
      piped.add(c).add(upstream);
      c.pipe(upstream).pipe(c);
    });
    await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
    const relayPort = (relay.address() as AddressInfo).port;
    try {
      const endpoint: DaemonEndpoint = { baseUrl: "http://127.0.0.1:1", token: null, port: "1", socketPath };
      assert.deepEqual(await daemonRequest(endpoint, "/api/status"), { kind: "local" });

      chmodSync(dir, 0o755);
      await assert.rejects(daemonRequest(endpoint, "/api/status"), /chmod 700 ~\/\.brane/);
      chmodSync(dir, 0o700);
      assert.deepEqual(await daemonRequest(endpoint, "/api/status"), { kind: "local" });

      // What a web page can send with no preflight, through the relay.
      const res = await fetch(`http://127.0.0.1:${relayPort}/api/spawn`, {
        method: "POST",
        headers: { Origin: "https://evil.example", "Content-Type": "text/plain" },
        body: "{}",
      });
      assert.equal(res.status, 401);
    } finally {
      chmodSync(dir, 0o700);
      // fetch keeps its connection alive; don't wait for it to idle out.
      for (const sock of piped) sock.destroy();
      await new Promise<void>((r) => relay.close(() => r()));
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("doctor's reach check", { skip: unixOnly }, () => {
  it("passes with a secret; without one it needs a socket and a private dir, and a token file is no way in", () => {
    const dir = privateDir();
    const base = { secret: undefined, socketPath: undefined, braneDir: dir };
    assert.equal(shellReachProblem({ ...base, secret: "agent" }), null);
    assert.match(shellReachProblem(base) ?? "", /not listening on its socket/);
    writeFileSync(join(dir, ".daemon_token"), "tok\n");
    assert.match(shellReachProblem(base) ?? "", /not listening on its socket/);
    assert.equal(shellReachProblem({ ...base, socketPath: join(dir, "daemon.sock") }), null);
    chmodSync(dir, 0o755);
    assert.match(shellReachProblem({ ...base, socketPath: join(dir, "daemon.sock") }) ?? "", /chmod 700/);
  });
});

describe("doctor's token file check", () => {
  it("says nothing without a file, or before this version's daemon has started once", () => {
    const db = createTestDb();
    const path = join(privateDir(), ".daemon_token");
    assert.equal(tokenFileCheck(db, path), null);
    // An older brane's file, its token still the live local row: the next
    // daemon start retires it, and until then there is nothing to report.
    new DbTokenStore(db).insert(hashToken("old-local"), "local", "this machine", 1);
    writeFileSync(path, "old-local\n");
    assert.equal(tokenFileCheck(db, path), null);
  });

  it("reports the emptied leftover, and a file the daemon could not empty by how its token stands", () => {
    const db = createTestDb();
    const path = join(privateDir(), ".daemon_token");
    const store = new DbTokenStore(db);
    store.insert(hashToken("old-local"), "local", "this machine", 1);
    store.insert(hashToken("legacy"), "device", "melded before hashing", 1, { used: true });
    writeFileSync(path, "old-local\n");
    bootstrapTokens(db, { tokenFile: path, now: 2 });
    assert.match(tokenFileCheck(db, path)?.detail ?? "", /empty leftover/);
    writeFileSync(path, "old-local\n");
    assert.match(tokenFileCheck(db, path)?.detail ?? "", /could not empty.*no longer works/);
    writeFileSync(path, "legacy\n");
    assert.match(tokenFileCheck(db, path)?.detail ?? "", /still holds a token that works/);
  });
});

describe("doctor on a leftover .daemon_token", () => {
  it("says the empty file can go, and warns when one still holds a token", () => {
    const empty = leftoverTokenFile("/b/.daemon_token", "empty");
    assert.equal(empty.status, "warn");
    assert.match(empty.detail, /empty leftover.*rm \/b\/\.daemon_token/);
    assert.match(leftoverTokenFile("/b/.daemon_token", "dead").detail, /could not empty.*no longer works.*rm /);
    assert.match(leftoverTokenFile("/b/.daemon_token", "live").detail, /still holds a token that works.*rm /);
  });
});
