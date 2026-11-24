/**
 * What an agent's token may reach. Default-deny: a route is open to an agent
 * only if it is listed here, so a route added later is closed to agents
 * until someone decides otherwise.
 *
 * Open: reading brane (narratives, events, files, wiki, search), the pure
 * renderers, and the session lifecycle agents drive themselves — spawn and
 * revive (/ramify, reviving a peer) — and the memory index. Closed:
 *
 * - `/ws/terminal/:nid` and `/ws/control`, the app's channels: keystrokes
 *   into any session, and signals. (tmux still lets one agent reach
 *   another's pane; that is known and accepted, SECURITY.md.)
 * - The operator's housekeeping: registering and archiving folds,
 *   archiving narratives, absorb, cost backfill and reprice, the Devices
 *   list. An operator who wants one of these from a phone runs it in a
 *   utility session (the spawn dialog's Utility side), whose env carries
 *   no agent token.
 * - `POST /api/run`: a utility session's env carries no agent token, so
 *   starting one would hand an agent this account's standing in a single
 *   call. Only the app starts those; there is no CLI command for it.
 * - `POST /api/sleep`: a host's sleep stops every session on it, which is
 *   the operator's to decide. An agent that wants to stop runs `/idle`.
 * - `human_signal` (src/daemon/signal-source.ts) and the gated acts
 *   (src/daemon/presence-gate.ts), which refuse agents with their own
 *   messages; they are closed here too, so the list stays the whole story.
 *
 * Hygiene, not containment: an agent runs as the operator's Unix account
 * and can drop its token and use `daemon.sock` (SECURITY.md, "What an agent
 * token does not do"). What this stops is an agent that follows the rules
 * overreaching, and a leaked agent token reaching any of the above.
 */

/** Routes an agent token may use, as `METHOD path-pattern`. `:x` matches
 *  one path segment, `*` the rest of the path. */
export const AGENT_ROUTES: readonly string[] = [
  "GET /api/status",
  "GET /api/branes",
  "GET /api/protocols",
  "GET /api/folds",
  "GET /api/narratives",
  "GET /api/narratives/recent",
  "GET /api/narratives/:id",
  "GET /api/narratives/:id/events",
  "GET /api/narratives/:id/export",
  "GET /api/narratives/:id/tool_uses",
  "GET /api/narratives/:id/tool_uses/:key",
  "GET /api/payloads/:nid/*",
  "GET /api/files",
  "GET /api/files/list",
  "GET /api/files/find",
  "GET /api/wiki/read",
  "GET /api/wiki/asset",
  "GET /api/spawn-history",
  "GET /api/run-history",
  "POST /api/search",
  "POST /api/wiki/search",
  "POST /api/diagram",
  "POST /api/highlight",
  "POST /api/memory/index",
  "POST /api/spawn",
  "POST /api/revive/:nid",
  // /rrr: `brane daemon restart` from the agent's own checkout. The daemon
  // re-runs its own command, never one the request names.
  "POST /api/daemon/restart",
  // Bound to the token's own narrative where the upgrade is handled.
  "GET /ws/mcp",
];

/** What an agent is told when a route is closed to it. */
export const AGENT_SCOPE_REFUSAL =
  "An agent's token cannot use this route; it is the operator's. From a phone, run the command in a utility session (the spawn dialog's Utility side), which carries no agent token";

/** Closed routes whose refusal says more than `AGENT_SCOPE_REFUSAL`,
 *  because a utility session is not the answer for them. */
export const AGENT_SLEEP_REFUSAL =
  "An agent cannot put its host to sleep; that stops every session on it, so the operator does it, from the app. To pause yourself, /idle";

const AGENT_ROUTE_REFUSALS: ReadonlyArray<readonly [route: string, refusal: string]> = [
  ["POST /api/sleep", AGENT_SLEEP_REFUSAL],
];

type Matcher = { method: string; segments: string[] };

function toMatchers(routes: readonly string[]): Matcher[] {
  return routes.map((route) => {
    const [method, pattern] = route.split(" ");
    return { method, segments: pattern.split("/").slice(1) };
  });
}

/** A predicate over `METHOD path-pattern` routes, as `AGENT_ROUTES` is
 *  written: `:x` matches one non-empty segment, `*` the rest of the path.
 *  Shared with the verification gate's free list. */
export function routeMatcher(routes: readonly string[]): (method: string, path: string) => boolean {
  const matchers = toMatchers(routes);
  return (method, path) => {
    const segments = path.split("/").slice(1);
    return matchers.some((m) => matches(m, method, segments));
  };
}

const MATCHERS: Matcher[] = toMatchers(AGENT_ROUTES);

function matches(m: Matcher, method: string, segments: string[]): boolean {
  if (m.method !== method) return false;
  for (let i = 0; i < m.segments.length; i++) {
    const want = m.segments[i];
    if (want === "*") return i < segments.length && segments.slice(i).every((s) => s !== "");
    if (i >= segments.length) return false;
    if (want.startsWith(":")) {
      if (segments[i] === "") return false;
      continue;
    }
    if (want !== segments[i]) return false;
  }
  return m.segments.length === segments.length;
}

export const AGENT_LOOPBACK_REFUSAL =
  "An agent's token works only from this machine";

/** Why a request made with an agent's token is refused, or null if it may
 *  go on. An agent's token works only from this machine — over
 *  `daemon.sock` or loopback — so a copy that leaks off it opens nothing.
 *  That costs no client anything: a spawned agent's MCP bridge and an
 *  external client's (`brane mcp`, started from its `.mcp.json`) both run
 *  here and dial the socket. */
export function agentRefusal(req: { method: string; path: string; loopback: boolean }): string | null {
  if (!req.loopback) return AGENT_LOOPBACK_REFUSAL;
  if (agentMayUse(req.method, req.path)) return null;
  for (const [route, refusal] of AGENT_ROUTE_REFUSALS) {
    if (routeMatcher([route])(req.method.toUpperCase(), req.path)) return refusal;
  }
  return AGENT_SCOPE_REFUSAL;
}

export const AGENT_REVIVE_REFUSAL =
  "An agent cannot revive or prompt a utility session: it carries no agent token, so typing into it would act as this account";

/** Why an agent may not revive (or prompt) a narrative with this role, or
 *  null if it may. A `utility` narrative is a session the app started
 *  through `POST /api/run`: its env carries no agent token, so a prompt
 *  typed into it — or its command replayed — runs as this account, the
 *  standing closing that route withholds.
 *  Reviving or prompting another agent stays open: tmux already lets agents
 *  reach each other, which is accepted. */
export function agentReviveRefusal(role: string | null | undefined): string | null {
  return role === "utility" ? AGENT_REVIVE_REFUSAL : null;
}

/** Whether an agent's token may make this request. `path` is the URL's
 *  pathname, without the query string. A WebSocket upgrade is a `GET`. */
export function agentMayUse(method: string, path: string): boolean {
  const segments = path.split("/").slice(1);
  return MATCHERS.some((m) => matches(m, method.toUpperCase(), segments));
}
