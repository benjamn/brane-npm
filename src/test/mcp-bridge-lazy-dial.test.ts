import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

// When the bridge dials the daemon. Every dial by a bridge that can't prove a
// narrative mints an `external-*` one, so such a bridge must not dial until
// it is asked to do something. Codex's brane config is global, and every
// Codex subagent session started a bridge that dialed at startup and left a
// one-event external behind (claude-g7b4qxpm:3). A spawned agent's bridge
// holds its narrative id and secret, so it still dials at startup.

const BRIDGE = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "server.js")).href;

function childEnv(port: number, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), HOME: mkdtempSync(join(tmpdir(), "brane-bridge-")) };
  // Whatever session this suite runs inside must not leak into the child's dial.
  for (const k of Object.keys(env)) {
    if (k.startsWith("BRANE_") || k === "CLAUDE_CODE_SESSION_ID" || k === "NODE_TEST_CONTEXT") delete env[k];
  }
  return { ...env, ...extra };
}

async function until(pred: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A daemon stand-in that records each dial and answers every tool call,
 *  or, with `refuse`, turns every upgrade away with a 503. */
async function fakeDaemon(opts: { refuse?: boolean } = {}): Promise<{ server: Server; wss: WebSocketServer; port: number; urls: string[]; sockets: WebSocket[] }> {
  const urls: string[] = [];
  const sockets: WebSocket[] = [];
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, sock, head) => {
    urls.push(req.url ?? "");
    if (opts.refuse) {
      sock.write("HTTP/1.1 503 Busy\r\n\r\n");
      sock.destroy();
      return;
    }
    wss.handleUpgrade(req, sock, head, (ws) => {
      sockets.push(ws);
      ws.send(JSON.stringify({ type: "welcome", brane_id: "b", narrative_id: "external-test0002", bind_secret: "s3cret" }));
      ws.on("message", (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.type === "tool_call") ws.send(JSON.stringify({ type: "tool_result", id: msg.id, result: { ok: msg.tool } }));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, wss, port: (server.address() as { port: number }).port, urls, sockets };
}

/** Start a bridge whose daemon lookup finds nothing for its first `NULLS`
 *  attempts (env, default 0), as when the daemon can't be reached, and the
 *  fake daemon after that. */
function startBridge(env: NodeJS.ProcessEnv): { child: ChildProcessWithoutNullStreams; replies: Map<number, any>; send: (id: number, method: string, params?: unknown) => void } {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e",
      `const { startMcpBridge } = await import(${JSON.stringify(BRIDGE)});
       let nulls = Number(process.env.NULLS ?? 0);
       startMcpBridge(async () => nulls-- > 0 ? null : "ws://127.0.0.1:" + process.env.PORT + "/ws/mcp?token=t");`],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const replies = new Map<number, any>();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) {
        const m = JSON.parse(line);
        replies.set(m.id, m);
      }
    }
  });
  const send = (id: number, method: string, params?: unknown) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
  return { child, replies, send };
}

