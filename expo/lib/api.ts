/**
 * Brane daemon API client.
 *
 * Connection params come from the URL hash fragment:
 *   https://domain/#host=localhost:3000&token=abc
 */

import {
  DEFAULT_TIMEOUT_MS,
  JSON_HEADERS,
  MAX_ATTEMPTS,
  NO_HEADERS,
  isRetryableError,
  isRetryableMethod,
  retryDelayMs,
  withToken,
} from "@shared/api-request";
import { withoutConnectionHash, withoutConnectionParams } from "@shared/view-url";
import { formatSeqModeParam, formatSeqParam, type SeqSelectionMode } from "@shared/export-selection";
import { lastTerminalSize } from "./terminal";

export interface ConnectionParams {
  host: string; // "hostname:port" or empty for same-origin
  token: string;
}

export interface NarrativeInfo {
  id: string;
  brane_id: string;
  status: string;
  agent_type: string | null;
  role: string | null;
  fold_path: string | null;
  created_at: number;
  /** Time of the narrative's most recent event (ms). Falls back to created_at
   *  when the daemon predates this field. */
  last_activity?: number | null;
  mcp_connected?: boolean;
  /** Parked in a blocking listen or a waiting narrate — the card reads OPEN.
   *  Absent from a daemon that predates it, which reads as not awaiting. */
  awaiting?: boolean;
  summary?: string | null;
  archived?: boolean;
  /** Cumulative session cost sampled from the agent's usage log. `cost_unit`
   *  is agent-defined ("USD", "AIC", …); both are absent when the agent can't
   *  report usage. `cost_tokens` is an optional JSON token breakdown. */
  cost_amount?: number | null;
  cost_unit?: string | null;
  cost_tokens?: string | null;
}

// Cost wording lives in `src/shared/narrative-format.ts` so the server-side HTML
// export renders it identically. Re-exported here because this is where the app
// has always imported it from.
export { formatCost, formatCostTotals } from "@shared/narrative-format";

export interface BraneInfo {
  brane_id: string;
  narrative_count: number;
  active_count: number;
  absorbed_count: number;
  last_activity: number;
  is_home: boolean;
  /** Running metered cost, one entry per unit (never summed across units),
   *  over every narrative in the brane including archived ones. A list-price
   *  estimate of main-model turns — not a bill. `metered` is how many
   *  narratives the figure covers. Absent from daemons older than this app. */
  cost?: Array<{ unit: string; amount: number; metered: number }>;
}

export interface NarrativeEvent {
  seq: number;
  time: number;
  type: string;
  content?: string;
  content_type?: string;
  source?: string;
  re?: Array<number | string>;
  payloads?: string[];
}

/** A tool call captured alongside the narrative (hooks / session logs /
 *  absorb). Not an event: anchored to the seq space via after_seq but never
 *  part of it. `rev` is the per-narrative sync watermark — rows mutate in
 *  place (pending → completed) with a rev bump, so catch-up is by rev while
 *  display order is (after_seq, started_at). */
export interface ToolUse {
  narrative_id: string;
  dedup_key: string;
  after_seq: number;
  started_at: number;
  rev: number;
  name: string;
  input: string | null;
  status: "pending" | "allowed" | "denied" | "completed" | "failed" | "unknown";
  output: string | null;
  duration_ms: number | null;
  error: string | null;
  decided_by: string | null;
  decided_at: number | null;
  decision_note: string | null;
  source: "hook" | "session_log" | "absorb";
  agent_type: string | null;
  parent_id: string | null;
  input_truncated?: boolean;
  output_truncated?: boolean;
}

export interface DaemonStatus {
  brane_id: string;
  hostname: string;
  username: string;
  pid: number;
  port: number;
  uptime_ms: number;
  /** The shared app's host, as the daemon's `app_domain` config names it:
   *  where a daemon's own bundle hops out to (Isolate). Absent from a daemon
   *  that predates it. */
  app_domain?: string;
}

const STORAGE_KEY = "brane_conn";

/** The connection a meld URL carries, read from the address bar: the fragment
 *  first (`#host=…&token=…`, what every link built since the fragment change
 *  carries), then the query string (legacy QR codes and bookmarks). `null`
 *  when the URL carries no token. */
function connFromLocation(): ConnectionParams | null {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const query = new URLSearchParams(window.location.search);
  const token = hash.get("token") ?? query.get("token");
  if (!token) return null;
  const host = hash.get("host") ?? query.get("host") ?? window.location.host;
  return { host, token };
}

/** Parse connection params from the URL (fragment, then legacy query string)
 *  or sessionStorage. A URL hit is cached in sessionStorage so the meld flow
 *  survives the address bar being cleaned. */
export function parseConnectionParams(): ConnectionParams | null {
  if (typeof window === "undefined") return null;

  const fromUrl = connFromLocation();
  if (fromUrl) {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(fromUrl)); } catch {}
    return fromUrl;
  }

  // Fall back to previously persisted params (survives in-app navigation)
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored) as ConnectionParams;
  } catch {}

  return null;
}

