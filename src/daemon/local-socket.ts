/**
 * The daemon's Unix-domain socket, `daemon.sock` beside the database.
 *
 * It is how a process on this machine reaches the daemon with the kernel
 * vouching for who it is: connecting means resolving the path, which takes
 * search permission on `~/.brane`, and that directory is 0700 — so only this
 * Unix account (and root) gets in. Loopback TCP cannot say as much: any
 * account on the machine can dial 127.0.0.1. See SECURITY.md, "Who the
 * operator is".
 *
 * A connection over the socket gains loopback standing (`isLoopbackRequest`),
 * and a request on it that presents no token acts as this account — the
 * live `local` row — for as long as `accountDirTrust` holds.
 */

import { connect, type Socket } from "node:net";
import { chmodSync, lstatSync, statSync, unlinkSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { UNIX_SOCKET_SIGHTING } from "../db/tokens.js";

/** `daemon.sock` beside a database. */
export function getSocketPath(db: Database.Database): string {
  return join(dirname(db.name), "daemon.sock");
}

/** Whether the directory holding the socket still makes "reached the
 *  socket" mean "is this Unix account": owned by the daemon's own uid, with
 *  no group or other permission bits. Both chmods that set this up swallow
 *  their errors, and anyone may loosen it later, so it is checked when it is
 *  relied on, not once at startup. Follows a symlinked directory, as
 *  resolving the socket's path does. */
export function accountDirTrust(dir: string): { ok: true } | { ok: false; reason: string } {
  const uid = process.getuid?.();
  if (uid === undefined) return { ok: false, reason: "this platform has no Unix uids" };
  let st;
  try {
    st = statSync(dir);
  } catch (err) {
    return { ok: false, reason: `${dir}: ${(err as NodeJS.ErrnoException).code ?? String(err)}` };
  }
  if (st.uid !== uid) return { ok: false, reason: `${dir} is owned by uid ${st.uid}, not this daemon's ${uid}` };
  if ((st.mode & 0o077) !== 0) {
    return { ok: false, reason: `${dir} is mode ${(st.mode & 0o777).toString(8)}; other accounts could reach the socket (want 700)` };
  }
  return { ok: true };
}

/** The longest path `bind(2)` takes for a Unix socket: `sun_path` is 104
 *  bytes on macOS (108 on Linux), terminator included. */
export const MAX_SOCKET_PATH = 103;

/** Connections accepted on the Unix socket. `isLoopbackRequest` consults it,
 *  since such a socket has no remote address to judge by. */
const unixConnections = new WeakSet<object>();

export function markUnixConnection(socket: object): void {
  unixConnections.add(socket);
}

export function isUnixConnection(socket: object): boolean {
  return unixConnections.has(socket);
}

/** Where a connection came from, for token sightings and log lines:
 *  `daemon.sock` for the Unix socket, which has no address of its own, else
 *  the remote address, or null when even that is gone. */
export function connectionLabel(socket: { remoteAddress?: string }): string | null {
  return isUnixConnection(socket) ? UNIX_SOCKET_SIGHTING : (socket.remoteAddress ?? null);
}

/**
 * Make `path` free to listen on. A clean shutdown leaves nothing behind
 * (closing the server unlinks it); a crash leaves the socket file, which
 * `listen()` would refuse. Only a socket whose connect is refused
 * (ECONNREFUSED) is removed: one that accepts a connection belongs to a live
 * daemon, and any other error is no proof either way, so both are left alone.
 * Callers hold the daemon claim, so that would be another brane dir's
 * daemon, or not a daemon at all.
 *
 * Anything at `path` that is not a socket is never touched.
 *
 * Resolves `true` when `path` is free, `false` when it is not and stays so.
 */
export async function clearStaleSocket(path: string): Promise<boolean> {
  let isSocket: boolean;
  try {
    isSocket = lstatSync(path).isSocket();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"; // nothing there
  }
  if (!isSocket) return false;
  // Only a refusal proves nothing is listening. Any other failure — no
  // permission, no file descriptors, a live listener's full backlog — proves
  // nothing, and the path is left alone.
  const refused = await new Promise<boolean>((resolve) => {
    const probe: Socket = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(false);
    });
    probe.once("error", (err: NodeJS.ErrnoException) => resolve(err.code === "ECONNREFUSED"));
  });
  if (!refused) return false;
  unlinkSync(path);
  return true;
}

/**
 * Start `server` on the socket beside `db` and advertise it as
 * `meta.daemon_socket`. Never throws: a path too long for `bind(2)`, a path
 * that is in use or not a socket, or a failed `listen()` is logged and
 * answered `false`. Agents and devices still reach the daemon over TCP with
 * their tokens; this account's shell, which holds none, cannot. Marks each accepted
 * connection, so `isLoopbackRequest` and `connectionLabel` know it.
 */
export async function listenOnLocalSocket(
  server: Server,
  db: Database.Database,
  log: (line: string) => void = (line) => console.warn(line),
): Promise<boolean> {
  const path = getSocketPath(db);
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH) {
    log(`[socket] ${path} is too long for a Unix socket (${Buffer.byteLength(path)} bytes, limit ${MAX_SOCKET_PATH})`);
    return false;
  }
  server.on("connection", (socket) => markUnixConnection(socket));
  try {
    if (!(await clearStaleSocket(path))) {
      log(`[socket] ${path} is in use or not a socket; left alone`);
      return false;
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (err) {
    log(`[socket] could not listen on ${path}: ${(err as Error).message}`);
    return false;
  }
  // The directory is what keeps other accounts out; on Linux the socket's
  // own mode is checked too.
  try { chmodSync(path, 0o600); } catch {}
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('daemon_socket', ?)").run(path);
  return true;
}