describe("when the MCP bridge dials the daemon", () => {
  it("an unspawned bridge answers initialize and tools/list without dialing, and dials on its first call", async () => {
    const d = await fakeDaemon();
    const b = startBridge(childEnv(d.port));
    try {
      b.send(1, "initialize", {});
      b.send(2, "tools/list");
      await until(() => b.replies.has(1) && b.replies.has(2), 3000);
      assert.ok(b.replies.get(2).result.tools.length > 0, "tools are listed from the bridge itself");
      // Give an eager dial ample time to have happened.
      await sleep(300);
      assert.equal(d.urls.length, 0, "no tool call, no dial, and so no minted narrative");

      b.send(3, "tools/call", { name: "whoami", arguments: {} });
      await until(() => b.replies.has(3), 3000);
      assert.deepEqual(JSON.parse(b.replies.get(3).result.content[0].text), { ok: "whoami" });
      assert.equal(d.urls.length, 1, "the first call dials, once");

      b.send(4, "tools/call", { name: "listen", arguments: { wait: false } });
      await until(() => b.replies.has(4), 3000);
      assert.equal(d.urls.length, 1, "later calls reuse the connection");
    } finally {
      b.child.kill();
      for (const s of d.sockets) s.terminate();
      d.wss.close();
      d.server.close();
    }
  });

  it("a bridge with an id but no secret waits too: its claim could only be refused and minted afresh", async () => {
    const d = await fakeDaemon();
    const b = startBridge(childEnv(d.port, { BRANE_NARRATIVE_ID: "codex-parent01" }));
    try {
      b.send(1, "tools/list");
      await until(() => b.replies.has(1), 3000);
      await sleep(300);
      assert.equal(d.urls.length, 0);

      // Its first call dials, claiming the id and presenting no secret: the
      // daemon refuses that claim and mints it an external of its own.
      b.send(2, "tools/call", { name: "whoami", arguments: {} });
      await until(() => b.replies.has(2), 3000);
      assert.equal(d.urls.length, 1);
      const u = new URL(d.urls[0], "ws://x");
      assert.equal(u.searchParams.get("nid"), "codex-parent01");
      assert.equal(u.searchParams.has("secret"), false);
    } finally {
      b.child.kill();
      for (const s of d.sockets) s.terminate();
      d.wss.close();
      d.server.close();
    }
  });

  it("a spawned agent's bridge, holding its id and secret, dials at startup", async () => {
    const d = await fakeDaemon();
    const b = startBridge(childEnv(d.port, { BRANE_NARRATIVE_ID: "codex-spawned1", BRANE_NARRATIVE_SECRET: "agent-secret" }));
    try {
      await until(() => d.urls.length === 1, 3000);
      const u = new URL(d.urls[0], "ws://x");
      assert.equal(u.searchParams.get("nid"), "codex-spawned1");
      assert.equal(u.searchParams.get("secret"), "agent-secret");
    } finally {
      b.child.kill();
      for (const s of d.sockets) s.terminate();
      d.wss.close();
      d.server.close();
    }
  });
  it("a first call that finds no daemon backs off and retries, rather than exiting", async () => {
    const d = await fakeDaemon();
    const b = startBridge(childEnv(d.port, { NULLS: "1" }));
    let exited = false;
    b.child.on("exit", () => { exited = true; });
    try {
      b.send(1, "tools/call", { name: "whoami", arguments: {} });
      await until(() => b.replies.has(1), 5000); // the retry comes after ~1s
      assert.deepEqual(JSON.parse(b.replies.get(1).result.content[0].text), { ok: "whoami" });
      assert.equal(d.urls.length, 1, "the failed lookup dialed nothing; the retry dialed once");
      assert.equal(exited, false);
    } finally {
      b.child.kill();
      for (const s of d.sockets) s.terminate();
      d.wss.close();
      d.server.close();
    }
  });

  it("a bridge that never reached the daemon exits when its client closes, answering what it queued", async () => {
    const d = await fakeDaemon();
    const b = startBridge(childEnv(d.port, { NULLS: "1000" }));
    // `close`, not `exit`: it fires once stdout has drained, so the reply
    // the bridge wrote on its way out has been read (claude-zii7zeix:11).
    const exit = new Promise<number | null>((r) => b.child.on("close", (code) => r(code)));
    try {
      b.send(1, "tools/call", { name: "narrate", arguments: { say: "hello" } });
      await sleep(300); // the lookup has failed and a retry is scheduled
      b.child.stdin.end();
      const code = await Promise.race([exit, sleep(3000).then(() => "still running" as const)]);
      assert.equal(code, 0, "the bridge outlives its client otherwise (claude-zii7zeix:5)");
      assert.equal(b.replies.get(1)?.result?.isError, true, "the queued call is answered, not dropped");
      assert.equal(d.urls.length, 0);
    } finally {
      b.child.kill();
      d.wss.close();
      d.server.close();
    }
  });
  it("a bridge whose dial fails after its client closes exits too, answering what it queued", async () => {
    // The other way to `giveUp()`: stdin closes while the first dial is
    // under way, so the drain loop waits on it; the daemon then refuses the
    // upgrade, and the retry that would follow finds stdin closed.
    const d = await fakeDaemon({ refuse: true });
    const b = startBridge(childEnv(d.port));
    const exit = new Promise<number | null>((r) => b.child.on("close", (code) => r(code)));
    try {
      b.send(1, "tools/call", { name: "narrate", arguments: { say: "hello" } });
      b.child.stdin.end();
      const code = await Promise.race([exit, sleep(3000).then(() => "still running" as const)]);
      assert.equal(code, 0);
      assert.equal(d.urls.length, 1, "it dialed once and was refused");
      assert.equal(b.replies.get(1)?.result?.isError, true, "the queued call is answered, not dropped");
    } finally {
      b.child.kill();
      d.wss.close();
      d.server.close();
    }
  });
});
