/**
 * The pieces of the token routes that hold their own logic, kept out of the
 * server's closure so the suite can drive them (`src/test/token-routes.test.ts`,
 * `src/test/token-devices.test.ts`): minting a device token, finishing a
 * rotation, and the Devices list with its per-device revoke.
 */

import type { DbTokenStore, LaunchedAgent, TokenListing } from "../db/tokens.js";
import { describeUserAgent } from "../user-agent.js";
import { UNUSED_TOKEN_LAPSE_MS, WS_CLOSE_TOKEN_ROTATED, type TokenKind, type TokenRecord, type TokenRing } from "./token-ring.js";

const MAX_LABEL_LENGTH = 200;

/** The label a `POST /api/tokens` body asks for, or why the body is refused.
 *  Separate from minting so the route can refuse a bad body before it asks
 *  the operator to approve anything (src/daemon/presence-gate.ts). */
export function parseMintBody(rawBody: string | null | undefined, now: number = Date.now()): { label: string } | { error: string } {
  let parsed: unknown = {};
  if (rawBody && rawBody.trim()) {
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return { error: "Body must be a JSON object" };
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "Body must be a JSON object" };
  }
  const { label } = parsed as { label?: unknown };
  // Control characters become spaces: a label is logged and will be shown in
  // a devices list, and a newline in either is a forged line.
  const clean = typeof label === "string" ? label.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim() : "";
  return { label: clean ? clean.slice(0, MAX_LABEL_LENGTH) : `melded ${new Date(now).toISOString().slice(0, 10)}` };
}

/** `POST /api/tokens`: mint a device token from a request body. The daemon
 *  keeps only the hash, so the `token` in a 200 is the one and only copy, and
 *  `expiresAt` is when it lapses if nothing has used it by then. An
 *  empty body is fine (`brane meld` sends `{}` or nothing); a body that is not
 *  a JSON object is a 400. */
export function mintDeviceTokenRoute(
  ring: TokenRing,
  rawBody: string | null | undefined,
  now: number = Date.now(),
  /** The requester's row: recorded on the new one, so the list can say which
   *  device added which, and nothing later has to guess. */
  mintedBy?: TokenRecord,
):
  | { status: 200; body: { token: string; id: string; label: string; expiresAt: number; validForMs: number } }
  | { status: 400; body: { error: string } } {
  const parsed = parseMintBody(rawBody, now);
  if ("error" in parsed) return { status: 400, body: parsed };
  const { token, record } = ring.issue("device", parsed.label, now, { mintedBy: mintedBy?.id });
  return {
    status: 200,
    body: {
      token,
      id: record.id,
      label: record.label,
      expiresAt: now + UNUSED_TOKEN_LAPSE_MS,
      // Relative too, for a client whose clock is not the daemon's.
      validForMs: UNUSED_TOKEN_LAPSE_MS,
    },
  };
}

interface Closable {
  close(code?: number, reason?: string): void;
}

/** Finish a rotation, inside the request that first used the new token and
 *  before it is answered: close every viewer socket opened under a revoked
 *  row with 4401, and only those. */
export function retireTokens<S extends Closable>(opts: {
  retired: { ids: readonly string[] };
  viewerSockets: Map<S, SocketOwners>;
}): { closed: number } {
  return { closed: closeSocketsOf(opts.viewerSockets, opts.retired.ids, "token rotated") };
}

/** Whether a socket opened under `record` on `channel` must be closed when
 *  that token is revoked or rotated away. Control and terminal sockets
 *  always. An MCP socket only under a device token: a device token can open
 *  `/ws/mcp`, which reaches every MCP tool, so a revoke that left it open
 *  would leave the revoked token working for as long as it stayed connected;
 *  an agent token's MCP socket is that agent's bridge, and closing it is what
 *  revoking an agent means.
 *  A local bridge is exempt — it dialed as this account, which is not what
 *  a device revoke or rotation retires. */
export function closesOnRevoke(channel: "control" | "terminal" | "mcp", record: TokenRecord): boolean {
  return channel !== "mcp" || record.kind !== "local";
}

/** The token rows a socket belongs to: revoking any of them closes it. */
export type SocketOwners = string | readonly string[];

/** Which rows own a socket. Usually one, the token that opened it. An MCP
 *  socket bound to a narrative also belongs to that narrative's agent token,
 *  whoever dialed it: a device's socket must close when the *device* is
 *  revoked (the dialer), and an external's socket dialed as this account
 *  must close when its *agent* is revoked (the narrative). Tagging only one
 *  of the two is how a revoked device kept its MCP socket open
 *  (claude-jrjh1e8w:13 #1). */
