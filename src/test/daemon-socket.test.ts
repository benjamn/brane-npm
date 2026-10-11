/**
 * `daemon.sock`: the CLI reaches the daemon over its Unix socket when it has
 * one, falls back to TCP only when the socket refuses the connection, and a
 * request that arrives over the socket counts as loopback. Stale-socket
 * cleanup removes only a socket nothing answers on.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { createServer as createNetServer, connect as netConnect } from "node:net";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { daemonRequest, daemonStream, readDaemonSocket, type DaemonEndpoint } from "../daemon/client.js";
import { mcpDialTarget } from "../commands/mcp.js";
import { SCHEMA_SQL, applyMigrations } from "../db/schema.js";
import { createTestDb } from "./helpers.js";
import { clearStaleSocket, connectionLabel, getSocketPath, listenOnLocalSocket, markUnixConnection, MAX_SOCKET_PATH } from "../daemon/local-socket.js";
import { samePlace, UNIX_SOCKET_SIGHTING } from "../db/tokens.js";
import { isLoopbackRequest } from "../daemon/server.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "brane-sock-"));
}

/** A socket file whose process exited without closing it, as a crash
 *  leaves one: connects to it are refused. */
function crashedSocket(path = join(tempDir(), "daemon.sock")): string {
  const r = spawnSync(process.execPath, [
    "-e",
    `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.exit(0))`,
  ]);
  assert.equal(r.status, 0);
  return path;
}

function listenUnix(path: string, handler: (req: IncomingMessage, body: string) => [number, string]) {
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const [status, out] = handler(req, body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(out);
    });
  });
  server.on("connection", (socket) => markUnixConnection(socket));
  return new Promise<typeof server>((r) => server.listen(path, () => r(server)));
}

describe("the CLI over daemon.sock", () => {
  const closers: Array<() => Promise<void>> = [];
  after(async () => {
    for (const close of closers) await close();
  });

  it("sends requests to the socket, with the bearer token, never to baseUrl", async () => {
    const socketPath = join(tempDir(), "daemon.sock");
    const seen: Array<{ url?: string; auth?: string; body: string; loopback: boolean }> = [];
    const server = await listenUnix(socketPath, (req, body) => {
      seen.push({ url: req.url, auth: req.headers.authorization, body, loopback: isLoopbackRequest(req) });
      return [200, JSON.stringify({ ok: "yes" })];
    });
    closers.push(() => new Promise((r) => server.close(() => r())));
    // Port 1 answers nothing: success means the socket carried it.
    const endpoint: DaemonEndpoint = { baseUrl: "http://127.0.0.1:1", token: "tok", port: "1", socketPath };

    const result = await daemonRequest<{ ok: string }>(endpoint, "/api/folds", { method: "POST", body: { path: "/x" } });
    assert.equal(result.ok, "yes");
    assert.deepEqual(seen, [{ url: "/api/folds", auth: "Bearer tok", body: '{"path":"/x"}', loopback: true }]);
  });

  it("reports the daemon's error string from the socket as it does over TCP", async () => {
    const socketPath = join(tempDir(), "daemon.sock");
    const server = await listenUnix(socketPath, () => [403, JSON.stringify({ error: "nope" })]);
    closers.push(() => new Promise((r) => server.close(() => r())));
    const endpoint: DaemonEndpoint = { baseUrl: "http://127.0.0.1:1", token: "tok", port: "1", socketPath };
    await assert.rejects(daemonRequest(endpoint, "/api/x"), /^Error: nope$/);
  });

  it("streams NDJSON from the socket", async () => {
    const socketPath = join(tempDir(), "daemon.sock");
    const server = await listenUnix(socketPath, () => [200, '{"n":1}\n{"n":2}\n']);
    closers.push(() => new Promise((r) => server.close(() => r())));
    const endpoint: DaemonEndpoint = { baseUrl: "http://127.0.0.1:1", token: "tok", port: "1", socketPath };
    const lines: unknown[] = [];
    await daemonStream<{ n: number }>(endpoint, "/api/absorb", { method: "POST", body: {} }, (l) => lines.push(l));
    assert.deepEqual(lines, [{ n: 1 }, { n: 2 }]);
  });

  it("falls back to TCP when the socket is gone", async () => {
    const tcp = createHttpServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ via: "tcp", loopback: isLoopbackRequest(req) }));
    });
    await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise((r) => tcp.close(() => r())));
    const port = (tcp.address() as AddressInfo).port;
    const endpoint: DaemonEndpoint = {
      baseUrl: `http://127.0.0.1:${port}`,
      token: "tok",
      port: String(port),
      socketPath: join(tempDir(), "daemon.sock"),
    };
    assert.deepEqual(await daemonRequest(endpoint, "/api/status"), { via: "tcp", loopback: true });
  });
});

