import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

// The bridge across a lost connection, driven for real: a child process runs
// `startMcpBridge` against a WebSocket server this test plays daemon on, and the
// test plays the agent on the child's stdio.
//
// A call the bridge had *sent* when the connection went is ambiguous — the
// daemon may have run it — so the agent is told so. A call still *queued* was
// never sent, and must go out on reconnect exactly once, with no error. The
// bridge used to fail both, and then send the queued one anyway: an error the
// agent would act on (retrying ran the call twice), and a waiting narrate
// parked on the daemon with nobody left to answer it.

const BRIDGE = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "server.js")).href;

type Frame = { conn: number; msg: any };

function childEnv(port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), HOME: mkdtempSync(join(tmpdir(), "brane-bridge-")) };
  // Whatever session this suite runs inside must not leak into the child's dial.
  for (const k of Object.keys(env)) {
    if (k.startsWith("BRANE_") || k === "CLAUDE_CODE_SESSION_ID" || k === "NODE_TEST_CONTEXT") delete env[k];
  }
  return env;
}

describe("the MCP bridge across a lost connection", () => {
  it("fails the call it had sent, and sends the queued one once, without an error", async () => {
    const received: Frame[] = [];
    const urls: string[] = [];
    let conn = 0;
    const sockets: WebSocket[] = [];
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, sock, head) => {
      const n = ++conn;
      urls.push(req.url ?? "");
      // The second dial is refused, so the queued call has to survive a failed
      // reconnect (which fires `close`, and with it the fail path) too.
      if (n === 2) {
        sock.write("HTTP/1.1 503 Busy\r\n\r\n");
        sock.destroy();
        return;
      }
      wss.handleUpgrade(req, sock, head, (ws) => {
        sockets.push(ws);
        ws.send(JSON.stringify({ type: "welcome", brane_id: "b", narrative_id: "external-test0001", bind_secret: "s3cret" }));
        ws.on("message", (d) => {
          const msg = JSON.parse(d.toString());
          received.push({ conn: n, msg });
          if (n === 1 && msg.type === "tool_call") {
            ws.terminate(); // the daemon took the call and the connection died
          } else if (msg.type === "tool_call") {
            ws.send(JSON.stringify({ type: "tool_result", id: msg.id, result: { ok: msg.tool } }));
          }
        });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;

    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e",
        `const { startMcpBridge } = await import(${JSON.stringify(BRIDGE)});
         startMcpBridge(async () => "ws://127.0.0.1:" + process.env.PORT + "/ws/mcp?token=t");`],
      { env: childEnv(port), stdio: ["pipe", "pipe", "pipe"] },
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
    const call = (id: number, name: string, args: Record<string, unknown>) =>
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    const until = async (pred: () => boolean, ms: number) => {
      const end = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > end) throw new Error("timed out waiting");
        await new Promise((r) => setTimeout(r, 25));
      }
    };

    try {
      // An unspawned bridge dials on its first call, not at startup, so this
      // one is queued, then sent on conn 1 once it opens, and then the conn dies.
      call(1, "narrate", { say: "hello", wait: true });
      await until(() => sockets.length === 1, 3000);
      await until(() => replies.has(1), 3000);
      call(2, "listen", { after: 1, wait: false });     // queued: no connection right now
      await until(() => replies.has(2), 8000);          // answered by conn 3

      const r1 = replies.get(1).result;
      assert.equal(r1.isError, true, "the sent call is ambiguous and says so");
      assert.match(r1.content[0].text, /may already have been posted/);

      const r2 = replies.get(2).result;
      assert.ok(!r2.isError, "the queued call was never sent, so it is not failed");
      assert.deepEqual(JSON.parse(r2.content[0].text), { ok: "listen" });

      const calls = received.filter((f) => f.msg.type === "tool_call");
      assert.deepEqual(
        calls.map((f) => [f.conn, f.msg.tool]),
        [[1, "narrate"], [3, "listen"]],
        "each call reaches the daemon exactly once: the failed one is not replayed",
      );

      // #497: an unspawned client adopts the narrative *and* the secret its
      // first welcome hands it, so its reconnect proves it rather than being
      // refused and minted a different narrative.
      const redial = new URL(urls[2], "ws://x");
      assert.equal(redial.searchParams.get("nid"), "external-test0001");
      assert.equal(redial.searchParams.get("secret"), "s3cret");
    } finally {
      child.kill();
      for (const s of sockets) s.terminate();
      wss.close();
      server.close();
    }
  });
});
