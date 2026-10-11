import { defineCommand } from "citty";
import { openDatabase, getDaemonAddress, getPackageVersion } from "../db/schema.js";
import { startMcpBridge, type DaemonDial } from "../mcp/server.js";
import { connect as netConnect } from "node:net";
import { readDaemonSocket, resolveCredential } from "../daemon/client.js";
import { ensureDaemonRunning } from "./daemon.js";

/** Resolve daemon WebSocket URL, auto-starting daemon if needed */
async function resolveDaemonUrl(): Promise<DaemonDial | null> {
  let db = openDatabase();
  let info = getDaemonAddress(db);
  db.close();

  if (!info) {
    process.stderr.write("MCP bridge: daemon not running, starting it...\n");
    try {
      info = await ensureDaemonRunning();
    } catch {
      return null;
    }
  }

  // Check if daemon is running with TLS, and settle what to present: a
  // spawned agent's own token, or nothing — an unspawned client dials the
  // daemon's socket as this account, and `welcome` hands it a token.
  db = openDatabase();
  const tlsRow = db.prepare("SELECT value FROM meta WHERE key = 'daemon_tls'").get() as
    | { value: string }
    | undefined;
  let token: string | null;
  let socketPath: string | undefined;
  try {
    token = resolveCredential();
    socketPath = readDaemonSocket(db);
  } finally {
    db.close();
  }
  // Warn on version mismatch between this CLI and the running daemon
  if (info.version) {
    const myVersion = getPackageVersion();
    if (info.version !== myVersion) {
      process.stderr.write(
        `MCP bridge: version mismatch — daemon is v${info.version}, this CLI is v${myVersion}\n` +
        `  Consider: npm i -g brane (and check $PATH priority)\n`,
      );
    }
  }

  const tls = tlsRow?.value === "true";
  // The socket only if it answers now: the bridge re-resolves on every
  // reconnect, so a socket that stops answering falls back to TCP next time.
  const reachable = socketPath && (await socketAnswers(socketPath)) ? socketPath : undefined;
  if (token === null && !reachable) {
    // Over TCP a dial with no token is refused, so there is nothing to dial:
    // the first resolve exits ("daemon not available"), a reconnect retries.
    process.stderr.write("MCP bridge: the daemon's socket is not answering, and there is no token for TCP\n");
    return null;
  }
  return mcpDialTarget({ port: info.port, tls, token, socketPath: reachable });
}

/** Where `brane mcp` dials. Over the daemon's Unix socket when it has one —
 *  only this account can reach it, and there is no certificate to skip
 *  verifying — else TCP on loopback. A null token presents none. Pure, for src/test/daemon-socket.test.ts. */
export function mcpDialTarget(opts: { port: string; tls: boolean; token: string | null; socketPath?: string }): DaemonDial {
  // No token is only ever meant for the socket, where it acts as this account.
  const query = opts.token === null ? "/ws/mcp?" : `/ws/mcp?token=${encodeURIComponent(opts.token)}`;
  if (opts.socketPath) return { url: `ws://localhost${query}`, socketPath: opts.socketPath };
  return { url: `${opts.tls ? "wss" : "ws"}://localhost:${opts.port}${query}` };
}

function socketAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = netConnect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

export const mcpCommand = defineCommand({
  meta: {
    name: "mcp",
    description: "Run as MCP stdio server (for agent processes)",
  },
  async run() {
    startMcpBridge(resolveDaemonUrl);
  },
});
