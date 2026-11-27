/**
 * The verification gate: a melded device must prove the operator is holding
 * it before it acts, and the daemon is the only judge of that proof
 * (docs/passkeys.md). Phase 2 of six: the gate itself, dormant. No proof
 * can be given yet — no verifier is built — so `brane config verification`
 * refuses to leave `off` (src/commands/config.ts), and with it off every
 * device token counts as verified forever. What this phase pins is the
 * shape: which requests are free, that everything else is an act, who is
 * never gated, and what a refusal looks like.
 *
 * **Default deny.** `FREE_ROUTES` names every read; a route not on it is an
 * act, however it arrives. `ACT_ROUTES` names the acts that exist today and
 * which act each is, so the fresh class (`verification.fresh`) can be
 * configured by name; a route on neither list is still an act, just an
 * unnamed one. `src/test/verification-gate.test.ts` checks every route
 * literal in server.ts against the two lists, so a route added later is
 * placed on purpose. Likewise the sockets: a message type not in the free
 * set is an act, checked per message, because an open socket must not
 * outlive the window.
 *
 * **Who is gated.** A `device` token only. An `agent` token cannot do Face
 * ID and is bounded by `AGENT_ROUTES` instead; the tokenless shell over
 * `daemon.sock` is this account, and the acts that reach off the machine
 * are held by the presence gate. Who is asking is read from the token's
 * kind, never the address.
 *
 * **The refusal is 403, never 401.** The app signs a daemon out on 401
 * (`expo/lib/api.ts`, `markSignedOut`); the token here is live and merely
 * unverified.
 */

import type Database from "better-sqlite3";
import { getConfig } from "../commands/config.js";
import { routeMatcher } from "./agent-scope.js";
import type { TokenKind } from "./token-ring.js";

export type VerificationMode = "off" | "passkey" | "oidc";
export const VERIFICATION_MODES: readonly VerificationMode[] = ["off", "passkey", "oidc"];

/** The acts that exist today, by name: what `verification.fresh` lists. */
export const ACT_NAMES = [
  "terminal",
  "signal",
  "spawn",
  "run",
  "revive",
  "mint",
  "mcp-dial",
  "revoke",
  "rotate",
  "forget",
  "enroll",
  "revoke-credential",
  "approve-protocol",
  "revoke-protocol",
  "restart",
  "sleep",
] as const;
export type ActName = (typeof ACT_NAMES)[number];

/** Acts that create persistence: a token or a credential that outlives the
 *  window. They ignore the window and need a proof given within
 *  `FRESH_WINDOW_MS` **and not yet spent**: a passing fresh-class act clears
 *  `fresh_until`, so one proof buys one such act, and one verified window
 *  cannot buy access after it closes (docs/passkeys.md, "The fresh class"). */
export const DEFAULT_FRESH_ACTS: readonly ActName[] = ["mint", "mcp-dial", "enroll", "revoke-credential", "approve-protocol"];
export const DEFAULT_WINDOW_MINUTES = 10;
export const MAX_WINDOW_MINUTES = 24 * 60;
/** How recent a proof must be for a fresh-class act, and how long a proof
 *  given under a window of zero stays good for its one act. */
export const FRESH_WINDOW_MS = 60_000;

/** Every read, named; never "every GET". A WebSocket upgrade is a GET too:
 *  the control and terminal sockets are free to open and judged per
 *  message; `GET /ws/mcp` under a device token is a mint (ACT_ROUTES). */
