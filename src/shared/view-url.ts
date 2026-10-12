/** The URL contract for a narrative view: which tab is active, which tabs are
 *  pinned beside it, and which file (and line range) the Files pane is showing.
 *
 *  This lives in `shared/` rather than in the screen that uses it because the
 *  URL is the only carrier of view state between two *origins*. Tab layout and
 *  last-visited file are also kept in `sessionStorage`, which is origin-scoped,
 *  and the Isolate menu item hops between the shared app's origin and a
 *  daemon's own host —
 *  so whatever isn't in the query string does not survive the jump. Keeping
 *  the serialization and the link builder in one pure module means the URL you
 *  get from tapping around and the URL Isolate hands the other origin are the
 *  same URL, and means both can be tested without a browser.
 */

export type Tab = "chat" | "terminal" | "files";

/** Tab order, as rendered in the tab bar. Pins serialize in this order no
 *  matter what order they were toggled in, so a URL is stable. */
export const CANONICAL_TABS: Tab[] = ["chat", "terminal", "files"];

const VALID_TABS = new Set<Tab>(CANONICAL_TABS);

/** True when this page is served by the daemon it is connected to — a
 *  daemon's own bundle — so "isolated" is the *current* state and the menu
 *  offers the way back out. Everything else is a shared app: the hosted
 *  shell, a staging hostname, a fork's deployment, a dev server. The app
 *  carries no host of its own, so this is a comparison with no constant in
 *  it: `window.location.host` against the connection's host, which a
 *  daemon's bundle fills from the same `location.host` (expo/lib/api.ts).
 *  Hosts are case-insensitive; the port is part of the answer, since a
 *  daemon's bundle is reached on its port. */
export function isIsolated(pageHost: string, daemonHost: string): boolean {
  return pageHost.toLowerCase() === daemonHost.toLowerCase();
}

export function parseActiveTab(tab?: string): Tab {
  return VALID_TABS.has(tab as Tab) ? (tab as Tab) : "chat";
}

export function parsePinnedTabs(pinned?: string): Set<Tab> {
  if (!pinned) return new Set<Tab>();
  return new Set<Tab>(
    pinned.split(",").map((s) => s.trim()).filter((s): s is Tab => VALID_TABS.has(s as Tab)),
  );
}

export function serializePinned(pins: Set<Tab>): string {
  return CANONICAL_TABS.filter((t) => pins.has(t)).join(",");
}

/** The view-state query params as a plain record, with `undefined` for anything
 *  at its default — which is both how `router.setParams` clears a param and how
 *  `buildIsolateUrl` knows to drop a stale one. */
export function viewParams(
  tab: Tab,
  pins: Set<Tab>,
  path?: string,
  line?: number,
  lineEnd?: number,
): Record<string, string | undefined> {
  const pinsSerialized = serializePinned(pins);
  const lineStr = line
    ? (lineEnd && lineEnd > line ? `${line}-${lineEnd}` : String(line))
    : undefined;
  return {
    tab: tab !== "chat" ? tab : undefined,
    pinned: pinsSerialized || undefined,
    path: path || undefined,
    line: lineStr,
  };
}

/** The narrative's terminal, alone — where the two lifecycle actions land.
 *
 *  Both Revive and End put you in front of a prompt you have to answer: a
 *  resumed agent often comes up sitting on one, and a termination is just as
 *  often *blocked* by one. So they navigate to a **view**, not merely to a
 *  narrative.
 *
 *  It goes in the URL rather than being set after arrival because an explicit
 *  `tab` param is what outranks the tab layout the screen would otherwise
 *  restore from `sessionStorage`; state set on arrival would be racing that
 *  restore. No pins, per the "alone" half: whatever was pinned belongs to the
 *  view you were in, not to the prompt you now have to answer.
 */
export function terminalOnlyHref(nid: string): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(viewParams("terminal", new Set()))) {
    if (value) params.set(key, value);
  }
  return `/${nid}?${params.toString()}`;
}

/** Reads the `line` param back: `"10"` or `"10-20"`. The counterpart of the
 *  `line` that `viewParams` writes, and the reason both live here — a param
 *  whose writer and reader sit in different modules drifts.
 *
 *  Note the deliberate asymmetry at `lineEnd === line`: the writer collapses
 *  that to a bare `"10"`, so it reads back as a single line rather than a
 *  one-line range. Same selection either way. */
export function parseLineSpec(s: string | null | undefined): { line?: number; lineEnd?: number } {
  if (!s) return {};
  const m = s.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return {};
  const line = Number(m[1]);
  const end = m[2] ? Number(m[2]) : undefined;
  return end !== undefined && end >= line ? { line, lineEnd: end } : { line };
}

/** The params that describe *which daemon*, as opposed to what you are looking
 *  at. They are origin-scoped: meaningful to the page that received them, never
 *  to be carried onward. */
export const CONNECTION_PARAMS = ["host", "token"] as const;

/** A search string with the connection params removed and everything else left
 *  alone, ready to hand to `history.replaceState`.
 *
 *  The shared SPA cleans a meld URL as soon as it has used it, so the token
 *  doesn't linger in the address bar or the back stack. Cleaning by resetting
 *  to the bare pathname would take the view with it — tab, pins, open file,
 *  scroll target — which is precisely what an Isolate hop just finished
 *  carrying across. Returns `""` or a string with a leading `?`.
 *
 *  New links carry the connection in the fragment (see `connectionFragment`),
 *  so this is the legacy half of the cleaner: old QR codes and bookmarks still
 *  arrive with `?token=`, and they are still honored and still scrubbed.
 */
