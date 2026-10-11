/**
 * The daemon's bearer tokens, and how they change hands.
 *
 * **Only hashes are stored.** Every token is a random UUID the daemon hands
 * out exactly once — to the device that asked, or to the agent session it
 * launches — and keeps nothing but its SHA-256 in the `tokens` table
 * (`src/db/tokens.ts`). That table therefore
 * authenticates nothing by itself, and the daemon cannot print a token back:
 * a device that needs one gets a freshly minted one (`POST /api/tokens`,
 * which is what `brane meld` calls). This is a claim about the table, not
 * about `brane.db`: events and captured tool calls are stored verbatim
 * (`prepareCaptureText`, src/db/tool-uses.ts), so a token an agent printed or
 * quoted is in the database in the clear until a rotation retires it. The tokens are 122 random bits, so a plain
 * SHA-256 is the right hash; a slow one only helps a guessable secret.
 *
 * A `device` token is held by a web client as a durable credential — a
 * registry entry written from a meld QR. This machine's own CLI and MCP
 * bridges hold none: they reach the daemon over `daemon.sock` and present
 * nothing, and act as the one live `local` row, the account row, which no
 * token opens (`bootstrapTokens`, src/db/tokens.ts).
 *
 * Rotation is what "sign out other devices" means here. The hard part is not
 * the rotation but not stranding the device that asked for it. The obvious
 * shape — rotate returns the new token and the old dies on the spot — has one
 * failure the request layer's own history makes real: on a satellite link, if
 * the *response* is lost, the daemon has rotated and nobody holds the new
 * token, the requester included. And a `POST` is rightly never retried, so
 * the client cannot paper over it.
 *
 * So the swap happens **on first use**. `beginRotation` mints a *pending*
 * token for the requester and changes nothing durable; every live token still
 * authenticates. The first request that presents the pending token is the
 * proof it arrived, and only then is it written down: it becomes a row of the
 * requester's kind, and the requester's old row and every other device row
 * are revoked — `authenticate` reports which, and the daemon closes the
 * sockets they opened. The account row is never among them, so the CLI and
 * MCP bridges ride through a phone's rotation the way they always have. A
 * pending token nobody ever uses lapses after
 * `ROTATION_GRACE_MS` and nothing has changed: a lost response costs nothing,
 * and a restart mid-handshake (this state is in-memory) lands on the safe
 * side.
 *
 * What rotation guarantees is only this: once it completes, holders of the
 * requester's old token, and of every other device token, are out. It cannot
 * stop a token holder from calling the route first — a token already grants
 * keystrokes into every tmux session, so that adds nothing — but it must
 * never *help* them, which is why a pending token is issued exactly once
 * (see `beginRotation`).
 *
 * The shell's "sign out every device" (`brane token rotate`) needs none of
 * that: it holds no token to swap, so nothing of its own can be stranded by
 * a lost response, and `signOutDevices` revokes on the spot.
 *
 * Rows are revoked, never deleted.
 */

import { createHash, randomBytes } from "node:crypto";

/** How long a minted-but-unused token stays valid before the rotation is
 *  abandoned. Long enough for a slow link's round trip plus a reconnect;
 *  short enough that a token stolen at the worst moment is not good for long
 *  if the requester vanishes. */
export const ROTATION_GRACE_MS = 60_000;

/** How long a minted device token may sit unused before it lapses. A meld QR
 *  is scanned on the spot; one that never was — every opening of the app's
 *  Meld sheet mints one — would otherwise stay a full-power credential for
 *  good, wherever the QR was photographed, and a phantom row in any devices
 *  list. First use makes a token permanent, as before. Only minted device
 *  tokens lapse: the account row and adopted ones are already in use. */
/** Label for the token brane used before hashing, adopted as a device row so
 *  every device that already holds it keeps working. Only a label: what marks
 *  an adopted row is its `origin`, which no rename can change. */
export const LEGACY_TOKEN_LABEL = "melded before hashing";

