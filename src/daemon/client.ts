import { openDatabase, getPackageVersion } from "../db/schema.js";
import { request as httpRequest } from "node:http";
import { existsSync } from "node:fs";
import { getTailscaleHost } from "../tailscale.js";
import { ensureDaemonRunning } from "../commands/daemon.js";

/** A resolved, reachable daemon: where to send HTTP requests, plus the raw
 *  primary-port info that URL-building helpers (e.g. `buildMeldUrl`) want. */
export interface DaemonEndpoint {
  /** Origin for `/api/...` requests from this machine, no trailing slash. */
  baseUrl: string;
  /** What to present as the bearer, or null to present none: over the
   *  daemon's socket, a request without a token acts as this Unix account. */
  token: string | null;
  /** The daemon's primary (TLS, when enabled) port — not necessarily the one
   *  in `baseUrl`. */
  port: string;
  version?: string;
  /** The daemon's Unix socket (`daemon.sock`), when it has one: requests go
   *  there first, and over TCP to `baseUrl` only if it cannot be reached. */
  socketPath?: string;
}

export interface DaemonAddress {
  port: string;
  tls: boolean;
  /** Port of the daemon's plain-HTTP fallback listener; present iff `tls`. */
  httpPort?: string;
  /** Hostname the TLS cert is valid for, when one is available. */
  tailscaleHost?: string;
}

/** Pick the origin a *local* client should use to reach the daemon.
 *
 *  Without TLS this is just loopback on the primary port. With TLS it can't
 *  be: the cert is issued for the Tailscale hostname and is never valid for
 *  `127.0.0.1`, so loopback has to go through the daemon's plain-HTTP
 *  fallback listener (private IPs only, hence safe). The Tailscale hostname
 *  is the last resort for the narrow window where TLS is up but the fallback
 *  port hasn't been recorded yet. */
export function buildDaemonBaseUrl(addr: DaemonAddress): string {
  if (!addr.tls) return `http://127.0.0.1:${addr.port}`;
  if (addr.httpPort) return `http://127.0.0.1:${addr.httpPort}`;
  if (addr.tailscaleHost) return `https://${addr.tailscaleHost}:${addr.port}`;
  throw new Error(
    "Daemon is running with TLS but has no HTTP fallback port recorded, and " +
      "no Tailscale hostname was found to validate its certificate against.",
  );
}

/** Read the daemon's address out of the meta table. `opts.tailscaleHost`
 *  injects the hostname instead of shelling out to `tailscale status` — used
 *  by tests to keep this deterministic; when the key is present (even as
 *  `undefined`) the live lookup is skipped. */
export function readDaemonAddress(
  db: ReturnType<typeof openDatabase>,
  port: string,
  opts: { tailscaleHost?: string } = {},
): DaemonAddress {
  const metaValue = (key: string): string | undefined =>
    (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined)?.value;

  const tls = metaValue("daemon_tls") === "true";
  const tailscaleHost =
    "tailscaleHost" in opts ? opts.tailscaleHost : getTailscaleHost();
  return {
    port,
    tls,
    httpPort: tls ? metaValue("daemon_http_port") : undefined,
    tailscaleHost: tls ? tailscaleHost : undefined,
  };
}

/** What this process presents to the daemon. Inside an agent's session the
 *  CLI and MCP bridge act as that agent, with the token its launch minted
 *  for it, so what they do is attributed to, and revocable with, that
 *  narrative. Anywhere else it is nothing (null): this machine holds no
 *  token, and a request with none acts as this Unix account when it arrives
 *  over the daemon's socket, the one place only this account can reach. No
 *  file is read: `.daemon_token`, where older branes kept a local token, is
 *  retired (`bootstrapTokens`, src/db/tokens.ts). */
export function resolveCredential(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.BRANE_NARRATIVE_SECRET || null;
}

/** Resolve a reachable daemon, starting one if none is running.
 *
 *  `ensureDaemonRunning` returns as soon as the primary port is recorded, but
 *  the HTTP fallback port lands a beat later — so on a TLS daemon we give that
 *  row a moment to appear before falling back to the Tailscale hostname. */
export async function resolveDaemonEndpoint(): Promise<DaemonEndpoint> {
  const address = await ensureDaemonRunning();

  for (let attempt = 0; ; attempt++) {
    const db = openDatabase();
    let addr: DaemonAddress;
    let token: string | null;
    let socketPath: string | undefined;
    try {
      addr = readDaemonAddress(db, address.port);
      token = resolveCredential();
      socketPath = readDaemonSocket(db);
    } finally {
      db.close();
    }
    if (addr.tls && !addr.httpPort && attempt < 10) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    return {
      baseUrl: buildDaemonBaseUrl(addr),
      token,
      port: address.port,
      version: address.version,
      ...(socketPath ? { socketPath } : {}),
    };
  }
}

/** The socket a running daemon advertised, if its file is there. */
export function readDaemonSocket(db: ReturnType<typeof openDatabase>): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'daemon_socket'").get() as
    | { value: string }
    | undefined;
  return row && existsSync(row.value) ? row.value : undefined;
}

/** The part of a fetch `Response` the callers here read. */
interface DaemonResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  body: AsyncIterable<Uint8Array> | null;
}

/** Send one request to the daemon: over its Unix socket when it has one,
 *  else (or when the socket cannot be connected to, so nothing was sent)
 *  over TCP to `baseUrl`. */