/** Take the connection out of the address bar the moment the bundle loads,
 *  and into sessionStorage, as early as app code can run.
 *
 *  On web the router parses the initial URL's hash into a route param named
 *  `#` and re-appends it every time it writes the URL, so a fragment that is
 *  still there when the navigation container mounts comes back on the next
 *  `router.setParams` (a tab change, a pin, an opened file) — straight into
 *  the address bar and the back stack, after the app thought it had cleaned
 *  it. Query params get the same treatment. Consuming here, at module
 *  evaluation, runs before any of that: the credentials go into the
 *  sessionStorage slot `parseConnectionParams` already falls back to, and
 *  `history.replaceState` drops them from the URL while keeping the view
 *  (tab, pins, path, line, scroll target) intact. In practice the router has
 *  already captured the initial URL by the time app modules evaluate and
 *  restores the hash on its first write, so the fragment stays visible until
 *  `clearMeldUrl` removes it at confirm — after which it did not return
 *  across in-app navigation and tab changes (claude-7irbudpw:65).
 *  `clearStoredConnection` still ends the flow once the meld is resolved.
 */
function consumeConnectionFromLocation(): void {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  const conn = connFromLocation();
  if (!conn) return;
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(conn)); } catch { return; }
  const clean =
    window.location.pathname +
    withoutConnectionParams(window.location.search) +
    withoutConnectionHash(window.location.hash);
  window.history.replaceState(window.history.state, "", clean);
}
consumeConnectionFromLocation();

/**
 * Clear the sessionStorage connection cache. Call this once a meld URL has
 * been resolved (registered, silently reconnected, cancelled, or failed)
 * so a reload doesn't re-replay the same meld attempt.
 */
export function clearStoredConnection(): void {
  if (typeof window === "undefined") return;
  try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
}

/** The request layer. Its rules — query-param auth, no headers on bodiless
 *  requests, a 60s ceiling, retry only what cannot have had an effect — live
 *  in `@shared/api-request` with the reasoning and the tests. They exist
 *  because a cross-origin GET carrying an `Authorization` header must wait for
 *  a CORS preflight before it may be sent, which is invisible on a LAN and
 *  fatal at 741ms RTT. */
function apiUrl(conn: ConnectionParams, path: string): string {
  const protocol = window.location.protocol === "https:" ? "https" : "http";
  return `${protocol}://${conn.host}${withToken(path, conn.token)}`;
}

/** Fetch with a timeout, retrying transport failures with backoff.
 *
 *  A marginal link does not fail once, it fails intermittently — and without a
 *  retry a single dropped fetch is terminal for whatever view was waiting on
 *  it. The operator's own retry is worse than this one: a reload pays a fresh
 *  TCP and TLS handshake and restarts slow start, so a link that is merely bad
 *  produces failure that looks total. */