/** What a rotation's replacement row is labelled when the requester's own
 *  label was `LEGACY_TOKEN_LABEL`: the new token was minted, not melded
 *  before hashing, and a label that says otherwise is wrong. */
export const ROTATED_LEGACY_LABEL = "kept when other devices were signed out";

export const UNUSED_TOKEN_LAPSE_MS = 10 * 60_000;

export { WS_CLOSE_TOKEN_ROTATED } from "../shared/token-rotation.js";

/** `local`: this Unix account — the CLI and MCP bridges on `daemon.sock`,
 *  which present no token. `device`: one melded web
 *  client. `agent`: one narrative's session, handed to it in its tmux env as
 *  `BRANE_NARRATIVE_SECRET` and bound to that narrative (`ownerNid`). */
export type TokenKind = "local" | "device" | "agent";

export interface TokenRecord {
  id: string;
  kind: TokenKind;
  label: string;
  /** For an `agent` token, the one narrative it may act as. */
  ownerNid?: string | null;
  /** From `live()`: a minted device token nobody has presented yet — a QR
   *  not scanned, so not a device anyone is signed in on. */
  unused?: boolean;
}

/** Where a request presenting a token came from — what a Devices list shows
 *  to tell one row from another. A store records the first one it is given
 *  for a row and keeps it. */
export interface TokenSighting {
  userAgent?: string | null;
  remoteAddr?: string | null;
}

/** Where token hashes live. The daemon's is the `tokens` table; the suite
 *  uses `MemoryTokenStore`. Only *live* (unrevoked) rows are ever returned. */
export interface TokenStore {
  find(hash: string, now: number, seen?: TokenSighting): TokenRecord | null;
  /** Record a token this daemon minted. A store may also hold tokens adopted
   *  from plaintext (src/db/tokens.ts), but the ring only ever mints, so a
   *  rotation's replacement is always a minted token. */
  insert(
    hash: string,
    kind: TokenKind,
    label: string,
    now: number,
    opts?: { used?: boolean; seen?: TokenSighting; mintedBy?: string },
  ): TokenRecord;
  revoke(ids: readonly string[], now: number): void;
  live(kind: TokenKind): TokenRecord[];
  /** Inside a completing rotation: move the requester's old row's children
   *  onto its replacement, and revoke the agent tokens of external
   *  narratives that the retired rows dialed in. An external's token is a
   *  bearer anyone holding a token can mint with one `/ws/mcp` dial, so a
   *  rotation that left them would leave a stolen token's holder a way back
   *  in. Spawned agents are not touched. Returns the ids it revoked. */
  retireDependents?(retired: readonly string[], requesterId: string, replacementId: string, now: number): string[];
  /** Run `fn` as one unit: all of its writes land, or none do. */
  transaction<T>(fn: () => T): T;
  /** The live `local` row, as `find` would return it for that row's token —
   *  sighting and last-used stamped the same way — or null if there is none.
   *  What a request over the daemon's Unix socket with no token is: this
   *  Unix account, which the `local` row stands for. */
  account?(now: number, seen?: TokenSighting): TokenRecord | null;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A device token for a daemon on another machine (`brane meld --remote`),
 *  and its hash. Nothing here stores either: only the hash goes to that
 *  machine (`BRANE_DEVICE_TOKEN_SHA256`), which its daemon adopts at
 *  startup, and the token goes no further than the QR. */
export function mintRemoteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export interface PendingRotation {
  hash: string;
  requester: TokenRecord;
  expiresAt: number;
}

export type AuthResult =
  | { ok: false }
  | {
      ok: true;
      /** The row the presented token belongs to — what a socket opened by
       *  this request is tagged with. */
      record: TokenRecord;
      /** Set on the one request that completes a rotation: the rows that
       *  just stopped being valid, whose sockets should close. */
      retired?: { ids: string[] };
    };

export class TokenRing {
  private pending: PendingRotation | null = null;