describe("the MCP bridge's dial target", () => {
  it("keeps the socket path out of the URL, so any home directory dials", async () => {
    // A space, non-ASCII and a colon: each broke the old ws+unix URL.
    const dir = mkdtempSync(join(tmpdir(), "brane sock josé:x-"));
    const socketPath = join(dir, "daemon.sock");
    const target = mcpDialTarget({ port: "4000", tls: true, token: "t/k", socketPath });
    assert.deepEqual(target, { url: "ws://localhost/ws/mcp?token=t%2Fk", socketPath });

    const wss = new WebSocketServer({ noServer: true });
    const server = createHttpServer();
    const seen: Array<{ url?: string; loopback: boolean }> = [];
    server.on("connection", (socket) => markUnixConnection(socket));
    server.on("upgrade", (req, socket, head) => {
      seen.push({ url: req.url, loopback: isLoopbackRequest(req) });
      wss.handleUpgrade(req, socket, head, (ws) => ws.close());
    });
    await new Promise<void>((r) => server.listen(socketPath, r));
    try {
      // What the bridge's connect() does with it: append its params, swap in
      // a session token, and hand the socket to ws as the connection.
      const u = new URL(`${target.url}&nid=claude-x`);
      u.searchParams.set("token", "agent");
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(u.toString(), { createConnection: () => netConnect(target.socketPath!) });
        ws.on("close", () => resolve());
        ws.on("error", reject);
      });
      assert.deepEqual(seen, [{ url: "/ws/mcp?token=agent&nid=claude-x", loopback: true }]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("dials TCP on loopback when there is no socket", () => {
    assert.deepEqual(mcpDialTarget({ port: "4000", tls: true, token: "t" }), { url: "wss://localhost:4000/ws/mcp?token=t" });
    assert.deepEqual(mcpDialTarget({ port: "4000", tls: false, token: "t" }), { url: "ws://localhost:4000/ws/mcp?token=t" });
  });
});

describe("falling back to TCP before anything was sent", () => {
  async function tcpEndpoint(socketPath: string): Promise<DaemonEndpoint> {
    const tcp = createHttpServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ via: "tcp" }));
    });
    await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
    after(() => new Promise<void>((r) => tcp.close(() => r())));
    const port = (tcp.address() as AddressInfo).port;
    return { baseUrl: `http://127.0.0.1:${port}`, token: "tok", port: String(port), socketPath };
  }

  it("when the socket refuses (a crashed daemon's file)", async () => {
    const path = crashedSocket();
    assert.deepEqual(await daemonRequest(await tcpEndpoint(path), "/api/status"), { via: "tcp" });
  });

  it("when the path is not a socket", async () => {
    const path = join(tempDir(), "daemon.sock");
    writeFileSync(path, "not a socket");
    assert.deepEqual(await daemonRequest(await tcpEndpoint(path), "/api/status"), { via: "tcp" });
  });
});

describe("a failure after the socket connected", () => {
  it("is reported, never retried over TCP, so a POST cannot run twice", async () => {
    let tcpHits = 0;
    const tcp = createHttpServer((_req, res) => {
      tcpHits++;
      res.end("{}");
    });
    await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
    const port = (tcp.address() as AddressInfo).port;
    const socketPath = join(tempDir(), "daemon.sock");
    // Accepts, reads the request, and drops the connection without answering.
    const dropper = createNetServer((sock) => sock.once("data", () => sock.destroy()));
    await new Promise<void>((r) => dropper.listen(socketPath, r));
    try {
      const endpoint: DaemonEndpoint = { baseUrl: `http://127.0.0.1:${port}`, token: "t", port: String(port), socketPath };
      await assert.rejects(daemonRequest(endpoint, "/api/spawn", { method: "POST", body: { agent: "claude" } }));
      assert.equal(tcpHits, 0);
    } finally {
      await new Promise<void>((r) => dropper.close(() => r()));
      await new Promise<void>((r) => tcp.close(() => r()));
    }
  });
});