function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const attempts = isRetryableMethod(init.method ?? "GET") ? MAX_ATTEMPTS : 1;

  // The caller's own signal cancels the request, and its body after it: a
  // stream read after this returns is still tied to `controller`.
  const outer = init.signal;
  const attempt = async (n: number): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (outer) {
      if (outer.aborted) controller.abort();
      else outer.addEventListener("abort", () => controller.abort(), { once: true });
    }
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (res.status === 401 && unauthorizedListener) {
        const refused = connFromUrl(url);
        if (refused) unauthorizedListener(refused);
      }
      return res;
    } catch (err) {
      // A request its caller cancelled is not a transport failure.
      if (n + 1 < attempts && isRetryableError(err) && !outer?.aborted) {
        await new Promise((r) => setTimeout(r, retryDelayMs(n)));
        return attempt(n + 1);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  return attempt(0);
}

/** Told once per 401, with the connection that was refused. The root layout
 *  uses it to notice that the active daemon's token has been rotated out from
 *  under this device — a control socket that was live at the moment gets a
 *  4401 close instead, but a device that loads *later* only ever sees 401s,
 *  and without this the list would just sit on "Narratives 401". */
let unauthorizedListener: ((conn: ConnectionParams) => void) | null = null;
export function setUnauthorizedListener(cb: ((conn: ConnectionParams) => void) | null): void {
  unauthorizedListener = cb;
}

function connFromUrl(url: string): ConnectionParams | null {
  try {
    const u = new URL(url);
    const token = u.searchParams.get("token");
    return token ? { host: u.host, token } : null;
  } catch {
    return null;
  }
}

export async function fetchStatus(conn: ConnectionParams) {
  const res = await fetchWithTimeout(apiUrl(conn, "/api/status"), {
    headers: NO_HEADERS,
  });
  if (!res.ok) throw new Error(`Status ${res.status}`);
  return res.json();
}

export async function fetchNarratives(
  conn: ConnectionParams,
  opts?: { archived?: boolean; braneIds?: string[] },
): Promise<NarrativeInfo[]> {
  const params = new URLSearchParams();
  if (opts?.archived) params.set("archived", "1");
  if (opts?.braneIds && opts.braneIds.length > 0) {
    params.set("brane_ids", opts.braneIds.join(","));
  }
  const qs = params.toString();
  const url = apiUrl(conn, qs ? `/api/narratives?${qs}` : "/api/narratives");
  const res = await fetchWithTimeout(url, {
    headers: NO_HEADERS,
  });
  if (!res.ok) throw new Error(`Narratives ${res.status}`);
  const data = await res.json();
  return data.narratives;
}

/** One narrative, for the chat header.
 *
 *  The header used to read its title, summary and status out of the full list,
 *  which meant waiting on every narrative the daemon has — 1,864 of them and
 *  934KB on one measured phone, 15 seconds before a title appeared
 *  (claude-n1izig04:76). A header needs one row. */
export async function fetchNarrative(
  conn: ConnectionParams,
  nid: string,
): Promise<NarrativeInfo> {
  const res = await fetchWithTimeout(apiUrl(conn, `/api/narratives/${nid}`), {
    headers: NO_HEADERS,
  });
  if (!res.ok) throw new Error(`Narrative ${res.status}`);
  const data = await res.json();
  return data.narrative;
}

export async function fetchEvents(
  conn: ConnectionParams,
  nid: string,
  after: number = 0,
  limit?: number,
): Promise<{ nid: string; seq: number; events: NarrativeEvent[] }> {
  const params = new URLSearchParams({
    after: String(after),
  });
  if (limit !== undefined) params.set("limit", String(limit));
  const res = await fetchWithTimeout(
    apiUrl(conn, `/api/narratives/${nid}/events?${params}`),
    { headers: NO_HEADERS },
  );
  if (!res.ok) throw new Error(`Events ${res.status}`);
  return res.json();
}

/** Resume point for the next page of tool rows — the server's compound sort
 *  key, echoed back verbatim. Opaque to callers. */
export interface ToolUseCursor {
  after_seq: number;
  started_at: number;
  dedup_key: string;
}

export interface ToolUsesPage {
  nid: string;
  tool_uses: ToolUse[];
  truncated: boolean;
  /** Window query only — resume point for the next page. */
  next_cursor?: ToolUseCursor | null;
  /** Catch-up query only — rev to resume from. */
  next_since_rev?: number | null;
}

/** One tool row, whole.
 *
 *  Rows arrive in lists excerpted to 1KB, which is everything a collapsed row
 *  draws. This is what pays for the rest, once — when the operator opens a row
 *  and there is a `input_truncated`/`output_truncated` flag saying the daemon
 *  has more (claude-n1izig04:73). */
export async function fetchToolUse(
  conn: ConnectionParams,
  nid: string,
  dedupKey: string,
): Promise<ToolUse> {
  const res = await fetchWithTimeout(
    apiUrl(conn, `/api/narratives/${nid}/tool_uses/${encodeURIComponent(dedupKey)}`),
    { headers: NO_HEADERS },
  );
  if (!res.ok) throw new Error(`Tool use ${res.status}`);
  const data = await res.json();
  return data.tool_use;
}

/** One page of the *display window*: rows anchored in [afterSeqGte,
 *  afterSeqLt), in display order. Half-open, so paging back asks only for the
 *  newly exposed band rather than the whole suffix again. */
export async function fetchToolUseWindow(
  conn: ConnectionParams,
  nid: string,
  opts: { afterSeqGte?: number; afterSeqLt?: number; limit?: number; after?: ToolUseCursor } = {},
): Promise<ToolUsesPage> {
  const params = new URLSearchParams();
  if (opts.afterSeqGte !== undefined) params.set("after_seq_gte", String(opts.afterSeqGte));
  if (opts.afterSeqLt !== undefined) params.set("after_seq_lt", String(opts.afterSeqLt));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.after) {
    params.set("after_cursor_seq", String(opts.after.after_seq));
    params.set("after_cursor_started_at", String(opts.after.started_at));
    params.set("after_cursor_dedup_key", opts.after.dedup_key);
  }
  return getToolUses(conn, nid, params);
}

/** One page of the *catch-up* query: rows written or mutated since `sinceRev`,
 *  in rev order — so a truncated page's last rev is still a safe watermark. */
export async function fetchToolUsesSince(
  conn: ConnectionParams,
  nid: string,
  opts: { sinceRev: number; limit?: number },
): Promise<ToolUsesPage> {
  const params = new URLSearchParams();
  params.set("since_rev", String(opts.sinceRev));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  return getToolUses(conn, nid, params);
}

async function getToolUses(
  conn: ConnectionParams,
  nid: string,
  params: URLSearchParams,
): Promise<ToolUsesPage> {
  const res = await fetchWithTimeout(
    apiUrl(conn, `/api/narratives/${nid}/tool_uses?${params}`),
    { headers: NO_HEADERS },
  );
  if (!res.ok) throw new Error(`ToolUses ${res.status}`);
  return res.json();
}

