import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { createTestDb } from "./helpers.js";
import { claimDaemon, getDaemonAddress, otherDaemon } from "../db/schema.js";
import {
  LAUNCH_ENV,
  clearStop,
  describeOrigin,
  implicitStartRefusal,
  isDaemonCommand,
  originFromEnv,
  originsDiffer,
  parseTmuxEnvironment,
  readStop,
  recordStop,
  restartPort,
  startupRefusal,
  successorArgs,
} from "../daemon/lifecycle.js";

// `brane daemon stop` used to be undone within seconds: every agent's MCP
// bridge reconnected, found no daemon, and started one, which then inherited
// that bridge's confinement and handed it to every agent it launched
// (claude-apqiedkc:5, :8). These pin who may start a daemon, and what a
// restart passes on.

describe("the operator's stop", () => {
  it("is recorded, read back, and cleared by an explicit start", () => {
    const db = createTestDb();
    assert.equal(readStop(db), null);
    recordStop(db, 4242, new Date("2026-11-20T12:00:00Z"));
    assert.deepEqual(readStop(db), { at: "2026-11-20T12:00:00.000Z", pid: 4242 });
    clearStop(db);
    assert.equal(readStop(db), null);
  });

  it("refuses every implicit start while it stands, saying when and how to undo it", () => {
    const db = createTestDb();
    recordStop(db, undefined, new Date("2026-11-20T12:00:00Z"));
    for (const who of ["cli", "bridge"] as const) {
      const refusal = implicitStartRefusal(db, who, {});
      assert.match(refusal ?? "", /stopped with `brane daemon stop` at 2026-11-20T12:00:00\.000Z/);
      assert.match(refusal ?? "", /brane daemon start/);
    }
  });

  it("makes a daemon spawned implicitly refuse to claim the role", () => {
    const db = createTestDb();
    recordStop(db, undefined);
    assert.match(startupRefusal(db) ?? "", /stopped/);
    const claim = claimDaemon(db);
    assert.equal(claim.claimed, false);
    assert.ok("stopped" in claim);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'daemon_pid'").get(), undefined, "nothing claimed");
  });
});