  constructor(
    private readonly store: TokenStore,
    private readonly mint: () => string,
  ) {}

  /** The unexpired pending rotation, if any; expiry is checked lazily here
   *  rather than by a timer so the ring has no lifecycle of its own. */
  pendingRotation(now: number = Date.now()): PendingRotation | null {
    if (this.pending && this.pending.expiresAt <= now) this.pending = null;
    return this.pending;
  }

  /** Mint a new token and record only its hash — the caller hands the
   *  plaintext to whoever asked and keeps no copy. */
  issue(
    kind: TokenKind,
    label: string,
    now: number = Date.now(),
    opts: { mintedBy?: string } = {},
  ): { token: string; record: TokenRecord } {
    const token = this.mint();
    return { token, record: this.store.insert(hashToken(token), kind, label, now, opts) };
  }

  /** Mint a pending token for `requester`. A rotation already pending is
   *  *replaced*, never re-issued: the only copy of a pending token must be
   *  the response that minted it. Handing the same token to a second caller
   *  would give it to exactly the party rotation exists to evict — anyone
   *  holding a token can call this route too, and during the window they
   *  would be handed the new one to use first. Replacing instead means a
   *  racing rotate invalidates the requester's token, whose confirming
   *  request then fails visibly (and `replaced` is logged) rather than
   *  succeeding with a guest aboard. Nothing is lost for the honest retry: a
   *  client that timed out has discarded the first response, so a fresh
   *  token is as good.
   *
   *  Throws for a `local` requester. Completing a rotation writes a row of
   *  the requester's kind under the new token, so one begun for this account
   *  would put back a token that opens the `local` row — the copyable local
   *  token `bootstrapTokens` retires. That "no token opens this machine's
   *  row" must hold here, not only in the one route that calls this
   *  (`gatedRotateRoute`, which sends this account to `signOutDevices`). */
  beginRotation(
    requester: TokenRecord,
    now: number = Date.now(),
  ): { token: string; expiresAt: number; replaced: boolean } {
    if (requester.kind === "local") {
      throw new Error("This account holds no token to rotate; signOutDevices is what signs devices out for it");
    }
    const replaced = this.pendingRotation(now) !== null;
    const token = this.mint();
    this.pending = { hash: hashToken(token), requester, expiresAt: now + ROTATION_GRACE_MS };
    return { token, expiresAt: this.pending.expiresAt, replaced };
  }

  /** Abandon a pending rotation begun by `tokenId`. Revoking a device must
   *  also void a rotation it started: otherwise its pending token would
   *  confirm afterwards and write the revoked device back in as a fresh row,
   *  signing out everyone else on the way. Returns whether one was dropped. */
  abandonRotationBy(tokenId: string): boolean {
    if (this.pending?.requester.id !== tokenId) return false;
    this.pending = null;
    return true;
  }

  /** Sign out every device at once, for a requester that holds no token:
   *  this account, over the daemon's socket. Revokes every live device row
   *  and the externals they dialed in, and voids any pending rotation — its
   *  requester is a device, which has just been signed out, and its pending
   *  token must not write it back in. Returns the revoked ids, whose sockets
   *  the caller closes, and how many of them were devices someone was signed
   *  in on: an unscanned QR is revoked too, but it was nobody's device. */
  signOutDevices(requester: TokenRecord, now: number = Date.now()): { ids: string[]; devices: number; replaced: boolean } {
    const replaced = this.pendingRotation(now) !== null;
    const result = this.store.transaction(() => {
      const live = this.store.live("device");
      const devices = live.map((d) => d.id);
      this.store.revoke(devices, now);
      const dependents = this.store.retireDependents?.(devices, requester.id, requester.id, now) ?? [];
      return { ids: [...new Set([...devices, ...dependents])], devices: live.filter((d) => !d.unused).length };
    });
    this.pending = null;
    return { ...result, replaced };
  }