/** Runaway guard, not a policy: hitting it means the server kept claiming more
 *  pages, which is worth saying out loud rather than stopping quietly. */
const MAX_TOOL_USE_PAGES = 100;

/** Drain every page of a window query, handing each to `onPage` as it lands so
 *  rows render progressively instead of after the last byte. Rejects like a
 *  single fetch, so an existing catch still covers a mid-drain failure — pages
 *  already applied stay applied, since rows are idempotent by dedup_key. */
export async function fetchAllToolUseWindow(
  conn: ConnectionParams,
  nid: string,
  opts: { afterSeqGte?: number; afterSeqLt?: number },
  onPage: (rows: ToolUse[]) => void,
): Promise<void> {
  let after: ToolUseCursor | undefined;
  for (let page = 0; page < MAX_TOOL_USE_PAGES; page++) {
    const data = await fetchToolUseWindow(conn, nid, { ...opts, after });
    onPage(data.tool_uses);
    if (!data.truncated || !data.next_cursor) return;
    after = data.next_cursor;
  }
  console.warn(`[tool_uses] stopped paging window for ${nid} after ${MAX_TOOL_USE_PAGES} pages`);
}

/** Drain the catch-up query from `sinceRev` forward. Each page advances the
 *  cursor to its own last rev, which is exactly what the caller's watermark
 *  becomes — truncation costs another round trip, never a row. */
export async function fetchAllToolUsesSince(
  conn: ConnectionParams,
  nid: string,
  sinceRev: number,
  onPage: (rows: ToolUse[]) => void,
): Promise<void> {
  let cursor = sinceRev;
  for (let page = 0; page < MAX_TOOL_USE_PAGES; page++) {
    const data = await fetchToolUsesSince(conn, nid, { sinceRev: cursor });
    onPage(data.tool_uses);
    if (!data.truncated || data.next_since_rev == null) return;
    cursor = data.next_since_rev;
  }
  console.warn(`[tool_uses] stopped catching up ${nid} after ${MAX_TOOL_USE_PAGES} pages`);
}

export async function fetchEventsBefore(
  conn: ConnectionParams,
  nid: string,
  before: number,
  limit: number = 50,
): Promise<{ nid: string; seq: number; min_seq: number; events: NarrativeEvent[] }> {
  const params = new URLSearchParams({
    before: String(before),
    limit: String(limit),
  });
  const res = await fetchWithTimeout(
    apiUrl(conn, `/api/narratives/${nid}/events?${params}`),
    { headers: NO_HEADERS },
  );
  if (!res.ok) throw new Error(`Events ${res.status}`);
  return res.json();
}

export async function sendSignal(
  conn: ConnectionParams,
  nid: string,
  content: string,
  source: string = "web",
  payloads?: Array<{ filename: string; data: string }>,
  re?: Array<number | string>,
): Promise<{ event: NarrativeEvent }> {
  const body: Record<string, unknown> = { content, source };
  if (payloads && payloads.length > 0) body.payloads = payloads;
  if (re && re.length > 0) body.re = re;
  const res = await fetchWithTimeout(apiUrl(conn, `/api/narratives/${nid}/signal`), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Signal ${res.status}`);
  return res.json();
}

export async function spawnAgent(
  conn: ConnectionParams,
  agent: string,
  foldPath: string,
  role: string = "worker",
  model?: string,
  extraArgs?: string[],
  re?: string,
): Promise<NarrativeInfo> {
  const body: Record<string, unknown> = { agent, fold_path: foldPath, role };
  if (model) body.model = model;
  if (extraArgs && extraArgs.length > 0) body.extra_args = extraArgs;
  // Predecessor narrative to twin from (server pins it to nid:seq + forces role "twin").
  if (re) body.re = re;
  const size = lastTerminalSize();
  if (size) body.terminal_size = size;
  const res = await fetchWithTimeout(apiUrl(conn, "/api/spawn"), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Spawn ${res.status}`);
  }
  const data = await res.json();
  return data.narrative;
}

/** Run a non-agent command (`zsh`, `lazygit`, …) in a tracked tmux session —
 *  the app is `POST /api/run`'s only client (the `brane run` CLI command is
 *  retired). No MCP, no role: the daemon stamps `utility`. */