describe("readDaemonSocket", () => {
  it("names the socket only while its file is there", () => {
    const db = createTestDb();
    const path = join(tempDir(), "daemon.sock");
    db.prepare("INSERT INTO meta (key, value) VALUES ('daemon_socket', ?)").run(path);
    assert.equal(readDaemonSocket(db), undefined);
    writeFileSync(path, "");
    assert.equal(readDaemonSocket(db), path);
  });
});

describe("connectionLabel", () => {
  it("is daemon.sock on the socket, else the remote address", () => {
    const unix = {};
    markUnixConnection(unix);
    assert.equal(connectionLabel(unix), UNIX_SOCKET_SIGHTING);
    assert.equal(connectionLabel({ remoteAddress: "100.64.0.7" }), "100.64.0.7");
    assert.equal(connectionLabel({}), null);
  });
});

describe("listenOnLocalSocket", () => {
  function fileDb(dir = tempDir()) {
    const db = new Database(join(dir, "brane.db"));
    db.exec(SCHEMA_SQL);
    applyMigrations(db);
    return db;
  }

  it("listens 0600 beside the database, advertises it, marks its connections, and removes it on close", async () => {
    const db = fileDb();
    const path = getSocketPath(db);
    const seen: boolean[] = [];
    const server = createHttpServer((req, res) => {
      seen.push(isLoopbackRequest(req));
      res.end("{}");
    });
    assert.equal(await listenOnLocalSocket(server, db), true);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.equal(readDaemonSocket(db), path);
    await daemonRequest({ baseUrl: "http://127.0.0.1:1", token: "t", port: "1", socketPath: path }, "/api/status");
    assert.deepEqual(seen, [true]);
    await new Promise<void>((r) => server.close(() => r()));
    assert.equal(existsSync(path), false);
  });

  it("takes over a crashed daemon's socket", async () => {
    const dir = tempDir();
    crashedSocket(join(dir, "daemon.sock"));
    const db = fileDb(dir);
    const server = createHttpServer();
    assert.equal(await listenOnLocalSocket(server, db), true);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("leaves anything else at the path alone, and says so", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "daemon.sock"), "mine");
    const db = fileDb(dir);
    const lines: string[] = [];
    assert.equal(await listenOnLocalSocket(createHttpServer(), db, (l) => lines.push(l)), false);
    assert.equal(readFileSync(join(dir, "daemon.sock"), "utf8"), "mine");
    assert.equal(readDaemonSocket(db), undefined);
    assert.match(lines[0], /in use or not a socket/);
  });

  it("skips a path too long for bind(2)", async () => {
    let dir = tempDir();
    while (Buffer.byteLength(join(dir, "daemon.sock")) <= MAX_SOCKET_PATH) {
      dir = join(dir, "d".repeat(20));
      mkdirSync(dir);
    }
    const db = fileDb(dir);
    const lines: string[] = [];
    assert.equal(await listenOnLocalSocket(createHttpServer(), db, (l) => lines.push(l)), false);
    assert.match(lines[0], /too long/);
  });
});

describe("clearStaleSocket", () => {
  it("frees a path with nothing at it", async () => {
    assert.equal(await clearStaleSocket(join(tempDir(), "daemon.sock")), true);
  });

  it("removes a socket nothing answers on, as a crashed daemon leaves", async () => {
    const path = crashedSocket();
    assert.equal(lstatSync(path).isSocket(), true);
    assert.equal(await clearStaleSocket(path), true);
    assert.equal(existsSync(path), false);
  });

  it("leaves a live socket alone", async () => {
    const path = join(tempDir(), "daemon.sock");
    const live = createNetServer((s) => s.end());
    await new Promise<void>((r) => live.listen(path, r));
    try {
      assert.equal(await clearStaleSocket(path), false);
      assert.equal(existsSync(path), true);
    } finally {
      await new Promise<void>((r) => live.close(() => r()));
    }
  });

  it("never touches a file that is not a socket", async () => {
    const path = join(tempDir(), "daemon.sock");
    writeFileSync(path, "not a socket");
    assert.equal(await clearStaleSocket(path), false);
    assert.equal(existsSync(path), true);
  });
});

describe("a token seen on daemon.sock and on loopback TCP", () => {
  it("is seen in one place, not flagged as a copy", () => {
    assert.equal(samePlace(UNIX_SOCKET_SIGHTING, "127.0.0.1"), true);
    assert.equal(samePlace("::1", UNIX_SOCKET_SIGHTING), true);
    assert.equal(samePlace(UNIX_SOCKET_SIGHTING, "100.64.0.7"), false);
  });
});