  /** Authenticate a request that presented no token but arrived where only
   *  this Unix account can reach (the daemon's socket, its directory
   *  checked): it acts as the live `local` row. The caller decides the
   *  "where"; this only says whether there is a row to act as. */
  authenticateAccount(now: number = Date.now(), seen?: TokenSighting): AuthResult {
    const record = this.store.account?.(now, seen) ?? null;
    return record ? { ok: true, record } : { ok: false };
  }

  /** Check a presented token. A live row always authenticates; the pending
   *  token authenticates and, in doing so, is written down and retires the
   *  requester's old row and every other device row — the caller gets
   *  `retired` exactly once and is expected to act on it (close those rows'
   *  sockets) before answering the request. */
  authenticate(
    presented: string | null | undefined,
    now: number = Date.now(),
    seen?: TokenSighting,
  ): AuthResult {
    if (presented == null || presented === "") return { ok: false };
    const hash = hashToken(presented);
    const record = this.store.find(hash, now, seen);
    if (record) return { ok: true, record };
    const live = this.pendingRotation(now);
    if (live && hash === live.hash) {
      const { requester } = live;
      // One transaction, so a rotation either completes or never happened: a
      // new token that works while nobody was signed out is the failure this
      // must not have. If it throws, the pending token survives for a retry.
      const result = this.store.transaction(() => {
        // Written as used: this very request is its first use, and a device
        // that rotates and then only holds a socket open must not lapse. Its
        // sighting is this request's — the device that asked to rotate.
        const label = requester.label === LEGACY_TOKEN_LABEL ? ROTATED_LEGACY_LABEL : requester.label;
        const replacement = this.store.insert(hash, requester.kind, label, now, { used: true, seen });
        const ids = new Set([requester.id]);
        for (const d of this.store.live("device")) if (d.id !== replacement.id) ids.add(d.id);
        this.store.revoke([...ids], now);
        for (const x of this.store.retireDependents?.([...ids], requester.id, replacement.id, now) ?? []) ids.add(x);
        return { replacement, ids: [...ids] };
      });
      this.pending = null;
      return { ok: true, record: result.replacement, retired: { ids: result.ids } };
    }
    return { ok: false };
  }
}

/** A `TokenStore` in memory, for the suite and for anything that needs a
 *  ring without a database. */
export class MemoryTokenStore implements TokenStore {
  private rows = new Map<string, TokenRecord & { hash: string; revokedAt: number | null }>();
  private seq = 0;

  /** Seed with plaintext tokens — only their hashes are kept. */
  constructor(seed: Array<{ token: string; kind: TokenKind; label?: string }> = []) {
    for (const s of seed) this.insert(hashToken(s.token), s.kind, s.label ?? s.kind);
  }

  find(hash: string): TokenRecord | null {
    for (const r of this.rows.values()) {
      if (r.hash === hash && r.revokedAt === null) return { id: r.id, kind: r.kind, label: r.label };
    }
    return null;
  }

  insert(hash: string, kind: TokenKind, label: string): TokenRecord {
    const id = `t${++this.seq}`;
    this.rows.set(id, { id, kind, label, hash, revokedAt: null });
    return { id, kind, label };
  }

  revoke(ids: readonly string[], now: number): void {
    for (const id of ids) {
      const r = this.rows.get(id);
      if (r && r.revokedAt === null) r.revokedAt = now;
    }
  }

  live(kind: TokenKind): TokenRecord[] {
    return [...this.rows.values()]
      .filter((r) => r.kind === kind && r.revokedAt === null)
      .map(({ id, kind, label }) => ({ id, kind, label }));
  }

  account(): TokenRecord | null {
    return this.live("local")[0] ?? null;
  }

  transaction<T>(fn: () => T): T {
    const snapshot = new Map([...this.rows].map(([id, r]) => [id, { ...r }]));
    const seq = this.seq;
    try {
      return fn();
    } catch (err) {
      this.rows = snapshot;
      this.seq = seq;
      throw err;
    }
  }
}