export function withoutConnectionParams(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of CONNECTION_PARAMS) params.delete(key);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/** The fragment counterpart of `withoutConnectionParams`: a hash with the
 *  connection params removed and anything else left alone. Returns `""` or a
 *  string with a leading `#`. Accepts the hash with or without its `#`. */
export function withoutConnectionHash(hash: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return "";
  const params = new URLSearchParams(raw);
  for (const key of CONNECTION_PARAMS) params.delete(key);
  const rest = params.toString();
  return rest ? `#${rest}` : "";
}

/** Where a link puts the daemon's address and token: the URL **fragment**.
 *
 *  A query string is part of the HTTP request, so `?host=…&token=…` on a
 *  shared-app link reached its host's edge with the daemon's
 *  bearer token in it, landed in the daemon's own request log on an Isolate
 *  hop, and was fetched by every chat app's link unfurler when a meld URL was
 *  pasted. A fragment is never sent to any server: the browser keeps it, the
 *  page reads it from `location.hash`, and the app strips it once consumed.
 *
 *  The shared SPA serves every daemon and must be told which one; a daemon's
 *  own bundle already knows, so it gets the token alone.
 */
export function connectionFragment(conn: { host: string; token: string }, includeHost: boolean): string {
  const params = new URLSearchParams();
  if (includeHost) params.set("host", conn.host);
  params.set("token", conn.token);
  return `#${params.toString()}`;
}

export interface ViewUrlOptions {
  /** `window.location.host` of the page building the link: the hostname,
   *  plus the port when there is one. */
  host: string;
  /** `window.location.protocol` — `"https:"` or `"http:"`. */
  protocol: string;
  /** `window.location.search`, leading `?` optional. */
  search: string;
  /** Path to open, with its leading slash — usually `/<nid>`. */
  path: string;
  /** Where the daemon actually lives, and the token to reach it with. */
  conn: { host: string; token: string };
  /** The shared app's host, as the daemon reports it (`app_domain` in
   *  `GET /api/status`): where a daemon's own bundle hops *out* to. A shared
   *  app never needs it, since the shared origin is its own; a daemon's
   *  bundle without it has no way out, and `buildIsolateUrl` says so. */
  appHost?: string | null;
  /** Live view state, from `viewParams`. */
  view: Record<string, string | undefined>;
}

/** Which of the two kinds of origin a link should point at: the shared
 *  multi-daemon SPA, or a single daemon's own bundle. */
export type UrlTarget = "shared" | "daemon";

/** The same narrative, in the same view, somewhere else — the one builder
 *  behind both menu items.
 *
 *  Params come from two places, and the order matters. The current search
 *  string seeds the set, which picks up params the screen doesn't model —
 *  `scrollToSeq`, so the new page opens at the message you'd jumped to. Live
 *  state is then overlaid and wins on everything it does own, because a layout
 *  restored from `sessionStorage` never writes itself back to the URL: seeding
 *  alone would miss exactly the case with the most to lose.
 *
 *  Connection params are always dropped and re-set, never carried: they
 *  describe the origin building the link, and the target needs its own. The
 *  view rides in the query string; the connection rides in the fragment, which
 *  no server ever sees (`connectionFragment`).
 */
export function buildViewUrl(target: UrlTarget, opts: ViewUrlOptions): string | null {
  const { protocol, search, path, conn, view } = opts;
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(view)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  for (const key of CONNECTION_PARAMS) params.delete(key);
  const query = params.toString();
  const rest = (query ? `?${query}` : "") + connectionFragment(conn, target === "shared");

  if (target === "shared") {
    // A shared app serves every daemon, so it has to be told which one.
    const origin = sharedOrigin(opts);
    return origin === null ? null : `${origin}${path}${rest}`;
  }
  // A daemon's own bundle already knows which daemon it is; only the token is
  // needed. The scheme follows the page building the link, so a plain-http LAN
  // session doesn't hand out https links that won't load.
  return `${pageScheme(protocol)}://${conn.host}${path}${rest}`;
}

function pageScheme(protocol: string): "https" | "http" {
  return protocol === "https:" ? "https" : "http";
}

/** The shared app's origin, from where this page stands. On a shared app it
 *  is this page's own origin, scheme included (a dev server is plain http).
 *  On a daemon's own bundle it is whatever the daemon reports as its
 *  `app_domain`, over https, since that is a hosted shell; with none
 *  reported there is no shared origin to name, and the answer is null. */
function sharedOrigin(opts: ViewUrlOptions): string | null {
  if (!isIsolated(opts.host, opts.conn.host)) return `${pageScheme(opts.protocol)}://${opts.host}`;
  return opts.appHost ? `https://${opts.appHost}` : null;
}

/** Isolate / Unisolate: the same view, on the *other* kind of origin. Which
 *  way it goes is just where you are now. Null only from a daemon's own
 *  bundle that was told no `appHost`: there is nowhere to hop out to, and
 *  the menu should say so rather than offer a link. */
export function buildIsolateUrl(opts: ViewUrlOptions): string | null {
  return buildViewUrl(isIsolated(opts.host, opts.conn.host) ? "shared" : "daemon", opts);
}

/** Meld: the same view, on another *device*. The origin kind is the one thing
 *  that must not change — someone reaching the daemon directly can't be handed
 *  a shared-app link, and someone on a shared app expects to stay on *that*
 *  one — so where Isolate flips, this stays put. It never needs `appHost`:
 *  the shared origin it names is the page's own, so it is never null. */
export function buildMeldUrl(opts: ViewUrlOptions): string {
  return buildViewUrl(isIsolated(opts.host, opts.conn.host) ? "daemon" : "shared", opts)!;
}