describe("who may start a daemon without being asked", () => {
  it("never an MCP bridge, stopped or not", () => {
    const db = createTestDb();
    assert.match(implicitStartRefusal(db, "bridge", {}) ?? "", /never starts one/);
  });

  it("never a command in an agent's session", () => {
    const db = createTestDb();
    assert.match(implicitStartRefusal(db, "cli", { BRANE_NARRATIVE_SECRET: "x" }) ?? "", /agent's session never starts one/);
  });

  it("a command from the operator's own shell, while nothing is stopped", () => {
    const db = createTestDb();
    assert.equal(implicitStartRefusal(db, "cli", {}), null);
  });
});

describe("claiming the daemon role", () => {
  it("takes a claim handed to it in place: its own pid already in the row", () => {
    const db = createTestDb();
    db.prepare("INSERT INTO meta (key, value) VALUES ('daemon_pid', ?)").run(String(process.pid));
    assert.deepEqual(claimDaemon(db), { claimed: true });
  });

  it("still loses to another live daemon", () => {
    const db = createTestDb();
    db.prepare("INSERT INTO meta (key, value) VALUES ('daemon_pid', ?)").run(String(process.ppid));
    assert.deepEqual(claimDaemon(db), { claimed: false, pid: process.ppid });
  });

  // `daemon start` asks this before claiming. Asking `getDaemonAddress`
  // instead made every in-place successor see its own pid, say "Daemon
  // already running", and exit; the claim tests above never caught it, since
  // they call `claimDaemon` directly (claude-ykehtq5h:20, item A).
  it("is no other daemon when the pid row names the one starting", () => {
    const db = createTestDb();
    db.prepare("INSERT INTO meta (key, value) VALUES ('daemon_pid', ?), ('daemon_port', '4321')").run(String(process.pid));
    assert.ok(getDaemonAddress(db), "the row does name a live daemon");
    assert.equal(otherDaemon(db, process.pid), null);
  });

  it("is another daemon when the pid row names a different live process", () => {
    const db = createTestDb();
    db.prepare("INSERT INTO meta (key, value) VALUES ('daemon_pid', ?), ('daemon_port', '4321')").run(String(process.ppid));
    assert.deepEqual(otherDaemon(db, process.pid), { port: "4321", version: undefined });
  });

  it("is no daemon at all without a pid row", () => {
    const db = createTestDb();
    db.prepare("INSERT INTO meta (key, value) VALUES ('daemon_port', '4321')").run();
    assert.equal(otherDaemon(db, process.pid), null);
  });
});

describe("a daemon's successor, restarting in place", () => {
  it("runs the daemon's own script and subcommand, on the given port, without its token", () => {
    assert.deepEqual(
      successorArgs(["--enable-source-maps"], ["/usr/bin/node", "/x/dist/cli.js", "daemon", "start", "--foreground", "--port", "1234", "--token", "secret", "--bind", "127.0.0.1"], "5678"),
      ["--enable-source-maps", "/x/dist/cli.js", "daemon", "start", "--foreground", "--bind", "127.0.0.1", "--port", "5678"],
    );
  });

  it("runs in the foreground even if the daemon's argv did not say so", () => {
    assert.deepEqual(
      successorArgs([], ["node", "/x/dist/cli.js", "daemon", "start", "--port=1", "--token=s"], "2"),
      ["/x/dist/cli.js", "daemon", "start", "--foreground", "--port", "2"],
    );
  });
});

describe("the restart route's port", () => {
  it("keeps the daemon's port unless one is named", () => {
    assert.deepEqual(restartPort(null, "4321", "agent"), { port: "4321" });
    assert.deepEqual(restartPort("{}", "4321", "local"), { port: "4321" });
    assert.deepEqual(restartPort('{"port":4321}', "4321", "agent"), { port: "4321" }, "naming the same port is no move");
  });

  it("moves it only for the operator's shell: a move breaks every link to the daemon", () => {
    assert.deepEqual(restartPort('{"port":5678}', "4321", "local"), { port: "5678" });
    const refused = restartPort('{"port":5678}', "4321", "agent");
    assert.equal("status" in refused && refused.status, 403);
  });

  it("refuses what is not a port, or not JSON", () => {
    for (const body of ['{"port":0}', '{"port":70000}', '{"port":"x"}']) {
      const refused = restartPort(body, "4321", "local");
      assert.equal("status" in refused && refused.status, 400, body);
    }
    assert.deepEqual(restartPort("{", "4321", "local"), { status: 400, error: "Body must be JSON" });
    assert.equal("status" in restartPort(null, undefined, "local"), true, "no port anywhere");
  });
});

describe("what `daemon stop` will signal", () => {
  it("a pid whose command line is `daemon start`, and nothing else a dead daemon's row may name", () => {
    assert.equal(isDaemonCommand("/usr/local/bin/node /x/dist/cli.js daemon start --foreground --port 1234"), true);
    assert.equal(isDaemonCommand("node /usr/local/bin/brane daemon start"), true);
    assert.equal(isDaemonCommand("/Applications/Safari.app/Contents/MacOS/Safari"), false);
    assert.equal(isDaemonCommand("node /x/dist/cli.js daemon stop"), false);
    assert.equal(isDaemonCommand("vim daemon-start.md"), false);
  });
});

describe("how a daemon was launched", () => {
  it("is dropped at startup, marker included, so no pane can pass a typed start off as a spawned one", () => {
    assert.deepEqual([...LAUNCH_ENV].sort(), ["BRANE_DAEMON_DETACHED", "BRANE_DAEMON_HANDOFF_FROM", "BRANE_DAEMON_VIA"]);
  });
});

// The CLI refuses an agent's session these before opening anything, so no
// prompt is raised and no database is read (openDatabase throws under test).
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out }));
  });
}

describe("an agent's session, at the lifecycle commands", () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: mkdtempSync(join(tmpdir(), "brane-agent-cli-")),
    BRANE_NARRATIVE_SECRET: "an-agent",
    BRANE_DAEMON_DETACHED: "1", // what panes inherited from older daemons
  };

  it("may not stop the daemon, and is told to ask the operator", async () => {
    const { code, out } = await runCli(["daemon", "stop"], env);
    assert.equal(code, 1);
    assert.match(out, /Ask the operator to run `brane daemon stop`/);
  });

  it("may not start one, even carrying the spawned marker", async () => {
    const { code, out } = await runCli(["daemon", "start", "--foreground"], env);
    assert.equal(code, 1);
    assert.match(out, /does not start brane's daemon/);
  });
});