export async function runUtility(
  conn: ConnectionParams,
  command: string[],
  foldPath: string,
): Promise<NarrativeInfo> {
  const res = await fetchWithTimeout(apiUrl(conn, "/api/run"), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ command, fold_path: foldPath, terminal_size: lastTerminalSize() ?? undefined }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Run ${res.status}`);
  }
  const data = await res.json();
  return data.narrative;
}

export interface RunHistoryEntry {
  /** Command basename, e.g. `zsh` or `lazygit`. */
  command: string;
  last_used: number;
  use_count: number;
}

/** Commands utility sessions have run before, most-recent first — the Utility list. */
export async function fetchRunHistory(
  conn: ConnectionParams,
): Promise<RunHistoryEntry[]> {
  const res = await fetchWithTimeout(apiUrl(conn, "/api/run-history"), {
    headers: NO_HEADERS,
  });
  if (!res.ok) throw new Error(`Run history ${res.status}`);
  const data = await res.json();
  return data.history;
}

export interface SpawnHistoryEntry {
  args: string[];
  last_used: number;
  use_count: number;
}

export async function fetchSpawnHistory(
  conn: ConnectionParams,
): Promise<SpawnHistoryEntry[]> {
  const res = await fetchWithTimeout(apiUrl(conn, "/api/spawn-history"), {
    headers: NO_HEADERS,
  });
  if (!res.ok) throw new Error(`Spawn history ${res.status}`);
  const data = await res.json();
  return data.history;
}

export interface FoldInfo {
  path: string;
  created_at: number;
  last_spawned: number | null;
  brane_id: string | null;
  archived?: number | null;
}

export async function fetchFolds(
  conn: ConnectionParams,
  includeArchived: boolean = false,
): Promise<FoldInfo[]> {
  const res = await fetchWithTimeout(
    apiUrl(conn, includeArchived ? "/api/folds?archived=1" : "/api/folds"),
    { headers: NO_HEADERS },
  );
  if (!res.ok) throw new Error(`Folds ${res.status}`);
  const data = await res.json();
  return data.folds;
}

// Register a directory as a fold (spawn point). Accepts an absolute or
// ~/portable path. Idempotent server-side: re-adding an archived fold un-hides
// it. Throws with the server's message (e.g. "Not a directory: …") on failure.
export async function addFold(
  conn: ConnectionParams,
  path: string,
): Promise<FoldInfo> {
  const res = await fetchWithTimeout(apiUrl(conn, "/api/folds"), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Add fold ${res.status}`);
  }
  const data = await res.json();
  return data.fold;
}

// Soft-hide (archive) or unhide a fold. Never deletes it.
export async function archiveFold(
  conn: ConnectionParams,
  path: string,
  archived: boolean = true,
): Promise<{ path: string; archived: boolean }> {
  const res = await fetchWithTimeout(apiUrl(conn, "/api/folds/archive"), {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ path, archived }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Archive fold ${res.status}`);
  }
  return res.json();
}

export async function fetchBranes(
  conn: ConnectionParams,
): Promise<BraneInfo[]> {
  const res = await fetchWithTimeout(apiUrl(conn, "/api/branes"), {
    headers: NO_HEADERS,
  });
  if (!res.ok) throw new Error(`Branes ${res.status}`);
  const data = await res.json();
  return data.branes;
}

export async function reviveNarrative(
  conn: ConnectionParams,
  nid: string,
  agent?: string,
): Promise<{ status: string; nid: string }> {
  const body: Record<string, unknown> = {};
  if (agent) body.agent = agent;
  const res = await fetchWithTimeout(apiUrl(conn, `/api/revive/${nid}`), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Revive ${res.status}`);
  }
  return res.json();
}

export async function archiveNarrative(
  conn: ConnectionParams,
  nid: string,
  archived: boolean = true,
): Promise<{ id: string; archived: boolean }> {
  const res = await fetchWithTimeout(apiUrl(conn, `/api/narratives/${nid}/archive`), {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ archived }),
  });
  if (!res.ok) throw new Error(`Archive ${res.status}`);
  return res.json();
}

export interface SearchHit {
  narrative_id: string;
  seq: number;
  content: string;
  score: number;
}

export async function searchNarratives(
  conn: ConnectionParams,
  query: string,
  limit: number = 20,
  braneIds?: string[],
): Promise<{ query: string; results: SearchHit[]; narratives: NarrativeInfo[] }> {
  const body: Record<string, unknown> = { query, limit };
  if (braneIds && braneIds.length > 0) body.brane_ids = braneIds;
  const res = await fetchWithTimeout(apiUrl(conn, "/api/search"), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Search ${res.status}`);
  }
  return res.json();
}

// ── Wiki search & read ──────────────────────────────────────────────────

export interface WikiSearchHit {
  anchor: string;
  /** `slug` or `slug#anchor` — the wiki analogue of `nid:seq`. */
  citation: string;
  content: string;
  score: number;
}

/** Search hits grouped by article (page), the way narrative hits group by
 *  narrative. */
export interface WikiSearchArticle {
  source: string;
  slug: string;
  fold_path?: string;
  score: number;
  hits: WikiSearchHit[];
}

export async function searchWiki(
  conn: ConnectionParams,
  query: string,
  limit: number = 10,
  braneIds?: string[],
): Promise<{ query: string; results: WikiSearchArticle[] }> {
  const body: Record<string, unknown> = { query, limit };
  // Omit brane_ids → all folds + the package wiki (global discovery from the
  // fold-agnostic main page).
  if (braneIds && braneIds.length > 0) body.brane_ids = braneIds;
  const res = await fetchWithTimeout(apiUrl(conn, "/api/wiki/search"), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Wiki search ${res.status}`);
  }
  return res.json();
}

export interface WikiNeighbor {
  anchor: string;
  heading: string | null;
  level: number;
  preview: string;
}

/** One section of a wiki page plus a navigational window of the headings
 *  around it. "Read on" = fetch `next[0].anchor`. */
export interface WikiSectionRead {
  source: string;
  slug: string;
  fold_path?: string;
  frontmatter: Record<string, string>;
  toc: Array<{ anchor: string; heading: string; level: number }>;
  citation: string;
  current: { anchor: string; heading: string | null; level: number; content: string };
  prev: WikiNeighbor[];
  next: WikiNeighbor[];
  position: { index: number; total: number };
}

export async function readWikiSection(
  conn: ConnectionParams,
  opts: { source?: string; slug: string; anchor?: string; window?: number; braneIds?: string[] },
): Promise<WikiSectionRead> {
  const params = new URLSearchParams({ slug: opts.slug });
  if (opts.source) params.set("source", opts.source);
  if (opts.anchor) params.set("anchor", opts.anchor);
  if (opts.window != null) params.set("window", String(opts.window));
  if (opts.braneIds && opts.braneIds.length > 0) params.set("brane_ids", opts.braneIds.join(","));
  const res = await fetchWithTimeout(apiUrl(conn, `/api/wiki/read?${params.toString()}`), {
    headers: NO_HEADERS,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Wiki read ${res.status}`);
  }
  return res.json();
}