export const FREE_ROUTES: readonly string[] = [
  "GET /api/status",
  "GET /api/tailnet",
  "GET /api/branes",
  "GET /api/protocols",
  "GET /api/protocols/pending",
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
  "GET /api/tokens",
  "GET /api/absorb/survey",
  "POST /api/search",
  "POST /api/wiki/search",
  "POST /api/diagram",
  "POST /api/highlight",
  "POST /api/memory/index",
  // Operator housekeeping: reversible, nothing executes, nothing leaves the
  // machine. Free on purpose and listed so the choice is visible
  // (docs/passkeys.md, open question 4).
  "POST /api/folds",
  "PATCH /api/folds/archive",
  "PATCH /api/branes/archive",
  "PATCH /api/narratives/:id/archive",
  "POST /api/absorb",
  "POST /api/cost/backfill",
  "POST /api/cost/reprice",
  "POST /api/hooks/tool-use",
  // Verification's own routes, and a device's cancel of a presence prompt.
  // `begin` hands the caller's own token an approval; the page's routes
  // carry that approval, not a token, and are answered before the token
  // check (src/daemon/verification-ceremony.ts).
  "POST /api/verify/begin",
  "POST /api/verify/challenge",
  "POST /api/verify/webauthn",
  "POST /api/verify/end",
  "GET /api/credentials",
  "POST /api/credentials/challenge",
  "POST /api/credentials",
  "POST /api/presence/cancel",
  // Free to open; each message is then judged on its own.
  "GET /ws/control",
  "GET /ws/terminal/:nid",
];

/** The acts that exist today and which act each one is. A route on neither
 *  list is an unnamed act: refused when unverified, and the test fails until
 *  it is placed. */
export const ACT_ROUTES: ReadonlyArray<readonly [route: string, act: ActName]> = [
  ["POST /api/narratives/:id/signal", "signal"],
  ["POST /api/spawn", "spawn"],
  ["POST /api/run", "run"],
  ["POST /api/revive/:nid", "revive"],
  ["POST /api/tokens", "mint"],
  ["POST /api/tokens/remote", "mint"],
  ["GET /ws/mcp", "mcp-dial"],
  ["POST /api/tokens/:id/revoke", "revoke"],
  ["POST /api/token/rotate", "rotate"],
  ["POST /api/token/forget", "forget"],
  ["POST /api/credentials/begin", "enroll"],
  ["POST /api/credentials/:id/revoke", "revoke-credential"],
  ["POST /api/protocols/approve", "approve-protocol"],
  ["POST /api/protocols/revoke", "revoke-protocol"],
  ["POST /api/daemon/restart", "restart"],
  // The operator's Sleep button (src/daemon/sleep.ts): stops the host and
  // every session on it. Closed to agents, which are bounded by AGENT_ROUTES.
  ["POST /api/sleep", "sleep"],
];

/** Control-socket messages that read: subscriptions and their undoing.
 *  `signal` is an act; so is any type not named here. */
export const FREE_CONTROL_MESSAGES: ReadonlySet<string> = new Set(["subscribe", "unsubscribe", "subscribe_activity", "unsubscribe_activity"]);
/** Terminal-socket messages that read or size the mirror. `keys`, `paste`,
 *  `mouse` and `clear_history` are acts; so is any type not named here. */
export const FREE_TERMINAL_MESSAGES: ReadonlySet<string> = new Set(["start", "stop", "resize", "refresh"]);

const isFree = routeMatcher(FREE_ROUTES);
const actMatchers = ACT_ROUTES.map(([route, act]) => ({ match: routeMatcher([route]), act }));

export type RouteClass = { kind: "free" } | { kind: "act"; act: ActName | null };

/** Free, or which act. Unknown routes are acts with no name. */
export function classifyRoute(method: string, path: string): RouteClass {
  if (isFree(method, path)) return { kind: "free" };
  for (const m of actMatchers) if (m.match(method, path)) return { kind: "act", act: m.act };
  return { kind: "act", act: null };
}

export interface VerificationConfig {
  mode: VerificationMode;
  windowMs: number;
  fresh: ReadonlySet<ActName>;
}

export const DEFAULT_VERIFICATION_CONFIG: VerificationConfig = {
  mode: "off",
  windowMs: DEFAULT_WINDOW_MINUTES * 60_000,
  fresh: new Set(DEFAULT_FRESH_ACTS),
};