describe("where a process came from", () => {
  it("reads the app, terminal, tmux, ssh and VS Code markers off its environment", () => {
    assert.deepEqual(
      originFromEnv({ __CFBundleIdentifier: "com.apple.Terminal", TERM_PROGRAM: "tmux", TMUX: "/tmp/tmux-501/default,1,0", BRANE_DAEMON_VIA: "brane daemon start" }),
      { via: "brane daemon start", app: "com.apple.Terminal", term_program: "tmux", tmux: true },
    );
    assert.deepEqual(originFromEnv({ TERM_PROGRAM: "vscode", SSH_CONNECTION: "a b c d" }), { term_program: "vscode", ssh: true, vscode: true });
  });

  it("describes it in a line", () => {
    assert.equal(
      describeOrigin({ via: "brane daemon start", app: "com.apple.Terminal", term_program: "Apple_Terminal" }),
      "brane daemon start — com.apple.Terminal, TERM_PROGRAM=Apple_Terminal",
    );
    assert.equal(describeOrigin({ app: "com.apple.Terminal", tmux: true }), "com.apple.Terminal, inside tmux");
    assert.equal(describeOrigin({}), "no terminal markers in its environment");
  });

  it("calls two origins different when the app, VS Code or ssh differs, not the terminal program", () => {
    assert.equal(originsDiffer({ app: "com.apple.Terminal" }, { app: "com.microsoft.VSCode", vscode: true }), true);
    assert.equal(originsDiffer({ app: "com.apple.Terminal", term_program: "tmux" }, { app: "com.apple.Terminal" }), false);
    assert.equal(originsDiffer({}, { ssh: true }), true);
  });

  it("parses a tmux server's global environment, leaving out unset names", () => {
    assert.deepEqual(parseTmuxEnvironment("A=1\n-B\nC=x=y\n\n"), { A: "1", C: "x=y" });
  });
});

// The bridge, when no daemon is running and it may not start one.

const BRIDGE = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "server.js")).href;

async function until(pred: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("an MCP bridge with no daemon to dial", () => {
  it("answers a call at once with why, holds a listen, and sends it once the daemon is back", async () => {
    const sockets: WebSocket[] = [];
    const calls: string[] = [];
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, sock, head) => {
      wss.handleUpgrade(req, sock, head, (ws) => {
        sockets.push(ws);
        ws.on("message", (d) => {
          const msg = JSON.parse(d.toString());
          if (msg.type === "tool_call") {
            calls.push(msg.tool);
            ws.send(JSON.stringify({ type: "tool_result", id: msg.id, result: { ok: msg.tool } }));
          }
        });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;

    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), HOME: mkdtempSync(join(tmpdir(), "brane-bridge-")) };
    for (const k of Object.keys(env)) {
      if (k.startsWith("BRANE_") || k === "CLAUDE_CODE_SESSION_ID" || k === "NODE_TEST_CONTEXT") delete env[k];
    }
    // The daemon is down until the bridge has looked twice, then up.
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e",
        `const { startMcpBridge } = await import(${JSON.stringify(BRIDGE)});
         let downs = 2;
         startMcpBridge(async () => downs-- > 0 ? { down: "stopped by the operator; run brane daemon start" } : "ws://127.0.0.1:" + process.env.PORT + "/ws/mcp?token=t");`],
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
    try {
      send(1, "tools/call", { name: "listen", arguments: {} });
      send(2, "tools/call", { name: "whoami", arguments: {} });
      await until(() => replies.has(2), 3000);
      assert.equal(replies.get(2).result.isError, true);
      assert.match(replies.get(2).result.content[0].text, /stopped by the operator; run brane daemon start/);
      assert.equal(replies.has(1), false, "the listen waits for the daemon");

      // The next lookup (after a 1 s backoff) still finds it down; the one
      // after (2 s later) finds it up, and the held listen goes out.
      await until(() => replies.has(1), 8000);
      assert.deepEqual(JSON.parse(replies.get(1).result.content[0].text), { ok: "listen" });
      assert.deepEqual(calls, ["listen"], "the call answered as down was never sent");
    } finally {
      child.kill();
      for (const s of sockets) s.terminate();
      wss.close();
      server.close();
    }
  });
});

describe("an MCP bridge holding a listen while no daemon runs", () => {
  it("answers it as a listen that timed out, before a client's own tool timeout would", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: mkdtempSync(join(tmpdir(), "brane-bridge-")) };
    for (const k of Object.keys(env)) {
      if (k.startsWith("BRANE_") || k === "CLAUDE_CODE_SESSION_ID" || k === "NODE_TEST_CONTEXT") delete env[k];
    }
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e",
        `const { startMcpBridge } = await import(${JSON.stringify(BRIDGE)});
         startMcpBridge(async () => ({ down: "stopped by the operator" }), { heldListenMs: 400 });`],
      { env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let buf = "";
    const replies = new Map<number, any>();
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
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "listen", arguments: {} } }) + "\n");
      await until(() => replies.has(1), 5000);
      const reply = replies.get(1);
      assert.notEqual(reply.result.isError, true);
      const result = JSON.parse(reply.result.content[0].text);
      assert.equal(result.timed_out, true);
      assert.deepEqual(result.events, {});
      assert.match(result.daemon, /stopped by the operator/);
      assert.ok(result.waited_ms >= 400);
    } finally {
      child.kill();
    }
  });
});