// ── Protocols ───────────────────────────────────────────────────────────

export interface ProtocolInfo {
  name: string;
  description: string;
  version: string;
}

/** The protocol library. Chat linkifies a `/command` only when its name is in
 *  here, so slashes in prose don't turn into dead links. Protocol pages are
 *  read back through `readWikiSection` with `source: "protocols"`. */
export async function listProtocols(conn: ConnectionParams): Promise<ProtocolInfo[]> {
  const res = await fetchWithTimeout(apiUrl(conn, "/api/protocols"), {
    headers: NO_HEADERS,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Protocols ${res.status}`);
  }
  const data = await res.json();
  return data.protocols ?? [];
}

/** Build a URL to a wiki asset (e.g. a relative image in a wiki page), served
 *  from within the page's wiki source dir. */
export function wikiAssetUrl(conn: ConnectionParams, source: string, path: string): string {
  // `apiUrl` supplies the token; adding it here too would append a second one.
  const params = new URLSearchParams({ source, path });
  return apiUrl(conn, `/api/wiki/asset?${params.toString()}`);
}

/** Build a URL to serve a stored payload file */
export function payloadUrl(conn: ConnectionParams, path: string): string {
  return apiUrl(conn, `/api/payloads/${path}`);
}

export interface FilesEntry {
  name: string;
  is_dir: boolean;
  size: number | null;
  mtime: number;
  /** Opens as a folder: a zip- or tar-family archive. */
  archive?: boolean;
  /** A link inside an archive, and where it points. */
  link?: string;
}

/** Where a path inside an archive sits; `root` is the archive's own path. */
export interface FilesArchiveInfo {
  root: string;
  format: string;
  /** Members hidden because their names climbed out of the archive. */
  skipped?: number;
  /** The listing stopped at a limit, or the archive was cut short. */
  partial?: boolean;
}

/** One page of a binary file, for the hex view. */
export interface FilesHexPage {
  offset: number;
  /** Base64. */
  data: string;
  eof: boolean;
}

export interface HighlightToken {
  c: string;      // content
  f?: string;     // foreground color
  s?: number;     // fontStyle bitmask: 1=italic, 2=bold, 4=underline
}

export interface FileHighlight {
  lang: string;
  theme: string;
  bg: string;
  fg: string;
  tokens: HighlightToken[][];
}

export type FilesResponse =
  | { type: "directory"; path: string; entries: FilesEntry[]; archive?: FilesArchiveInfo }
  | {
      type: "file";
      path: string;
      /** Null when only decompressing would tell (a `.gz` body). */
      size: number | null;
      mtime: number;
      content: string;
      truncated?: boolean;
      binary?: boolean;
      highlight?: FileHighlight | null;
      hex?: FilesHexPage;
      link?: string;
      notice?: string;
      archive?: FilesArchiveInfo;
    };

/** `offset` asks for the hex page of a binary file starting there. */
export async function fetchFiles(
  conn: ConnectionParams,
  nid: string,
  path: string,
  offset?: number,
): Promise<FilesResponse> {
  const params = new URLSearchParams({ nid, path });
  if (offset !== undefined) params.set("offset", String(offset));
  const res = await fetchWithTimeout(apiUrl(conn, `/api/files?${params}`), {
    headers: NO_HEADERS,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Files ${res.status}`);
  }
  return res.json();
}

/** One line of `/api/files/find`'s NDJSON answer (src/files/find.ts). */
export type FileFindEvent =
  | { type: "hits"; hits: Array<[number, number]> }
  | { type: "progress"; scanned: number }
  | { type: "done"; stop: "eof" | "pages" | "hits" | "time" | "reach" | "cancelled"; scanned: number; next: number | null }
  | { type: "error"; error: string };