export function socketOwners(
  channel: "control" | "terminal" | "mcp",
  record: TokenRecord,
  narrativeAgentToken?: string | null,
): string[] {
  const ids = closesOnRevoke(channel, record) ? [record.id] : [];
  if (channel === "mcp" && narrativeAgentToken && !ids.includes(narrativeAgentToken)) ids.push(narrativeAgentToken);
  return ids;
}

/** Close every viewer socket opened under one of `ids` with 4401, the code
 *  the app reads as "signed out" rather than a network blip, and forget it.
 *  Returns how many it closed. */
export function closeSocketsOf<S extends Closable>(
  viewerSockets: Map<S, SocketOwners>,
  ids: readonly string[],
  reason = "token revoked",
): number {
  const revoked = new Set(ids);
  let closed = 0;
  for (const [ws, owners] of viewerSockets) {
    const list = typeof owners === "string" ? [owners] : owners;
    if (!list.some((id) => revoked.has(id))) continue;
    viewerSockets.delete(ws);
    try { ws.close(WS_CLOSE_TOKEN_ROTATED, reason); } catch {}
    closed++;
  }
  return closed;
}

/** A row of `GET /api/tokens`: the stored row, plus what the list needs to
 *  show it — a readable device name, whether it is the requester, and when an
 *  unscanned QR stops working. */
export interface DeviceListing extends TokenListing {
  /** "Safari on iPhone" from the first sighting, which names the row. */
  device: string | null;
  /** The same, from the latest sighting. */
  last_device: string | null;
  /** Who added this device: "this machine" (`brane meld`), the device that
   *  showed the Meld QR, or null if not recorded (minted before the column). */
  minted_by_device: string | null;
  current: boolean;
  /** A socket opened under this token is open right now, so "last seen" is
   *  now, whatever `last_used_at` says. */
  connected: boolean;
  /** Live devices this one added, directly or down a chain, minus the
   *  requester and anything it added: what revoking this row may cascade to
   *  (`?also=`). Empty for the account row, which is never revoked. */
  descendants: string[];
  /** Narratives this token last launched (spawned, ran or revived). */
  agents: LaunchedAgent[];
  expires_at: number | null;
}

function withoutExternals(store: Pick<DbTokenStore, "externalsOf">, rootId: string, ids: string[]): string[] {
  const externals = new Set(store.externalsOf([rootId, ...ids]));
  return ids.filter((id) => !externals.has(id));
}

/** `GET /api/tokens`: every live token, the local one included (shown, never
 *  revocable from here). */
export function listTokensRoute(
  store: Pick<DbTokenStore, "list" | "descendants" | "launched" | "externalsOf">,
  requester: TokenRecord,
  now: number = Date.now(),
  connected: ReadonlySet<string> = new Set(),
): { status: 200; body: { tokens: DeviceListing[] } } {
  const launched = store.launched();
  const tokens = store.list(now).map((t) => ({
    ...t,
    device: describeUserAgent(t.user_agent),
    last_device: describeUserAgent(t.last_user_agent),
    minted_by_device:
      t.minted_by === null
        ? null
        : t.minted_by_kind === "local"
          ? "this machine"
          : describeUserAgent(t.minted_by_user_agent) ?? "an unknown device",
    current: t.id === requester.id,
    connected: connected.has(t.id),
    expires_at: t.unused ? t.created_at + UNUSED_TOKEN_LAPSE_MS : null,
    // Externals are left out: they go with their dialer regardless, so
    // offering them as a choice would be a checkbox that does nothing.
    descendants: t.kind !== "local" && t.id !== requester.id ? withoutExternals(store, t.id, store.descendants(t.id, requester.id)) : [],
    agents: launched.get(t.id) ?? [],
  }));
  return { status: 200, body: { tokens } };
}

/** What a revoke would do, or why it is refused, without doing it: the
 *  checks of `revokeTokenRoute`, which the route runs before asking the
 *  operator to approve a device's sign-out, so a request that would fail
 *  never raises a prompt. The revoke itself runs them again, since the rows
 *  can change while the prompt is up. */
