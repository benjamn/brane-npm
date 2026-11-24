#!/usr/bin/env node
/**
 * The wake door of a Fly machine (docs/sleep.md, protocols/fly.md).
 *
 * A stopped Fly machine is started by Fly Proxy when a request arrives for
 * an `[http_service]` with `auto_start_machines = true`. The proxy needs a
 * port to route that request to, and it must never be the daemon's: the
 * image runs the daemon under `--bind 0.0.0.0`, where it has no IP filter,
 * so anything the proxy could reach would be reachable from the internet.
 * This is that port, served by a separate process with nothing of brane's
 * behind it.
 *
 * It is unauthenticated on purpose. The proxy starts the machine before any
 * request reaches this listener, so a token in the path would protect
 * nothing; the bounds are the app name's entropy and the daemon's idle rule.
 * By the time the response is written the machine is already up, which is
 * all a wake means: `GET` or `HEAD /wake` answers 204, anything else 404,
 * both with empty bodies.
 *
 * Logging: one startup line, then one short line per `/wake` hit (a wake is
 * an event the operator may want to see in `fly logs`) and nothing for a
 * 404, so a stray scan of the public hostname doesn't fill the log. Nothing
 * from the request (path, headers, body, address) is ever written.
 *
 * Standalone by design: only `node:*` imports, so it starts in a few tens
 * of milliseconds, before tailscaled, and fails independently of the daemon.
 */

import { createServer, type Server } from "node:http";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEFAULT_WAKE_PORT = 8080;

export interface WakeListenerOptions {
  /** Called once per answered `/wake`. Defaults to a one-line console log. */
  onWake?: () => void;
}

export function createWakeListener(options: WakeListenerOptions = {}): Server {
  const onWake = options.onWake ?? (() => console.log("wake-listener: /wake"));
  const server = createServer((req, res) => {
    // Never read the body; drain it so a POST can't hold the socket open.
    req.resume();
    const path = (req.url ?? "").split("?", 1)[0];
    if (path === "/wake" && (req.method === "GET" || req.method === "HEAD")) {
      onWake();
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    res.writeHead(404, { "Cache-Control": "no-store", "Content-Length": "0" });
    res.end();
  });
  // Slow or idle clients get nothing out of this door; don't keep them.
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

/** WAKE_PORT, if it's a valid port number; otherwise the default. */
export function wakePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WAKE_PORT;
  if (raw === undefined || raw === "") return DEFAULT_WAKE_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`wake-listener: WAKE_PORT=${JSON.stringify(raw)} is not a port`);
  }
  return n;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const port = wakePort();
  const server = createWakeListener();
  // 0.0.0.0, not a specific address: Fly Proxy reaches the machine on its
  // private IPv4, and with userspace tailscaled no tailnet address is on a
  // kernel interface to bind to anyway (see docker-entrypoint.sh).
  server.listen(port, "0.0.0.0", () => {
    console.log(`wake-listener: listening on 0.0.0.0:${port} (GET /wake -> 204)`);
  });
  server.on("error", (err) => {
    console.error(`wake-listener: ${err.message}`);
    process.exit(1);
  });
}