/** Search a file's bytes from `from`, calling `onEvent` for each line as it
 *  arrives. Resolves when the answer ends; aborting `signal` ends it early
 *  and the daemon stops reading the file. */
export async function streamFileFind(
  conn: ConnectionParams,
  nid: string,
  path: string,
  query: string,
  from: number,
  onEvent: (event: FileFindEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const params = new URLSearchParams({ nid, path, q: query });
  if (from > 0) params.set("from", String(from));
  const res = await fetchWithTimeout(apiUrl(conn, `/api/files/find?${params}`), {
    headers: NO_HEADERS,
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Find ${res.status}`);
  }
  if (!res.body) throw new Error("Find: no response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) onEvent(JSON.parse(line) as FileFindEvent);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Build a URL to serve raw file contents from a narrative's fold.
 *  The `raw` flag tells the server to stream bytes (for <img>/<iframe> src)
 *  rather than the JSON metadata that fetchFiles() expects. */
export function filesRawUrl(conn: ConnectionParams, nid: string, path: string): string {
  // No token here: `apiUrl` adds it, and a second one would not authenticate.
  const params = new URLSearchParams({ nid, path, raw: "1" });
  return apiUrl(conn, `/api/files?${params}`);
}

/** Fetch the server-generated HTML export of a narrative. `palette` is this
 *  device's 🎨 Recolor salt for it, so the export's foreign speakers wear the
 *  hues the operator is looking at; 0 (the default) is left off the URL.
 *  `seqs` is the chat's current message selection — present, the server exports
 *  those messages, or, under `mode: "except"`, everything but them; absent,
 *  the whole conversation. */
export async function fetchNarrativeExportHtml(
  conn: ConnectionParams,
  nid: string,
  palette = 0,
  seqs?: number[] | null,
  mode: SeqSelectionMode = "only",
): Promise<Blob> {
  const selection = formatSeqParam(seqs);
  // The mode rides only when there is a selection for it to invert, and only
  // when it is not the default — so an ordinary excerpt's URL is the one brane
  // built before the complement existed.
  const seqsMode = selection ? formatSeqModeParam(mode) : null;
  const query = (palette > 0 ? `&palette=${palette}` : "")
    + (selection ? `&seqs=${selection}` : "")
    + (seqsMode ? `&seqs_mode=${seqsMode}` : "");
  const res = await fetchWithTimeout(
    apiUrl(conn, `/api/narratives/${nid}/export?format=html${query}`),
    { headers: NO_HEADERS },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Export ${res.status}`);
  }
  return res.blob();
}

/** Highlight an arbitrary code snippet via the server's Shiki instance. */
export async function fetchHighlight(
  conn: ConnectionParams,
  content: string,
  lang: string,
): Promise<FileHighlight | null> {
  const res = await fetchWithTimeout(apiUrl(conn, `/api/highlight`), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ content, lang }),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.highlight ?? null;
}

export interface DiagramResult {
  svg: string;
  labels: string[];
}

/** Render a ```mermaid fence to static SVG on the daemon.
 *
 *  `null` means "not a diagram brane draws" — a gantt chart, a syntax error,
 *  a graph past the size bounds — and is a normal answer, not an error. The
 *  caller falls back to the highlighted code block, which is what a mermaid
 *  fence rendered as before this existed.
 *
 *  Server-side like `/api/highlight`, and unlike KaTeX: inline math is
 *  ubiquitous and light so it earns its place in the bundle, while a layout
 *  engine in every browser to draw the occasional flowchart does not. */
export async function fetchDiagram(
  conn: ConnectionParams,
  source: string,
): Promise<DiagramResult | null> {
  const res = await fetchWithTimeout(apiUrl(conn, `/api/diagram`), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ source }),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.diagram ?? null;
}

export interface FileListResponse {
  files: string[];
  truncated: boolean;
}

/** Fetch a flat list of all file paths under a narrative's fold. */
export async function fetchFileList(
  conn: ConnectionParams,
  nid: string,
): Promise<FileListResponse> {
  const params = new URLSearchParams({ nid });
  const res = await fetchWithTimeout(apiUrl(conn, `/api/files/list?${params}`), {
    headers: NO_HEADERS,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `File list ${res.status}`);
  }
  return res.json();
}

// Which payloads render inline and which are handed over as files is one
// rule, and the daemon enforces the other half of it with
// `Content-Disposition` — so the predicate lives in shared code rather than
// being spelled out again here. It used to be, and the two copies had already
// drifted over `.avif`.
export { isInlinePayload } from "@shared/payload-inline";

export interface RotateTokenResponse {
  token: string;
  expires_at: number;
  /** A rotation someone else began was pending and this one voided it. */
  replaced: boolean;
}

