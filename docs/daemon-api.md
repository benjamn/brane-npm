# Daemon

The daemon serves HTTP API + WebSocket endpoints + the Expo web app as static files.

```bash
node dist/cli.js daemon start        # Background (detached)
node dist/cli.js daemon start --foreground
node dist/cli.js daemon restart      # Preserves port across restarts
node dist/cli.js daemon status       # Shows pid, port, and the socket this machine's CLI uses
node dist/cli.js daemon logs -f      # Tail logs
```

## HTTP API Endpoints

All endpoints require `Authorization: Bearer <token>` (or `?token=`), except
a request over `daemon.sock`, which presents none and acts as this account.

**Agent tokens reach less.** A request made with an agent's token is refused
(403) unless its route is listed in `AGENT_ROUTES`
(`src/daemon/agent-scope.ts`), and unless it comes over `daemon.sock` or
loopback; WebSocket upgrades too. A new route is therefore closed to agents
until someone lists it. An agent also may not revive or prompt a
`utility` session (`POST /api/run`). See [Agent tokens](token-rotation.md#agent-tokens).

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/status` | Daemon status (brane_id, hostname, username, pid, port, uptime_ms, `tls: { state, expires_at, ... }`, `app_domain`: the shared app's host, where a daemon's own bundle hops out to on Isolate — see [View URLs](view-urls.md)) |
| `GET` | `/api/narratives?archived=1` | List narratives (excludes archived by default) |
| `GET` | `/api/narratives/recent?since=&search=&status=&fold=&limit=&archived=1&brane_ids=` | Recently active narratives — the browse half of the `narrative_info` MCP tool; every brane unless `brane_ids` scopes it |
| `PATCH` | `/api/narratives/:id/archive` | Archive/unarchive a narrative; archiving a running one is a 409 (`src/daemon/archive-gate.ts`) |
| `GET` | `/api/narratives/:id/events?after=N&before=S&tail=T` | Fetch events with cursor-based query |
| `POST` | `/api/narratives/:id/signal` | Send operator signal (supports payloads). `source` is stamped from the token (`web` for a device, `local` for this account); a `source` in the body is ignored, and an agent's token is refused (`src/daemon/signal-source.ts`) |
| `GET` | `/api/narratives/:id/export?format=html[&palette=N][&seqs=A,B,C][&seqs_mode=except]` | Conversation as a standalone HTML document; `palette` is the device's 🎨 Recolor salt, so foreign speakers wear the hues the operator sees, `seqs` is the chat's message selection, and `seqs_mode=except` exports its complement — see [Export Scope](export-scope.md) |
| `GET` | `/api/payloads/:nid/:filename` | Serve stored payload files (immutable, cached) |
| `GET` | `/api/branes` | List branes with narrative counts, home flag, and `cost: [{ unit, amount, metered }]` — per-unit running totals over every narrative, archived included |
| `GET` | `/api/folds?archived=1` | List registered fold directories (includes brane_id; archived hidden unless asked) |
| `POST` | `/api/folds` | Register a fold (`{ path, brane_id? }`) — idempotent; see [Folds API](#folds-api) for who may register what |
| `PATCH` | `/api/folds/archive` | Soft-hide/unhide a fold (`{ path, archived }`) — never deletes the row |
| `POST` | `/api/spawn` | Spawn agent (`{ agent, fold_path, role?, model?, re?, extra_args?, terminal_size? }`) — used by both the web app and `brane spawn` |
| `GET` | `/api/spawn-history` | Recent distinct `launch_args`, most-recent first (spawn dialog quick-fill) |
| `POST` | `/api/run` | Run non-agent command (`{ command, fold_path, terminal_size? }`) |
| `GET` | `/api/run-history` | Commands utility sessions have run before (by basename), most-recent first — the spawn dialog's Utility list; derived from `narratives`, nothing stored |
| `POST` | `/api/revive/:nid` | Revive a dead agent session (`{ prompt?, no_prompt?, agent? }`) — see [Revive API](#revive-api) |
| `POST` | `/api/search` | Semantic search over narrative history (`{ query, limit?, brane_ids? }`) |
| `POST` | `/api/cost/backfill` | Sweep the usage ledger over every narrative with a bound session (`{ dry_run? }`) — see [Cost Ledger](cost-ledger.md) |
| `POST` | `/api/cost/reprice` | Re-price recorded ledger rows under the current price table and move each card total by the correction (`{ dry_run? }`) — see [Re-pricing](cost-ledger.md#re-pricing) |
| `POST` | `/api/tokens` | Mint a device token (`{ label? }` → `{ token, id, label }`); only its hash is kept, so this response is the one copy. `brane meld` calls it for every QR — see [Token Rotation](token-rotation.md). From the shell it waits for the [presence check](presence.md#the-gate) (403, 409 or 429 when refused); an agent's token gets 403 unasked |
| `POST` | `/api/tokens/remote` | A device token for a daemon on another machine, and its hash (`{ token, hash }`), for `brane meld --remote`; nothing is stored, so this response is the one copy of either. Gated like `POST /api/tokens`: the shell waits for the [presence check](presence.md#the-gate), an agent's token gets 403 unasked |
| `GET` | `/api/tokens` | The Devices list: every live token (`{ tokens }`), each with `device` ("Safari on iPhone", from the User-Agent it was first presented with), `remote_addr`, the latest sighting and `elsewhere_at` (presented from a second address), `minted_by_device`, `last_used_at`, `current` (the requester), `connected`, and `unused` / `expires_at` for a QR nobody has scanned — see [Token Rotation](token-rotation.md#the-devices-list) |
| `POST` | `/api/tokens/:id/revoke` | Revoke one device token, bodiless, plus `?also=a,b` from the devices it added (each row's `descendants`); every socket it opened (control, terminal, MCP) closes with 4401. Refuses this machine's own `local` row (400), the requester's own (409), and an id that is not live (404), all before any prompt. Signing out a device waits for the [presence check](presence.md#the-gate) from the shell and is refused (403) to an agent's token; revoking an agent does neither |
| `POST` | `/api/token/rotate` | From a device: mint a pending replacement token, returned as `{ token, expires_at, replaced }`; the old one is retired on the new one's first use — see [Token Rotation](token-rotation.md). From this machine's shell (no token, over `daemon.sock`): wait for the [presence check](presence.md#the-gate), then sign out every device in this one request, answering `{ signed_out, replaced }`. An agent's token gets 403 |
| — | `BRANE_DEVICE_TOKEN_SHA256` | Not a route: comma-separated SHA-256 hashes in the daemon's environment, each adopted at startup as a device row unless ever seen before, then dropped from the environment. How `brane meld --remote` hands a remote daemon (a Fly machine, say) a token minted elsewhere — see [Presence Check](presence.md#the-gate) |
| `POST` | `/api/presence/cancel` | Close the presence prompt that is up (`?id=` from the control socket's `presence` message, so a stale tap closes nothing) → `{ canceled }`. Device tokens only (403 otherwise); there is no approve |
| `GET` | `/api/absorb/survey` | Every session store brane can look for under the daemon's HOME, with per-session `new / changed / unchanged / managed` counts for the readable ones and a found-flag for the rest; reads no content — see [Absorb](absorb.md) |
| `POST` | `/api/absorb` | Import conversation history (`{ provider, path?, fold?, identity?, brane?, dry_run?, since?, session?, rebuild? }`); answers as an NDJSON progress stream — see [Absorb](absorb.md) |
| `POST` | `/api/memory/index` | Run a memory indexing pass (`{ rebuild? }`), queued behind the daemon's own background pass; returns `IndexStats` |
| `GET` | `/api/files?nid=<nid>&path=<rel>[&raw=1][&offset=N]` | Browse a narrative's fold, archives included — see [Files API](files-view.md#files-api) and [Files View Formats](files-view.md#files-view-formats) |
| `GET` | `/api/files/list?nid=<nid>` | Flat list of every file path under the fold (for fuzzy find) |
| `GET` | `/api/files/find?nid=<nid>&path=<rel>&q=<query>[&from=N]` | Search a file's bytes for the hex view's 🔎, as an NDJSON stream — see [Searching the bytes](files-view.md#searching-the-bytes) |
| `POST` | `/api/highlight` | Shiki-highlight a snippet (`{ content, lang }`) — used by chat code blocks |
| `POST` | `/api/diagram` | Render a ```mermaid fence to static SVG (`{ source }`) — `{ diagram: null }` means "not a diagram brane draws" and is a normal answer |
| `POST` | `/api/wiki/search` | Semantic search over wiki pages (`{ query, limit?, brane_ids? }`) — see [Wiki: Local and Shared](wiki.md) |
| `GET` | `/api/wiki/read?slug=&source=&anchor=&window=` | Read a wiki page or one section with heading neighbors |
| `GET` | `/api/wiki/asset?source=&path=` | Serve a binary asset from a wiki source dir (traversal-confined) |

## WebSocket Endpoints

| Path | Purpose |
|------|---------|
| `WS /ws/control` | Real-time control channel (event hints, signals, status/meta broadcasts) |
| `WS /ws/terminal/:nid` | tmux terminal mirroring (capture-pane at 10fps) |
| `WS /ws/mcp?nid=<id>` | MCP tool bridge (daemon owns all tool logic) |

Control WebSocket broadcasts (server → client):
- `state` — initial state with all narratives
- `new_events` — event count hints for a narrative
- `status` — narrative status changes (active, ended, mcp_connected, mcp_disconnected)
- `awaiting` — `{ narrative, awaiting }`: the agent parked in a blocking `listen` or a `narrate({ wait: true })`, or stopped waiting (`src/daemon/awaiting.ts`). The app shows it as an inset glow on the list card, switcher row and header (`awaitingGlow`, `src/shared/narrative-status.ts`), in a hue this device allocates: chosen once, as far as possible from the other recently glowing narratives' hues, then kept so sessions can be learned by color; 🎨 Recolor moves it to a random hue at least 100° away, so a press changes the color family rather than shading it, and at least 60° from the hues it was recolored away from in the last hour, so repeated presses explore rather than toggle. It stays clear of the other sessions' hues where the wheel allows; when crowded, that clearance gives way before the step or the return does (`src/shared/glow-hues.ts`, `localStorage` only). Its own message type, not a `status`, so an older app ignores it
- `meta` — narrative metadata updates (summary, title)
- `heartbeat` — 30-second keepalive

Control WebSocket commands (client → server):
- `signal` — send signal to a narrative (with payload support); stamped and refused as `POST /api/narratives/:id/signal` is, with a refusal answered by a `signal_refused` frame
- `subscribe` / `unsubscribe` — narrative event subscriptions

## Spawn API

`POST /api/spawn` accepts `{ agent, fold_path, role?, model?, re?, extra_args?, terminal_size? }` and returns the new narrative object with `mcp_connected` status. `terminal_size` (`{ cols, rows }`) is the grid the requesting viewer's terminal pane last measured; the session starts at it rather than at the last size applied to any session, so its first screen is not redrawn through a resize — see [Launch residue in scrollback](terminal-mirroring.md#launch-residue-in-scrollback). `/api/run` takes it too. The fold picker modal lets the operator choose which registered fold to spawn into. The dialog's Agent list is the built-in adapters plus an "Other…" entry that takes any agent name, as `brane spawn <agent>` does: the daemon accepts any `[A-Za-z0-9_-]+` name it can find with `which`, and an agent without an adapter gets tmux, MCP config and mirroring but no session resumption. What is typed there splits like the args box, so the first word is the agent and the rest lead its `extra_args`.

This is the **only** spawn path. The web UI calls it, and so does `brane spawn` — the CLI resolves a daemon (starting one if needed), POSTs here with `fold_path` set from `cwd` and `-- <args>` as `extra_args`, and then does only terminal-shaped work with the response: `--meld`'s QR code and `--attach`. It does not open the database or create tmux sessions itself, so tmux bootstrap (`ensureTmux`), terminal sizing, and MCP config writing happen once, daemon-side, identically for both callers. Two consequences follow from that and are intended: the agent binary is resolved against the *daemon's* `PATH`, and MCP config files point at the checkout the *daemon* runs from — not the CLI you invoked.

`src/daemon/client.ts` is the CLI-side counterpart to `daemon/server.ts`: `resolveDaemonEndpoint()` (find-or-start, and pick a locally reachable origin — under TLS that means the HTTP fallback port, since the Tailscale cert is never valid for `127.0.0.1`) plus `daemonRequest()` (bearer auth, JSON, rethrows the daemon's own `error` string).

## Revive API

`POST /api/revive/:nid` accepts `{ prompt?, no_prompt?, agent? }` and returns `{ status, nid, agent }`. It is the **only** revive path — the web app's revive menu item, the `revive` MCP tool, and `brane revive` are all clients of it, in the same shape as the Spawn API above. The CLI resolves a daemon, POSTs, and prints; it does not open the database, resolve adapters, or create tmux sessions.

`status` is the outcome, and clients must not assume `nid` is the one they asked for:

| `status` | Meaning |
|---|---|
| `revived` | The session was dead and has been restarted in place, resuming its agent session (Claude forks with `--fork-session` when the original is still live). |
| `already_running` | tmux still had the session. A `prompt` is delivered if given; a stale `ended` row is self-healed to `active` and broadcast. |
| `continued` | The narrative can't be resumed in place — it was absorbed, or `agent` names a different agent — so a **twin** was spawned that reads its history. `nid` is the twin's, not the requested one. |

## The CLI is a daemon client

Spawn and revive set the pattern; the rest of the CLI follows it. A command
that touches narratives, folds, sessions, or the memory index does so by
calling the daemon, and keeps only terminal-shaped work for itself — resolving
the operator's relative paths against *this* shell's cwd, printing, attaching
to tmux. The reasons are the ones the Spawn API section gives, and one more
that absorb makes concrete: every path the pipeline resolves — payloads, the
organelle `search.db`, the niche registry — resolves against **the daemon's
HOME**, and two processes indexing the same cursors (the daemon's background
pass and an in-process `brane memory index`) was a race nobody had to have.

| Command | Calls |
|---|---|
| `spawn`, `revive` | `POST /api/spawn`, `/api/revive/:nid` |
| `list` | `GET /api/narratives`, `GET /api/branes` |
| `fold` | `POST /api/folds`, `GET /api/folds?archived=1` |
| `absorb` | `GET /api/absorb/survey`, `POST /api/absorb` — an NDJSON stream, read with `daemonStream()` |
| `memory log` / `search` / `index` | `GET /api/narratives/recent`, `POST /api/search`, `POST /api/memory/index` |
| `cost backfill` / `reprice` | `POST /api/cost/backfill`, `POST /api/cost/reprice` |
| `token list` | `GET /api/tokens` |
| `token revoke <id>` | `POST /api/tokens/:id/revoke` |
| `token rotate` | `POST /api/token/rotate` (one request: the shell holds no token to swap) |

**How it gets there: `daemon.sock` first.** The daemon also listens on a
Unix socket beside the database (`~/.brane/daemon.sock`, recorded as
`meta.daemon_socket`; `src/daemon/local-socket.ts`), with the same request
and upgrade handlers. `daemonRequest()` and `daemonStream()` send over it
when it is there. Inside an agent session, which has a token to present,
they fall back to TCP at `buildDaemonBaseUrl()` when the socket
cannot be connected to — any failure before it connects, so nothing was
sent; a failure after that is reported, never retried, so a POST cannot run
twice. Outside one there is nothing to present over TCP, so there is no
fallback: the socket is the only way in, and the error says so. `brane mcp` dials `ws://localhost/ws/mcp` with `createConnection` to
the socket (`mcpDialTarget()`), keeping the path out of the URL, and uses
TCP whenever the socket does not answer a probe at (re)connect. Reaching the socket takes search permission on the
0700 `~/.brane`, so the kernel admits only this Unix account (and root),
which loopback TCP cannot promise. So a request over it that presents **no
token** acts as this account: the live `local` row ("this machine"), with
the same last-seen bookkeeping a presented token gets
(`authenticateRequest()` in `server.ts`, `TokenStore.account()`). That holds
only while `~/.brane` is owned by the daemon's uid with no group or other
bits (`accountDirTrust()`), checked on every such request, since both
chmods that set it up swallow their errors; otherwise the request is
refused and the daemon logs why, once per reason until one is let in again.
A tokenless request with an `Origin` header, or a `Host` other than
`localhost`, is refused too: the CLI and bridge send neither, and that is
the shape of a browser's request arriving through a relay to the socket.
An empty token counts as none. No token over TCP, even
loopback, is refused as before. A client sends a token only inside an
agent session (`resolveCredential()`); everything else on this machine sends
none, over the socket, and never falls back to TCP, where it would only be
a 401. No client reads `.daemon_token`, which older branes kept a local
token in — see [No local token](token-rotation.md#no-local-token).
A crashed daemon leaves its socket file behind; the next one, once
it holds the claim, removes it only if it is a socket whose connect is
refused (`ECONNREFUSED`), and otherwise leaves the path alone; until it is
cleared, agents and devices are served over TCP and this machine's shell,
which holds no token, cannot reach the daemon (`brane doctor` says why).

What stays local is what must: `daemon` *is* the daemon; `mcp` is the bridge
into it; `config` is how `token` and `default.brane` are set before a daemon
exists (and the daemon itself reads them through `getConfig`); `certify`
writes the cert files the daemon hot-reloads; `doctor` is a diagnostic and
must not depend on the thing it diagnoses; `attach` is tmux; `meld` already
finds-or-starts the daemon and reads two `meta` rows to build a URL.

Every client calls `warnIfVersionMismatch()` first, because a request field
this CLI knows about is silently ignored by an older daemon. A new
source-reading habit to resist: a command that wants a new fact should get it
from a route (adding one if needed), not from `openDatabase()` — the moment a
command opens the database it has a second implementation to keep in step.

## Run API

`POST /api/run` accepts `{ command, fold_path }` where `command` is an array of strings. Creates a tracked tmux session for non-agent processes (lazygit, htop, etc.) with terminal mirroring but no MCP, LIVE loop, or agent adapter. The narrative gets `role: "utility"` and `agent_type` set to the command basename. The spawn dialog reaches it through its **Utility** side (the label opposite **Agent**), whose list is `GET /api/run-history` plus an "Other…" entry for a command never run before. The dialog is its only client: the `brane run` CLI command was retired (2026-10-10). A utility session's environment carries no agent token, so it is this account's standing in one call, and the route is closed to agents (`src/daemon/agent-scope.ts`); the CLI command added nothing the dialog lacks (same route, same env scrubbing, no env passthrough from the calling shell), and keeping it kept a `brane` verb in every agent's shell whose only job was to start such a session. `brane attach <nid>` attaches to one the app started.

## Folds API

`GET /api/folds` returns registered fold directories sorted by `created_at` descending, archived ones only with `?archived=1`. Used by the Expo app to populate the spawn fold picker.

`POST /api/folds` with `{ path, brane_id? }` registers one — the app's "add a spawn point" affordance and `brane fold` are both clients — and returns `{ fold, created }`. It is idempotent: re-registering un-archives the row and, with `brane_id`, rebinds it (`brane fold --brane`, and absorb tagging a fold with the brane it imports into). The implementation is `registerFold` in `src/folds.ts`, shared with absorb.

**Who may register what.** A phone on the tailnet must not be able to make `/` or `/etc` a spawn point, so a remote client's folds are confined to the operator's home directory (403 outside it, and for `$HOME` itself). The operator's own shell has never been so limited — `brane fold /Volumes/scratch/project` has always worked — and now that the CLI reaches this through the daemon, that reach is recognized on the wire as **loopback**: `isLoopbackRequest()` in `src/daemon/server.ts` grants it to a connection on `daemon.sock` and to `127.0.0.0/8` and `::1`, which is what the CLI dials (`daemon.sock`, else `buildDaemonBaseUrl`) and what nothing off this machine can. The one gap is the TLS window where the fallback port isn't recorded yet and the CLI dials the Tailscale hostname; it lasts about a second after daemon start and the request is then simply confined. `foldPathRefusal()` is the pure decision, pinned by `src/test/thin-cli.test.ts`. Read the rule as a guard against **mistakes**, not a security boundary: the token already grants keyboard input to every tmux session, so a holder who wanted `/etc` could have it; what the rule prevents is a phone's file picker or a typo quietly making the wrong directory a spawn point. That is also why `POST /api/absorb` confines the *fold* it registers but not the export *path* it reads.