/** Whether the app can answer a refusal yet: its lock sheet and the hop to
 *  the ceremony page (docs/passkeys.md, phase 3b). Until it can, switching
 *  the gate on would leave every device facing `403`s it cannot get past,
 *  so the switch stays refused while enrollment and verification are lived
 *  with on `/verify` directly. */
export const APP_ANSWERS_REFUSALS = true;

/** Why a value for one of the `verification*` keys is refused, or null. */
export function configValueRefusal(
  key: string,
  value: string,
  opts: {
    /** Live credentials that can verify here: enrolled for the host the
     *  daemon serves, or any when that host is not yet known. */
    credentials: number;
    /** Live credentials enrolled for another host, by that host: what a
     *  rename of the machine or the tailnet leaves behind
     *  (src/daemon/verification-rename.ts). */
    orphaned?: ReadonlyMap<string, number>;
    rpId?: string | null;
    appAnswersRefusals?: boolean;
  },
): string | null {
  switch (key) {
    case "verification":
      if (!(VERIFICATION_MODES as readonly string[]).includes(value)) return `verification must be one of ${VERIFICATION_MODES.join(", ")}`;
      if (value !== "off" && opts.credentials === 0 && opts.orphaned && opts.orphaned.size > 0 && opts.rpId) {
        const was = [...opts.orphaned].map(([host, n]) => `${n} enrolled for ${host}`).join(", ");
        return (
          `Every enrolled credential is bound to another hostname (${was}) and this daemon serves ${opts.rpId}, ` +
          "so none can verify here and switching verification on would lock every device out; enroll one on this host first, from the app's Devices view"
        );
      }
      if (value !== "off" && opts.credentials === 0) {
        return "No credential is enrolled, so switching verification on would lock every device out; enroll one first, from the app's Devices view";
      }
      if (value !== "off" && !(opts.appAnswersRefusals ?? APP_ANSWERS_REFUSALS)) {
        return "The app cannot answer a verification refusal yet (its lock sheet is docs/passkeys.md, phase 3b), so switching verification on would strand every device; enroll and verify on the daemon's /verify page meanwhile";
      }
      return null;
    case "verification.window": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > MAX_WINDOW_MINUTES) return "verification.window is whole minutes, 0 to 1440";
      return null;
    }
    case "verification.fresh": {
      const bad = parseActList(value).filter((a) => !(ACT_NAMES as readonly string[]).includes(a));
      if (bad.length > 0) return `verification.fresh names acts; unknown: ${bad.join(", ")} (known: ${ACT_NAMES.join(", ")})`;
      return null;
    }
    default:
      return null;
  }
}

