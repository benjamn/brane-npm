import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

// The bridge when the agent's harness gives up on a call: Esc, or a killed
// background task, arrives as MCP `notifications/cancelled`. The bridge used
// to answer it "Method not found" — an error with no id, which Claude Code
// logs as a connection error — and never told the daemon, so a cancelled
// listen stayed parked and its narrative kept glowing as awaiting direction.
// Driven for real, as in mcp-bridge-reconnect.test.ts: a child runs the
// bridge, this test plays daemon on a WebSocket and agent on stdio.

const BRIDGE = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "server.js")).href;

function childEnv(port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), HOME: mkdtempSync(join(tmpdir(), "brane-bridge-")) };
  for (const k of Object.keys(env)) {
    if (k.startsWith("BRANE_") || k === "CLAUDE_CODE_SESSION_ID" || k === "NODE_TEST_CONTEXT") delete env[k];
  }
  // A spawned agent's credentials, so the bridge dials at startup and the
  // test can wait for its socket before calling (an unspawned bridge waits
  // for its first call: mcp-bridge-lazy-dial.test.ts).
  return { ...env, BRANE_NARRATIVE_ID: "claude-test0002", BRANE_NARRATIVE_SECRET: "s" };
}

describe("the MCP bridge when a call is cancelled", () => {
  it("tells the daemon, answers nothing, and drops a late result", async () => {
    const received: any[] = [];
    const sockets: WebSocket[] = [];
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, sock, head) => {
      wss.handleUpgrade(req, sock, head, (ws) => {
        sockets.push(ws);
        ws.send(JSON.stringify({ type: "welcome", brane_id: "b", narrative_id: "external-test0002", bind_secret: "s" }));
        ws.on("message", (d) => {
          const msg = JSON.parse(d.toString());
          received.push(msg);
          // listen parks: no answer until the test sends one by hand.
          if (msg.type === "tool_call" && msg.tool !== "listen") {
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
    const lines: any[] = [];
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) lines.push(JSON.parse(line));
      }
    });
    const send = (m: Record<string, unknown>) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    const until = async (pred: () => boolean, ms: number) => {
      const end = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > end) throw new Error("timed out waiting");
        await new Promise((r) => setTimeout(r, 25));
      }
    };

    try {
      await until(() => sockets.length === 1, 3000);
      send({ id: 7, method: "tools/call", params: { name: "listen", arguments: { after: 3 } } });
      await until(() => received.some((m) => m.type === "tool_call"), 3000);
      const listenCall = received.find((m) => m.type === "tool_call");

      send({ method: "notifications/cancelled", params: { requestId: 7, reason: "user-cancel" } });
      await until(() => received.some((m) => m.type === "tool_cancel"), 3000);
      assert.deepEqual(received.find((m) => m.type === "tool_cancel"), { type: "tool_cancel", id: listenCall.id });

      // The daemon answers anyway (it raced the cancel), and a notification
      // the bridge has never heard of arrives: neither may produce output.
      sockets[0].send(JSON.stringify({ type: "tool_result", id: listenCall.id, result: { late: true } }));
      send({ method: "notifications/somethingNew" });

      // A later call's answer is the fence: everything before it has landed.
      send({ id: 8, method: "tools/call", params: { name: "whoami", arguments: {} } });
      await until(() => lines.some((l) => l.id === 8), 3000);
      assert.deepEqual(lines.map((l) => l.id), [8], "only the live call is ever answered");
    } finally {
      child.kill();
      for (const s of sockets) s.terminate();
      wss.close();
      server.close();
    }
  });
});