export function planRevoke(
  store: Pick<DbTokenStore, "get" | "descendants" | "externalsOf">,
  requester: TokenRecord,
  id: string,
  also: readonly string[] = [],
):
  | { row: TokenRecord; extra: string[]; ids: string[] }
  | { status: 400 | 404 | 409; body: { error: string } } {
  const row = store.get(id);
  if (!row) return { status: 404, body: { error: "No live token with that id" } };
  if (row.kind === "local") {
    return { status: 400, body: { error: "That row is this machine's own account, which holds no token and cannot be revoked" } };
  }
  if (row.id === requester.id) {
    return { status: 409, body: { error: "That is this device; use \"Sign out other devices\" to keep it and sign out the rest" } };
  }
  const allowed = new Set(store.descendants(row.id, requester.id));
  const extra = [...new Set(also)];
  const stray = extra.filter((x) => !allowed.has(x));
  if (stray.length) {
    return { status: 400, body: { error: `Not a device this one added: ${stray.join(", ")}` } };
  }
  const chosen = [row.id, ...extra];
  // Plus the externals any of them dialed in, always: they are those
  // tokens' credentials in another form, not devices of their own.
  const ids = [...chosen, ...store.externalsOf(chosen).filter((x) => !chosen.includes(x))];
  return { row, extra, ids };
}

/** `POST /api/tokens/:id/revoke`: revoke one device token. Bodiless, so the
 *  app sends it without a preflight. Three refusals, each naming the route
 *  that does what the caller probably meant:
 *
 *  - the account row (`local`): it is this machine's CLI and MCP bridges on
 *    `daemon.sock`, which hold no token, so there is nothing to revoke;
 *  - the requester's own token: a device revoking itself strands itself, and
 *    "Sign out other devices" is the version that keeps it in;
 *  - an id that is not live: 404, so a double-tap reads as already done.
 *
 *  On success the row is revoked (never deleted) and any rotation that device
 *  had begun is abandoned — otherwise its pending token could confirm later
 *  and write the device back in. The caller closes the row's sockets. */
export function revokeTokenRoute(
  store: Pick<DbTokenStore, "get" | "revoke" | "descendants" | "externalsOf">,
  ring: Pick<TokenRing, "abandonRotationBy">,
  requester: TokenRecord,
  id: string,
  now: number = Date.now(),
  /** Devices to revoke with it: each must be one this row added, directly or
   *  down a chain, and not the requester or anything it added. Checked here,
   *  so the list can never be used to revoke an unrelated device. */
  also: readonly string[] = [],
):
  | {
      status: 200;
      body: { revoked: string; kind: TokenKind; label: string; also: string[]; ids: string[]; abandonedRotation: boolean };
    }
  | { status: 400 | 404 | 409; body: { error: string } } {
  const plan = planRevoke(store, requester, id, also);
  if ("status" in plan) return plan;
  const { row, extra, ids } = plan;
  // One write: the device and the ones it added go together, or none do.
  store.revoke(ids, now);
  let abandonedRotation = false;
  for (const x of ids) abandonedRotation = ring.abandonRotationBy(x) || abandonedRotation;
  return { status: 200, body: { revoked: row.id, kind: row.kind, label: row.label, also: extra, ids, abandonedRotation } };
}

/** `POST /api/token/forget`: a device signs itself out — the app's "Delete
 *  permanently" on a daemon it no longer wants, so no live token is left
 *  behind on the daemon that nobody holds. Bodiless, like the revoke. The
 *  per-device revoke refuses the requester's own token because "Sign out
 *  other devices" is usually what was meant; here stranding itself is the
 *  point. Only a device token can ask: this machine's account holds no token,
 *  and an agent's is not offered the route. The externals it dialed in go
 *  with it, as they do with any revoke; devices it added stay. */
export function forgetSelfRoute(
  store: Pick<DbTokenStore, "revoke" | "externalsOf">,
  ring: Pick<TokenRing, "abandonRotationBy">,
  requester: TokenRecord,
  now: number = Date.now(),
):
  | { status: 200; body: { revoked: string; label: string; ids: string[]; abandonedRotation: boolean } }
  | { status: 400; body: { error: string } } {
  if (requester.kind !== "device") {
    return { status: 400, body: { error: `Only a device's token can sign itself out; this is a ${requester.kind} token` } };
  }
  const ids = [requester.id, ...store.externalsOf([requester.id]).filter((x) => x !== requester.id)];
  store.revoke(ids, now);
  let abandonedRotation = false;
  for (const x of ids) abandonedRotation = ring.abandonRotationBy(x) || abandonedRotation;
  return { status: 200, body: { revoked: requester.id, label: requester.label, ids, abandonedRotation } };
}