export function parseActList(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

/** The three config values, read through `getConfig` so `brane config`'s
 *  writes (which go straight to the database) are honoured. A value the
 *  validator would refuse, written some other way (a direct database write,
 *  a newer daemon's value read by an older one), **fails closed**: a mode
 *  this daemon does not know gates as `passkey`, a window out of range is
 *  clamped, an unknown act name is reported. `warn` hears each such value;
 *  the gate says it once. */
export function readVerificationConfig(db: Database.Database, warn: (message: string) => void = () => {}): VerificationConfig {
  const mode = (getConfig("verification", db) ?? "off").trim();
  const window = getConfig("verification.window", db) ?? String(DEFAULT_WINDOW_MINUTES);
  const fresh = getConfig("verification.fresh", db) ?? DEFAULT_FRESH_ACTS.join(",");
  let resolvedMode: VerificationMode;
  if ((VERIFICATION_MODES as readonly string[]).includes(mode)) resolvedMode = mode as VerificationMode;
  else if (mode === "") resolvedMode = "off";
  else {
    warn(`verification is "${mode}", which this daemon does not know; gating as passkey until it is set to one of ${VERIFICATION_MODES.join(", ")}`);
    resolvedMode = "passkey";
  }
  const minutes = Number(window);
  let windowMs: number;
  if (!Number.isInteger(minutes)) {
    warn(`verification.window is "${window}", not whole minutes; using ${DEFAULT_WINDOW_MINUTES}`);
    windowMs = DEFAULT_VERIFICATION_CONFIG.windowMs;
  } else {
    const clamped = Math.min(Math.max(minutes, 0), MAX_WINDOW_MINUTES);
    if (clamped !== minutes) warn(`verification.window is ${minutes}; clamped to ${clamped}`);
    windowMs = clamped * 60_000;
  }
  const names = parseActList(fresh);
  const unknown = names.filter((a) => !(ACT_NAMES as readonly string[]).includes(a));
  if (unknown.length > 0) warn(`verification.fresh names acts this daemon does not know: ${unknown.join(", ")}; they are not gated as fresh`);
  return {
    mode: resolvedMode,
    windowMs,
    fresh: new Set(names.filter((a): a is ActName => (ACT_NAMES as readonly string[]).includes(a))),
  };
}

/** What the daemon holds per token: until when it is verified, and until
 *  when its last proof counts as fresh. Null means never. */
/** What last proved the operator on a device token: the credential's row id
 *  (or `oidc:<sub>`), the method, and when. The record an act keeps
 *  (docs/passkeys.md, "The record"). */
export interface Proof {
  by: string;
  method: string;
  at: number;
}

export interface VerificationState {
  verifiedUntil: number | null;
  freshUntil: number | null;
}

export const VERIFICATION_REQUIRED = "This device must verify the operator before it acts";
export const VERIFICATION_FRESH = "This act needs a proof given within the last minute";

export interface VerificationRefusal {
  status: 403;
  body: { error: string; verification: "required" | "fresh" };
}

export const REFUSAL_REQUIRED: VerificationRefusal = { status: 403, body: { error: VERIFICATION_REQUIRED, verification: "required" } };
export const REFUSAL_FRESH: VerificationRefusal = { status: 403, body: { error: VERIFICATION_FRESH, verification: "fresh" } };

/** The frame a socket sends back in place of the message it dropped. */
export function verifyFrame(refusal: VerificationRefusal): { type: "verify"; verification: "required" | "fresh"; error: string } {
  return { type: "verify", verification: refusal.body.verification, error: refusal.body.error };
}

/** Null when the act may go on, else the refusal. Pure: the record's kind,
 *  the act, the config, the token's state and the clock. */
export function actRefusal(
  kind: TokenKind,
  act: ActName | null,
  cfg: VerificationConfig,
  state: VerificationState,
  now: number,
): VerificationRefusal | null {
  if (kind !== "device") return null;
  if (cfg.mode === "off") return null;
  if (act !== null && cfg.fresh.has(act)) {
    return state.freshUntil !== null && state.freshUntil > now ? null : REFUSAL_FRESH;
  }
  return state.verifiedUntil !== null && state.verifiedUntil > now ? null : REFUSAL_REQUIRED;
}

/** Null when the route is free or the act may go on, else the refusal. */
export function routeRefusal(
  kind: TokenKind,
  method: string,
  path: string,
  cfg: VerificationConfig,
  state: VerificationState,
  now: number,
): VerificationRefusal | null {
  const cls = classifyRoute(method, path);
  if (cls.kind === "free") return null;
  return actRefusal(kind, cls.act, cfg, state, now);
}

/** What `GET /api/status` reports, so the app knows the posture. */
export function verificationStatus(cfg: VerificationConfig): { mode: VerificationMode; window_minutes: number; fresh: ActName[] } {
  return { mode: cfg.mode, window_minutes: cfg.windowMs / 60_000, fresh: [...cfg.fresh] };
}

/** What a store must answer for the gate: a token's state, read each time
 *  it is asked, since a proof can land between two messages; and spending
 *  it, since a passing act consumes what it used. */
export interface VerificationReader {
  verification(id: string, now: number): VerificationState;
  /** Spend a proof in one conditional write, and say whether there was one
   *  to spend: `fresh` clears `fresh_until` if it is still ahead of `now`;
   *  `all` clears both columns if `verified_until` is. The check and the
   *  spend are one statement, so two acts racing for one proof cannot both
   *  pass, whatever awaits between the gate and the act
   *  (claude-bu1kt8a5:44). */
  spend(id: string, what: "fresh" | "all", now: number): boolean;
  /** The last proof on a live device token, whether or not its window is
   *  still open; null for a row never verified, and for any other kind. */
  lastProof(id: string): Proof | null;
}

/** What a passing act spends: nothing, its freshness, or the whole proof. */
export function consumption(act: ActName | null, cfg: VerificationConfig): "fresh" | "all" | null {
  if (cfg.windowMs === 0) return "all";
  if (act !== null && cfg.fresh.has(act)) return "fresh";
  return null;
}

/** The gate the daemon holds: config re-read at most once a second (the
 *  CLI writes it to the database directly), state re-read per check, and
 *  what a passing act used spent on the way out. */
export class VerificationGate {
  private cached: { at: number; cfg: VerificationConfig } | null = null;
  private warned = new Set<string>();

  constructor(
    private readonly db: Database.Database,
    private readonly store: VerificationReader,
    private readonly now: () => number = Date.now,
    private readonly configTtlMs = 1_000,
    private readonly log: (message: string) => void = (m) => console.error(`[verification] ${m}`),
  ) {}

  config(): VerificationConfig {
    const t = this.now();
    if (!this.cached || t - this.cached.at >= this.configTtlMs) {
      const cfg = readVerificationConfig(this.db, (m) => {
        if (this.warned.has(m)) return;
        this.warned.add(m);
        this.log(m);
      });
      this.cached = { at: t, cfg };
    }
    return this.cached.cfg;
  }

  /** The check. An act that spends its proof passes iff the one conditional
   *  write found a proof to spend; one that spends nothing reads the state.
   *  A refused act spends nothing, and an act the route then refuses (a bad
   *  body, a presence prompt declined) has still spent its proof: that
   *  fails closed, and moving the spend after the act would open the race
   *  the single write closes. */
  private check(record: { id: string; kind: TokenKind }, act: ActName | null): VerificationRefusal | null {
    const cfg = this.config();
    if (cfg.mode === "off" || record.kind !== "device") return null;
    const now = this.now();
    const spends = consumption(act, cfg);
    if (spends === "fresh") return this.store.spend(record.id, "fresh", now) ? null : REFUSAL_FRESH;
    if (spends === "all") return this.store.spend(record.id, "all", now) ? null : REFUSAL_REQUIRED;
    return actRefusal(record.kind, act, cfg, this.state(record, now), now);
  }

  private state(record: { id: string; kind: TokenKind }, now: number): VerificationState {
    // Only a device's row is ever read: the other kinds are never gated.
    return record.kind === "device" ? this.store.verification(record.id, now) : { verifiedUntil: null, freshUntil: null };
  }

  /** For an HTTP request or a socket upgrade. */
  refuseRoute(record: { id: string; kind: TokenKind }, method: string, path: string): VerificationRefusal | null {
    const cls = classifyRoute(method, path);
    if (cls.kind === "free") return null;
    return this.check(record, cls.act);
  }

  /** For a socket message: the act it is, or null for a type the daemon
   *  does not know, which is still an act. */
  refuseAct(record: { id: string; kind: TokenKind }, act: ActName | null): VerificationRefusal | null {
    return this.check(record, act);
  }

  /** What let this device's act through, for the record the act keeps
   *  (docs/passkeys.md, "The record"): the credential, the method, and when.
   *  Read after the check has passed. Null while the gate is off, since
   *  nothing was proved, and for any token but a device's. Under a window of
   *  zero the check has already spent the window; the proof's identity
   *  outlives it, so the record is still written. */
  proof(record: { id: string; kind: TokenKind }): Proof | null {
    if (this.config().mode === "off" || record.kind !== "device") return null;
    return this.store.lastProof(record.id);
  }
}