/** Begin a token rotation: the daemon mints a new token and hands it back,
 *  but keeps the old one valid until the new one is first *used* (or 60 s
 *  pass unused). So the caller must follow this with a request under the new
 *  token — `probeDaemon(host, token)` — which is what actually signs the other
 *  devices out. A lost response here costs nothing: nothing has changed yet.
 *  Bodiless on purpose: a POST with no headers needs no preflight, and there
 *  is nothing to say. */
export async function rotateToken(conn: ConnectionParams): Promise<RotateTokenResponse> {
  const res = await fetchWithTimeout(apiUrl(conn, "/api/token/rotate"), {
    method: "POST",
    headers: NO_HEADERS,
  });
  if (!res.ok) throw new Error(`Rotate ${res.status}`);
  return res.json() as Promise<RotateTokenResponse>;
}

/** Mint a device token for a device about to be melded. The daemon keeps only
 *  its hash, so the token in the response is the one and only copy: the Meld
 *  QR carries it, and the device showing the QR never hands over its own.
 *  Bodiless, like `rotateToken`: the daemon's default label will do. Resolves
 *  null on a 404, a daemon from before hashing, which has no route and only
 *  the one shared token. */
export async function mintDeviceToken(
  conn: ConnectionParams,
): Promise<{ token: string; validForMs?: number } | null> {
  const res = await fetchWithTimeout(apiUrl(conn, "/api/tokens"), {
    method: "POST",
    headers: NO_HEADERS,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Mint ${res.status}`);
  }
  const data = (await res.json()) as { token: string; validForMs?: number };
  // A daemon from before the lapse sends no validForMs: its tokens never lapse.
  return { token: data.token, validForMs: data.validForMs };
}

/** One live token, as `GET /api/tokens` lists it (`DeviceListing`,
 *  src/daemon/token-routes.ts). */
export interface DeviceToken {
  id: string;
  /** `agent`: one narrative's session, which holds it in its env. */
  kind: "local" | "device" | "agent";
  /** For an agent token, its narrative. */
  owner_nid?: string | null;
  label: string;
  origin: "minted" | "adopted";
  created_at: number;
  last_used_at: number | null;
  /** "Safari on iPhone", from the User-Agent it was first presented with. */
  device: string | null;
  remote_addr: string | null;
  /** The same two, from the latest request. */
  last_device: string | null;
  last_remote_addr: string | null;
  /** The `Origin` it was first presented from — which copy of the app the
   *  device runs — and the latest. Null until a request carries one. */
  app_origin: string | null;
  last_app_origin: string | null;
  /** Last presented from an address other than its first: a copy of the
   *  token, or the same device on another network. */
  elsewhere_at: number | null;
  /** Who added it: "this machine", another device, or null if unrecorded. */
  minted_by_device: string | null;
  /** The token this request was made with: this device. */
  current: boolean;
  /** Has a socket open right now. */
  connected: boolean;
  /** Live devices this one added, directly or down a chain, minus this
   *  device and anything it added: what revoking it may take with it. */
  descendants: string[];
  /** Narratives this token last launched (spawned, ran or revived). */
  agents: Array<{ id: string; title: string | null; status: string | null; agent_type: string | null }>;
  /** A meld QR nobody has scanned yet; it lapses at `expires_at`. */
  unused: boolean;
  expires_at: number | null;
}

/** The Devices list. Resolves null on a 404, a daemon from before the list. */
export async function listDeviceTokens(conn: ConnectionParams): Promise<DeviceToken[] | null> {
  const res = await fetchWithTimeout(apiUrl(conn, "/api/tokens"), { headers: NO_HEADERS });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Devices ${res.status}`);
  return ((await res.json()) as { tokens: DeviceToken[] }).tokens;
}

/** Sign out one device. Bodiless, like `rotateToken`, so no preflight. A 404
 *  means it was already revoked (a double-tap, or another device got there
 *  first), which is the outcome asked for, so it resolves. */
export async function revokeDeviceToken(
  conn: ConnectionParams,
  id: string,
  /** Devices it added, to revoke with it. In the query string, so the
   *  request stays bodiless. */
  also: readonly string[] = [],
): Promise<void> {
  const query = also.length ? `?also=${also.map(encodeURIComponent).join(",")}` : "";
  const res = await fetchWithTimeout(apiUrl(conn, `/api/tokens/${encodeURIComponent(id)}/revoke${query}`), {
    method: "POST",
    headers: NO_HEADERS,
  });
  if (res.ok || res.status === 404) return;
  const data = await res.json().catch(() => ({}));
  throw new Error(data.error ?? `Revoke ${res.status}`);
}

/** Probe a daemon and return its status for registry use */
export async function probeDaemon(
  host: string,
  token: string,
): Promise<DaemonStatus> {
  const conn: ConnectionParams = { host, token };
  const res = await fetchWithTimeout(apiUrl(conn, "/api/status"), {
    headers: NO_HEADERS,
  });
  if (!res.ok) throw new Error(`Status ${res.status}`);
  return res.json() as Promise<DaemonStatus>;
}