export async function sendToDaemon(
  endpoint: DaemonEndpoint,
  path: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<DaemonResponse> {
  if (endpoint.socketPath) {
    const viaSocket = await new Promise<DaemonResponse | null>((resolve, reject) => {
      const req = httpRequest(
        { socketPath: endpoint.socketPath, path, method: init.method, headers: init.headers },
        (res) => {
          const status = res.statusCode ?? 0;
          let consumed = false;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            body: res,
            async text() {
              if (consumed) return "";
              consumed = true;
              let out = "";
              res.setEncoding("utf8");
              for await (const chunk of res) out += chunk;
              return out;
            },
          });
        },
      );
      // Until the socket connects, nothing of this request has been sent, so
      // any failure (gone, refused, no permission, not a socket) is safe to
      // retry over TCP. After it, the daemon may have acted: report it.
      let connected = false;
      req.on("socket", (sock) => {
        if (!sock.connecting) connected = true;
        else sock.once("connect", () => { connected = true; });
      });
      req.on("error", (err) => {
        if (!connected) resolve(null);
        else reject(err);
      });
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
    if (viaSocket) return viaSocket;
  }
  // Without a token, TCP would only answer 401: say what actually failed.
  if (endpoint.token === null) {
    throw new Error(
      endpoint.socketPath
        ? `could not connect to the daemon's socket (${endpoint.socketPath}); \`brane daemon restart\` puts it back`
        : "the daemon is running without its socket (daemon.sock), which is the only way this shell reaches it; " +
          "`brane daemon logs` says why it could not listen there, and `brane doctor` checks it",
    );
  }
  const res = await fetch(`${endpoint.baseUrl}${path}`, init);
  return {
    ok: res.ok,
    status: res.status,
    text: () => res.text(),
    body: res.body as AsyncIterable<Uint8Array> | null,
  };
}

/** What a 401 means for a request that presented no token over the socket. */
const TOKENLESS_REFUSED =
  "the daemon would not let a request without a token act as this account; " +
  "it does so only while ~/.brane is owned by you and closed to group and other (chmod 700 ~/.brane), " +
  "and `brane daemon logs` says why it refused";

function authorization(endpoint: DaemonEndpoint): Record<string, string> {
  return endpoint.token === null ? {} : { Authorization: `Bearer ${endpoint.token}` };
}

/** Warn when the daemon we're delegating to was built from different sources
 *  than this CLI. It matters more for delegated work than for read-only
 *  status: a request field this CLI knows about (say `extra_args`) is simply
 *  ignored by an older daemon, with no error to notice. */
export function warnIfVersionMismatch(endpoint: DaemonEndpoint): void {
  const myVersion = getPackageVersion();
  if (endpoint.version && endpoint.version !== myVersion) {
    process.stderr.write(
      `Warning: daemon is v${endpoint.version}, this CLI is v${myVersion}. ` +
        `Run \`brane daemon restart\` to pick up this build.\n`,
    );
  }
}

/** Call a daemon JSON API endpoint. Throws with the daemon's own `error`
 *  string when it reports one, so CLI output matches what the web app shows. */
export async function daemonRequest<T>(
  endpoint: DaemonEndpoint,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await sendToDaemon(endpoint, path, {
    method: init.method ?? "GET",
    headers: {
      ...authorization(endpoint),
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (!res.ok) {
    const message =
      data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : `${init.method ?? "GET"} ${path} failed (${res.status})`;
    // Inside an agent's session the CLI presented that agent's token; a 401
    // then almost always means it was revoked or superseded by a revive.
    if (res.status === 401 && process.env.BRANE_NARRATIVE_SECRET && endpoint.token === process.env.BRANE_NARRATIVE_SECRET) {
      throw new Error(
        `${message}: this session's agent token (BRANE_NARRATIVE_SECRET) was refused, ` +
          "probably revoked; the operator can revive the session",
      );
    }
    if (res.status === 401 && endpoint.token === null) throw new Error(`${message}: ${TOKENLESS_REFUSED}`);
    throw new Error(message);
  }

  return data as T;
}

/** Call a daemon endpoint that answers with newline-delimited JSON, handing
 *  each line to `onLine` as it arrives — for work that reports progress
 *  (`POST /api/absorb`). A non-2xx status is an ordinary JSON error and is
 *  thrown the way `daemonRequest` throws it; the stream itself is only ever
 *  opened once the daemon has accepted the request. Resolves when the daemon
 *  ends the response. A partial trailing line (the connection dropped
 *  mid-record) is discarded rather than parsed. */
export async function daemonStream<T>(
  endpoint: DaemonEndpoint,
  path: string,
  init: { method?: string; body?: unknown },
  onLine: (line: T) => void,
): Promise<void> {
  const res = await sendToDaemon(endpoint, path, {
    method: init.method ?? "POST",
    headers: {
      ...authorization(endpoint),
      Accept: "application/x-ndjson",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    let message = `${init.method ?? "POST"} ${path} failed (${res.status})`;
    try {
      const data = JSON.parse(text) as { error?: unknown };
      if (typeof data.error === "string") message = data.error;
    } catch {
      // not JSON; keep the status line
    }
    if (res.status === 401 && endpoint.token === null) message = `${message}: ${TOKENLESS_REFUSED}`;
    throw new Error(message);
  }
  if (!res.body) return;

  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of res.body) {
    buffered += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (line) onLine(JSON.parse(line) as T);
    }
  }
  // The daemon terminates every record with a newline, so a non-empty
  // remainder is a record the connection cut short.
  const tail = (buffered + decoder.decode()).trim();
  if (tail) {
    try {
      onLine(JSON.parse(tail) as T);
    } catch {
      // partial trailing record; discard
    }
  }
}
