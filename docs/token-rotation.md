# Token Rotation

"Sign out other devices." The daemon stores its tokens **as hashes only**,
in the `tokens` table (`src/db/tokens.ts`), so that table authenticates
nothing by itself and the daemon can never print a token back. (The rest of
`brane.db` is another matter: narrations and captured tool calls are kept
verbatim, so a token an agent printed or quoted is in there in the clear
until a rotation retires it. See SECURITY.md, "What hashing does not
cover".) There are two kinds. Each web client holds a **device** token as a durable credential
— a registry entry in `localStorage`, written from a meld QR — and `brane
meld` mints a fresh one for every QR (`POST /api/tokens`), as does the app's
Meld sheet each time it opens, so each device can be revoked alone. This
machine's CLI and MCP bridges hold **no token**: outside an agent session
they present nothing over `daemon.sock` (`resolveCredential`,
`src/daemon/client.ts`), and a request there with no token acts as the one
live **local** row, the account row (`TokenStore.account`,
`authenticateRequest`; see [The CLI is a daemon
client](daemon-api.md#the-cli-is-a-daemon-client)). No token opens that row
— see [No local token](#no-local-token). Inside an agent session they
present `BRANE_NARRATIVE_SECRET`. Each agent session holds an
**agent** token of its own — see [Agent tokens](#agent-tokens). Rows are
revoked, never deleted.

**An unscanned meld token lapses.** Every QR mints a full-power device
token, and since the app's Meld sheet mints one each time it opens, most are
never scanned. A minted device token that nobody presents within
`UNUSED_TOKEN_LAPSE_MS` (10 minutes, `src/daemon/token-ring.ts`) is refused,
and its row is revoked — by `DbTokenStore.find` when it is presented late,
and by a sweep (`lapseUnused`) the daemon runs at start and every minute, so
a QR that was photographed but never used stops working and never shows up
as a device. First use makes a token permanent, as before. Three things keep
a used token from lapsing by mistake:

- A rotation's replacement row is written already used (`insert(..., { used:
  true })`): the request that completes the rotation is its first use, and a
  device that then only holds a socket open makes no further requests.
- First use is also remembered in memory, since the `last_used_at` stamp is
  best-effort; a lost stamp cannot lapse a token this daemon has seen.
- Only `device` rows with `origin = 'minted'` lapse. The account row and
  adopted tokens are in use by construction.

`POST /api/tokens` returns `expiresAt` and `validForMs`; `brane meld` prints
the window, and the Meld sheet mints a replacement a minute before its code
would lapse, so the code on screen always works.

**Upgrading signs nobody out.** Before hashing, one plaintext token sat in
`meta.daemon_token` and `.daemon_token` and on every melded device. On the
first start of a hashing daemon, `bootstrapTokens` adopts it as a device row
("melded before hashing"), so those devices keep working; removes it from
`meta` (with `secure_delete` and a WAL checkpoint, so it does not linger in
freed pages); and empties the file. A token whose
hash is already known, live or revoked, is never adopted again, so a stale
file or a stale `--token` cannot bring a revoked token back. Pinned by
`src/test/token-bootstrap.test.ts`.

**An adopted token is marked, and the daemon nags until it is gone.** Every
row carries an `origin`: `minted` by this daemon, or `adopted` from a
plaintext that existed before (the old shared token, or a `--token`).
Adopted tokens may have been written down — older daemons printed theirs in
`daemon.log` at every start, and a `--token` sits in argv and in whatever
config passes it — so while one is live, the daemon warns at startup and
`brane daemon status` says how to retire it: one rotation. The mark is a
column, not the label, so renaming the device cannot silence it. The app
warns on adopted *device* rows; an adopted agent row (a running session's
pre-#561 bind secret) is noted as replaced on its next revive. When the old
shared token is the one that asks to rotate, its replacement is labelled
"kept when other devices were signed out": it was minted then, not melded
before hashing.

**The swap happens on first use of the new token, not on the request that
minted it.** `POST /api/token/rotate` returns a *pending* token for the
requester and changes nothing durable; every live token still
authenticates. The first request that presents the new one is the proof it
arrived, and only then is it written down as a row of the requester's kind
and the requester's old row and every other device row revoked, in one
transaction (a failed write changes nothing, and the pending token survives
for the client's retry). Then every control/terminal socket those rows opened is
closed, with WebSocket close code **4401**, so a
client can tell "signed out" from a network blip. This machine rides
through a device's rotation: the CLI and agents are not "other devices". A
pending token nobody uses lapses after 60 s and nothing changes.

**The shell's rotate is one request.** `brane token rotate` holds no token
to swap, so nothing of its own can be stranded by a lost response: once the
operator passes the [presence check](presence.md#the-gate),
`TokenRing.signOutDevices` revokes every device row and the externals they
dialed in, voids any rotation a device had pending (its token must not write
that device back in), and the route answers `{ signed_out, replaced }` with
no token in it. `signed_out` counts the devices someone was signed in on; a
QR nobody scanned is revoked too but not counted. `beginRotation` throws
for a `local` requester: completing one would write a token that opens the
`local` row, and that must not depend on which route called it. An answer in the two-step shape means an older daemon; the
CLI reports that instead of claiming a sign-out that did not happen.

| Piece | Where | Does |
|---|---|---|
| `TokenRing` | `src/daemon/token-ring.ts` | Hash lookup over a `TokenStore`, the pending token, `authenticate()` that performs the swap; pinned by `src/test/token-ring.test.ts` |
| `DbTokenStore`, `bootstrapTokens()`, `legacyTokenWarning()` | `src/db/tokens.ts` | The `tokens` table, the one-time move from a plaintext token to hashes, and the warning while an adopted token is live; pinned by `src/test/token-bootstrap.test.ts` |
| `mintDeviceTokenRoute()`, `retireTokens()` | `src/daemon/token-routes.ts` | `POST /api/tokens`, and the end of a rotation: the socket sweep, run inside the request that first used the new token, before it is answered; pinned by `src/test/token-routes.test.ts` |
| `listTokensRoute()`, `revokeTokenRoute()`, `closeSocketsOf()` | `src/daemon/token-routes.ts` | The Devices list (`GET /api/tokens`) and per-device revoke (`POST /api/tokens/:id/revoke`); pinned by `src/test/token-devices.test.ts` |
| `DevicesLayer` | `expo/components/DevicesLayer.tsx` | The switcher's Devices layer: one row per token, Revoke with an in-place confirm, and "Sign out other devices" at its foot (its confirm layer is the switcher's, in `expo/app/index.tsx`) |
| `viewerSockets` | `src/daemon/server.ts` | Control + terminal sockets tagged with the token row they authenticated under. MCP bridges are deliberately absent |
| `WS_CLOSE_TOKEN_ROTATED` | `src/shared/token-rotation.ts` | The close code, shared with the app |
| `rotateActiveToken()` | `expo/app/_layout.tsx` | The requester's sequence: rotate → close own channel → `probeDaemon` under the new token → rewrite the registry entry → reconnect |
| `revoked` | `expo/lib/registry.ts` | The flag a refused entry gets. Never removed — the banner names what you were signed out of; a fresh meld of the same brane replaces the entry and clears it |
| `rotateDaemonToken()` | `src/commands/token.ts` | The CLI's version: one request, since the shell holds no token to swap; `src/test/token-rotate-cli.test.ts` pins the one-request shape, and that an older daemon's two-step answer is reported |

Five things are less obvious than they look:

**Why first use.** The naive shape — rotate returns the new token and the
old dies on the spot — has one failure the [request layer](request-layer.md)
makes real: on a 741 ms link, a lost *response* leaves the daemon rotated
and nobody, the requester included, holding the new token, and a `POST` is
rightly never retried. Under first-use, a lost response costs nothing, and a
daemon restart mid-handshake forgets the pending token and lands on the old
one — the safe side, with no new persistence.

**A pending token is issued exactly once.** The person rotation exists to
evict — whoever holds the old token — can call the route too. The first
draft answered a second call within the window with the *same* pending
token, for retry-safety, which handed an attacker racing the operator the
new credential to use first while the operator's own confirm still
succeeded. So a second `rotate` now *replaces* the pending token: the
requester's confirm fails with a 401 (the app restores its old channel and
says so) and the daemon logs `pending rotation REPLACED before use`. A
double-tap costs one visible retry; a race is visible instead of silent.
What the route still cannot do is stop an old-token holder from rotating
*first* — but the token already grants keystrokes into every tmux session,
so that is no new capability. The guarantee is only: once your rotation
completes, holders of the old token are out. When a leak is suspected to be
*live*, rotate from the shell: `brane token rotate` signs every device out
in the one request it makes, with no window. It waits for the operator
at the [presence check](presence.md#the-gate) first, before anything is
revoked.

**The requester must close its own old-token channel before confirming.**
Retirement sweeps every old-generation socket, and a control channel still
open at that moment would read its own 4401 as someone else's sign-out and
flag the entry it is about to rewrite. The order in `rotateActiveToken` is
the fix, and it is why the confirming request is an explicit `probeDaemon`
rather than "whatever request happens next".

**A 401 has two faces.** A device live at the moment of retirement gets the
4401 close and stops reconnecting. A device that loads *later* never sees
it — its upgrade is refused with a 401 the browser reports as a bare 1006 —
so the HTTP layer reports every 401 to `setUnauthorizedListener`, keyed on
the refused `{ host, token }` rather than "the active daemon", which is what
keeps a wrong token typed into the add-daemon form from signing out the one
you are connected to. `connectChannel` refuses to dial a `revoked` entry at
all: without that, the old 2 s reconnect loop would run forever and
silently, which was the pre-existing behavior on any 401.

**Sibling tabs are the same device.** They share `localStorage`, so one
tab's rotation is written where the others read it; a `storage` listener in
the root layout reconnects them on the new token instead of letting them
be refused. "Other devices" means other credential stores.

## Agent tokens

Every agent session authenticates with a token of its own, and the secret
in its env is that token: `BRANE_NARRATIVE_SECRET`. It used to be a
per-narrative bind secret, kept in plaintext in `narratives.bind_token` and
presented alongside the local token of the time; it is now an `agent` row in
`tokens`, hashed like any other, with `owner_nid` naming the one narrative
it may act as. Reusing the variable that already rode every harness's MCP
config (Claude's env, Goose's inline env, Codex's `env_vars`, Copilot's and
Cline's per-session files) meant no harness's plumbing had to change.

- **Minted per launch** (`mintAgentToken`, src/db/tokens.ts): spawn, revive,
  an agent switch, and an external client's first dial. Each launch revokes
  the narrative's previous token in the same write, so one is live per
  narrative, and the daemon has the plaintext only at that moment — which
  is why `welcome` carries a secret only for a narrative it just minted.
- **Presented as the bearer** by the MCP bridge and by the `brane` CLI when
  `BRANE_NARRATIVE_SECRET` is set (`resolveDaemonEndpoint`), so what an
  agent does is attributed to, and revocable with, its narrative. The hook
  route checks it by hash too (`verifyNarrativeBind`).
- **Bound to its narrative.** On `/ws/mcp` an agent token may bind only as
  its `owner_nid`; any other claim is refused with 403, never re-minted as
  a fresh external, which would hand a revocable credential a way around
  its own row. It cannot rotate (403): its replacement is a revive.
- **Narrower than a device, and only from here.** An agent token's routes
  are a default-deny list (`AGENT_ROUTES`, `src/daemon/agent-scope.ts`):
  reads, renderers, spawn/revive and its own `/ws/mcp`; not the
  terminal or control sockets, signals, `POST /api/run` (a utility
  session carries no agent token; nor may it revive or prompt one), the Devices list or
  the operator's housekeeping. It works only over `daemon.sock` or loopback,
  which every bridge, spawned or external, already uses. A refusal is a
  403 naming a utility session, started from the app, as the way to do it. Pinned by
  `src/test/agent-scope.test.ts`; SECURITY.md, "What an agent token can
  do", has the reasoning.
- **Revoking one closes its bridge** with 4401, including a bridge that
  dialed as this account (an external's first connection, a session
  from before agent tokens), whose socket is tagged with its narrative's
  agent token. The bridge then stops reconnecting and answers every tool
  call with "this session's brane token was revoked". The tmux session is
  left alone.
- **In the list and the cascade.** Agent rows show as "Agent claude-…",
  "started by" the device or CLI that launched them (`recordLauncher` sets
  `minted_by`), and revoking a device offers its agents' tokens too.
- **Running sessions from before agent tokens keep working**: at daemon
  start, `adoptBindTokens` turns the plaintext bind secret of each narrative
  whose tmux session is alive into an adopted agent row (once; a hash
  already known is skipped, so a revoked one never comes back). Only
  running ones: a dead or archived narrative's stored secret would
  otherwise become a permanent bearer for a session nobody runs. The
  plaintext column is left as it was; a secret not adopted authenticates
  nothing. A connected external client (no tmux session) is not adopted,
  and lands on a fresh `external-*` narrative once, at the upgrade.
  Adopted agent rows don't trigger the plaintext-token warning.
- **Archiving revokes** a narrative's agent token when its session is not
  running. Unarchiving brings nothing back; a revive mints a new one.
- **An external goes with its dialer, always.** An external's token
  records the token that dialed it (`minted_by`); it is that token's
  credential in another form, since one `/ws/mcp` dial mints it, so
  revoking the dialer revokes it with no checkbox (it isn't offered as a
  choice in the cascade), and a completing rotation revokes every external
  whose dialer is no longer live — a stolen token can't mint itself a
  survivor. Spawned agents are not touched by a rotation. The requester's own
  children are re-parented onto its replacement row.
- **The secret stays out of argv.** Launch commands reach tmux on stdin
  (`newTmuxSession`, `tmux start-server \; source-file -`; `start-server`
  because `source-file` alone needs a server already running), so neither a tmux client's nor
  a newly started tmux server's arguments carry it (a server started before
  this change keeps the command line it was started with). The daemon drops
  any inherited agent session (`INHERITED_AGENT_ENV`, `src/agent-env.ts`:
  `BRANE_NARRATIVE_*` and the harness's session-scoped variables such as
  `CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_MESSAGING_TOKEN`) from its own
  env and the tmux server's global env, and utility sessions (`POST
  /api/run`) unset
  them, so nothing that isn't the agent acts as it. Without the harness
  half, a daemon restarted from a Claude shell handed that session's id to
  every non-Claude agent it spawned, whose bridge then stamped it on their
  narrations (claude-eiuzl79r:33). Goose is the exception: its inline
  `--with-extension` env is an argument, visible in `ps` for that agent's
  life.
- **No rollback.** `main` before this change can't bind a session whose
  secret exists only as a hash; going back rebinds such sessions to fresh
  `external-*` narratives.

**Not containment:** an agent runs as your Unix user, so it can drop its
secret, reach `daemon.sock` with no token, and act as this machine instead
of as itself. Retiring `.daemon_token` did not change that; the socket gives
the same standing to the same account. A
per-agent token is attribution and revocation, not containment, and brane
offers no sandbox (SECURITY.md, "Who the operator is").

## No local token

This machine's standing is the account row: the one live `local` row, whose
`hash` column holds a placeholder (`no-token:<uuid>`, `ACCOUNT_HASH_PREFIX`)
instead of a SHA-256, so no presented token can ever match it. Only a
tokenless request over `daemon.sock` acts as it, and only this Unix account
can reach the socket.

Older branes kept a **local token** in `~/.brane/.daemon_token`, which the
CLI and bridges re-read on every use. It was a bearer token like any other:
it worked over TCP from any address the IP filter admits, so a copy of the
file (a backup, a synced home directory, an agent that printed it) was this
machine's shell from somewhere else on the tailnet. `bootstrapTokens`
retires it at daemon start:

- Every live `local` row that a token can open (`isTokenHash`) is revoked,
  whether or not its token is still in the file. What any earlier `local`
  row had minted, dialed in or launched — the rows just retired, and ones
  revoked before, by a shell rotation on an older brane or by an older
  daemon started in between — is re-parented onto the account row, so a device
  `brane meld` added last week is still "added by this machine", the agents
  `brane spawn` started are still listed under it, and its externals are
  not swept by the next rotation.
- **The file is emptied, not removed.** Its hash stays a revoked row, so an
  older brane started later cannot adopt the same token as a device. Emptying
  matters most on an install from before hashing, where the file holds the
  shared token every device still uses: that token stays live (adopted as a
  device row), and must not stay on disk. If the file cannot be emptied the
  daemon warns and carries on; the token in it is revoked either way.
- `brane doctor` reports the leftover (`– token file`) with the `rm` line.
  Removing it is the operator's to do.
- Nothing writes the file again, and no client reads it. A CLI from just
  before this change that finds it empty falls back to the socket and keeps
  working.

**There is no fallback when the socket cannot be used.** If the daemon
cannot listen on it (the path is over 103 bytes, the filesystem cannot hold
a socket, something that is not a stale socket is in the way) or `~/.brane`
is not `0700` and the daemon's own, the shell CLI and a new external MCP
client cannot reach the daemon. The daemon logs why (`[socket]`), every CLI
command says so, and `brane doctor` fails its daemon check with the reason.
Agents and signed-in devices hold tokens and are unaffected. On such a
machine the first device comes from `--token` or `BRANE_DEVICE_TOKEN_SHA256`
at daemon start. Writing the file there instead would bring back the
copyable token on exactly the machines least looked at.

Pinned by `src/test/token-bootstrap.test.ts` ("retiring the local token")
and `src/test/socket-account.test.ts`.

## The Devices list

`GET /api/tokens` lists every live token, `brane token list` prints it, and
the brane switcher's **Devices** layer shows it with a Revoke on each other
device. Less obvious than it looks:

- **A row is named by its first sighting.** The store records the
  User-Agent and peer address of the first request, HTTP or WebSocket, that
  presents the token (`DbTokenStore.find`; columns `user_agent`,
  `remote_addr`), and never overwrites them, so a row keeps naming the
  device that claimed it. A rotation's replacement takes the sighting of the
  request that confirms it, which is the requester's device.
- **A copy shows as a second address.** Beside the first sighting the store
  keeps the latest (`last_user_agent`, `last_remote_addr`, on the same
  once-a-minute throttle as `last_used_at`), and stamps `elsewhere_at` the
  moment a token is presented from an address other than its first. The
  stamp is sticky, so a copy used once is still flagged after the real
  device is back. On a tailnet each device has a stable address, so a
  second one is almost always a copy; it can also be the same phone on the
  LAN, which is why the app says "also used from another address", not
  "stolen". Loopback is one place however it is spelled (`samePlace`):
  the MCP bridge dials `localhost`, often `::1`, the CLI `127.0.0.1`, and
  both prefer the daemon's Unix socket, recorded as `daemon.sock` since it
  has no address (`connectionLabel`); one token used by any of them is not
  a copy.
- **The address is the only field a token holder cannot choose.** The
  User-Agent and the label are both free text from whoever holds the
  token. So the app never uses the label as a row's title — a row with a
  narrative is "Agent <nid>", and a device whose User-Agent does not parse
  is named by its address ("Device at 100.x.y.z"), label quoted beneath —
  and nothing branches on the parsed name (`src/user-agent.ts`), which is
  only for a person telling rows apart. A name from `tailscale whois` on
  the address would be the first trustworthy one; it is not done yet,
  since it shells out to the extension that has wedged before.
- **Who added a device is recorded at mint** (`minted_by`): the token whose
  request minted it, shown as "added by Safari on iPhone" or "by this
  machine" (`brane meld`). It can't be reconstructed later, which is why it
  is written before anything uses it, and it is what the cascade below
  walks.
- **Which device started each agent** is recorded the same way
  (`narratives.launched_by`, written by spawn, run and revive), and the
  list shows each token's agents. Each agent holds a token of its own
  ([Agent tokens](#agent-tokens)), which revoking the device offers in its
  cascade. **A revoke never touches
  their sessions**: only token revocation cascades, and tmux is left alone
  (the operator's decision, claude-xk1iyc17:58).
- **`connected`** marks a token with a socket open now, since a client
  parked on one makes no requests and its `last_used_at` stands still.
- **Recording is best-effort, like `last_used_at`**: it never fails the
  request it rides on (nor a rotation's transaction), and control
  characters become spaces before anything is stored, since a newline in a
  list is a forged row.
- **An unscanned QR is listed**, as `unused` with its `expires_at`, until it
  lapses: a code still on someone's screen is a live credential. Once
  lapsed it is left out even before the sweep revokes it.

`POST /api/tokens/:id/revoke` is bodiless, so the app sends it without a
preflight, and stamps `revoked_at` (rows are never deleted). **Every socket
the revoked token opened closes with 4401**: control and terminal sockets,
and MCP sockets too when the token is a device token
(`closesOnRevoke`, `src/daemon/token-routes.ts`). The MCP one is the one
that matters: a device token can open `/ws/mcp`, which reaches every MCP
tool, and the first version of this list left it open, so a revoked token
kept narrating and reviving for as long as it stayed connected. The same
set is what a rotation closes. Local MCP bridges stay exempt; this account
is not what either retires.

It refuses three things, each naming what the caller probably meant: the
**local** row (400; it is this machine's account, which holds no token to
revoke), the **requester's own** token (409; "Sign
out other devices" keeps this one and signs out the rest), and an id that
is **not live** (404, which the app treats as done).

**A revoke can take the devices it added** (`?also=a,b`, in the query
string so the request stays bodiless; `brane token revoke --cascade`). The
first thing a stolen token's holder does is mint a spare, and a spare's
first sighting is the thief, so its row looks clean: without the cascade,
revoking the stolen row leaves them in. The app's confirm step lists every
device the one being revoked added, down the chain, each **checked by
default**, so the honest cost — you melded your laptop from the phone you
lost — is one visible untick, and the dishonest one is not silent.
`DbTokenStore.descendants` computes the set, walking through links that
are already revoked; the route revokes only ids in it, in one write, and
refuses the request otherwise. It never includes the requester or anything
the requester added by a path that doesn't run through the device being
revoked. Through the root matters: the requester is often an *ancestor* (this
machine's `brane meld` added the phone), and revoking the phone from here
must still take the laptop the phone added. The first version excluded the
requester's whole subtree and so found nothing in exactly that case; the
sandbox run caught it, and a test pins it. Once passkeys gate minting, a
stolen token can't mint spares at all, and the default may flip to
unchecked.

**Revoking a device abandons any rotation it had begun.** A pending
rotation is held in memory against its requester's row. Left alone, the
revoked device could confirm it afterwards: the confirm writes a fresh row
of the requester's kind and revokes every other device, so the device you
just signed out would be back in and everyone else would be out.
`TokenRing.abandonRotationBy` drops it.

**Who may revoke.** Any live token can revoke any other device, which is no
more than "Sign out other devices" already lets it do. Whether a passkey
should guard revoking, as it will guard adding a device, is open: see
[Passkeys](passkeys.md), open question 1.

**Known gaps, outside the token layer:**

- A revoke does not cut a streaming response already in flight (the Files
  search and `POST /api/absorb`, both NDJSON). Each is bounded work, not a
  listener, and ends on its own.
- The WebSocket origin check compares only the port for same-origin and
  accepts any `*.ts.net` host. Nothing rides on it today, since every
  request must present a token; a passkey verifier will need its own exact
  origin list.
- Fold registration treats a loopback peer as the operator's shell, so a
  forwarder to 127.0.0.1 (`tailscale serve`, an SSH tunnel) would make a
  remote caller look local.
