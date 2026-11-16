# Brane — Agent Development Guide

This file is loaded into every agent session in this fold, so it stays an
**index**: the rules that apply to every change, how to build, and a map of
where everything else is written down. The design write-ups for each
subsystem live in [`docs/`](docs/); read the one for the area you are about
to touch (see [Further Reading](#further-reading)) before changing it.

**Keep it that way.** A new subsystem's design notes go in a new or existing
`docs/<topic>.md`, and this file gets one line in [Further
Reading](#further-reading) pointing at it. A rule belongs here only if it
applies to changes everywhere in the repo.

## What Is This?

Brane is a TypeScript reimagining of the [organelle](https://github.com/benjamn/organelle) system. It provides:

- A CLI (`npx brane` or `node dist/cli.js`) built with **citty**
- A background **daemon** (HTTP + WebSocket) with SQLite persistence
- An **Expo web app** for mobile control over Tailscale
- An **MCP server** (stdio↔WebSocket bridge) injected into agent sessions
- **Terminal mirroring** of tmux sessions with keyboard input
- The **LIVE loop** protocol for cursor-based agent communication
- A **semantic memory** system with embeddings and full-text search
- **Multi-agent support** across 8 agent types, with session resumption where the agent offers it

## Golden Rule

**Never delete files, directories, database records, git branches, or any other artifacts without explicit operator approval.** If your task seems to require deletion, stop and ask the operator first. Prefer renaming, archiving, or commenting out over deletion. The cost of keeping something is low; the cost of losing it can be catastrophic.

## Commits, Sign-off, and Accountability

`CONTRIBUTING.md` is the policy; this is what it asks of an agent.

- **Never add `Signed-off-by:`**, on your own behalf or the operator's. Only a human can certify the Developer Certificate of Origin, and a sign-off written by an agent is a false certification. Responsibility for a change attaches to the human who submits or merges it.
- **Keep the disclosure trailer.** Commits you write carry `Co-Authored-By: <agent> <model> <noreply@anthropic.com>` (Claude Code adds it). Never strip, rewrite, or backdate one, yours or another agent's.
- **Never merge, and never approve a PR.** `main` is PR-only; open the PR, report CI, and stop. The human who merges is the one taking responsibility for the change.
- **Never run `npm publish`, `npm stage approve`, or `scripts/mirror-release.mjs --push`, and never approve a deployment** — see [Releasing](docs/releasing.md).

## Repository Layout

```
brane/
├── src/
│   ├── cli.ts                 # CLI entry (citty)
│   ├── agents.ts              # Agent adapter interface (claude, goose, gemini, codex, amp, copilot)
│   ├── commands/              # Subcommands (see CLI Commands below)
│   ├── daemon/server.ts       # HTTP/WS server, terminal streaming, MCP bridge
│   ├── daemon/client.ts       # CLI-side daemon client (find-or-start, JSON API calls)
│   ├── db/schema.ts           # SQLite schema, helpers (better-sqlite3)
│   ├── db/events.ts           # Event append-log operations
│   ├── memory/                # Semantic search system
│   │   ├── embeddings.ts      # Worker-thread façade over the embedder
│   │   ├── embedder.ts        # ONNX session + mean pool + normalize (onnxruntime-node)
│   │   ├── wordpiece.ts       # BERT WordPiece tokenizer, parity-pinned to transformers.js
│   │   ├── index.ts           # Search orchestration (hybrid vector + FTS5)
│   │   └── storage.ts         # Chunk storage and indexing state
│   ├── files/                 # GET /api/files: browse.ts (the route), zip.ts, tar.ts, archive.ts, bytes.ts
│   ├── markdown-diagnostics.ts # Rendering warnings returned by narrate
│   ├── mcp/server.ts          # Thin stdio↔WebSocket MCP bridge
│   └── test/                  # Node test suite
├── expo/                      # React Native web app
│   ├── app/[nid].tsx          # Narrative detail (chat + terminal tabs)
│   ├── app/_layout.tsx        # Root layout, WebSocket control channel
│   ├── app/index.tsx          # Narrative list
│   ├── components/            # MacroMenu, TerminalPane, TerminalKeyboard
│   ├── lib/                   # api.ts, terminal.ts, connection.ts, registry.ts
│   └── dist/                  # Built web bundle (served by daemon)
├── worker/                    # Cloudflare Workers deployment (serves the latest release's expo/dist as SPA)
├── protocols/
│   ├── LIVE_loop.md           # Core agent communication protocol
│   ├── digest.md              # /digest protocol for activity summaries
│   └── memory.md              # Semantic search protocol
├── docs/                      # Per-subsystem design notes (see Further Reading)
├── dist/                      # Compiled TypeScript output
├── SECURITY.md                # Security model documentation
├── DESIGN.md                  # Architecture documentation
├── tsconfig.json              # ES2022, NodeNext, strict
└── package.json               # Node 20+, ESM
```

## Building

```bash
# Compile TypeScript (server + CLI)
npx tsc

# Build Expo web bundle
cd expo && npx expo export --platform web

# Run tests
npx tsc && node --test dist/test/*.test.js
```

Output goes to `dist/` (server) and `expo/dist/` (web app).

`build` and `build:server` sweep `dist/` first (`scripts/clean-dist.mjs`, via
`prebuild` hooks): `tsc` only ever adds files, so without the sweep a checkout
accumulates outputs whose source is gone and `npm pack` ships them. Because
the sweep makes tsc create `dist/cli.js` fresh (mode 0644), `postbuild` hooks
run `scripts/chmod-bin.mjs` to put the execute bit back on every `bin` target;
without it an `npm link`ed `brane` vanishes from the shell (`which` skips
non-executable files) while `node dist/cli.js` keeps working.

### When to rebuild

- **Server-side TypeScript changes** (`src/`): `npx tsc` then `brane daemon restart`
- **Expo app changes** (`expo/`): **`npm run build`** (not just `npx tsc`) then `brane daemon restart`
- **Protocol/markdown changes** (`protocols/`): **No rebuild needed.** The daemon reads protocol files from disk at runtime via `readFileSync`.
- **Both server + expo**: `npm run build` (runs tsc + expo export)

### Releasing

Publishing to npm starts in `.github/workflows/release.yml` in
`benjamn/brane-npm`, triggered by `scripts/mirror-release.mjs --push`
carrying a new version there, and only by it. The workflow only *stages* the
version; the operator publishes it by approving it on npmjs.com, with 2FA, and
approves the app deploy (`brane-npm`'s `app` environment). **Agents never run
`npm publish`, `npm stage approve` or `mirror-release.mjs --push`, and never
approve a deployment.**
The shared web app ships with it: a release deploys its tarball's
`expo/dist`, and a merge to `main` deploys nothing (staging is Isolate on a
daemon running `main`). What `brane-npm` holds, the version bump, dist-tag choice, app
deploy and rollback, and why no release so far has a provenance
attestation are in [docs/releasing.md](docs/releasing.md).

## CLI Commands

| Command | Purpose |
|---------|---------|
| `daemon` | Manage daemon lifecycle (start, stop, restart, status, logs) |
| `spawn` | Spawn new agent sessions (`--attach`, `--model`, `--role`, `-- <args>`) |
| `attach` | Attach to a tmux session |
| `list` | List narratives grouped by brane (`--brane`, `--archived`, `--limit`) — reads `GET /api/narratives` + `GET /api/branes` |
| `fold` | Register directories as spawn points (`--brane` to associate with a brane) — delegates to `POST /api/folds` |
| `meld` | Generate QR code for mobile access (points at the `app_domain` config, `brane.organelle.dev` unless set; `--app <host>` for one QR, `--local` for a direct daemon URL); waits for Touch ID at this machine — see [Presence Check](docs/presence.md#the-gate). `--remote --send … --ask …` melds a daemon on another machine (a Fly machine: /fly) with a token minted here, and refuses in an agent's session |
| `mcp` | MCP stdio server (used internally by agent sessions) |
| `revive` | Restart dead agent sessions (`--prompt`, `--no-prompt`, `--agent`) — delegates to `POST /api/revive/:nid` |
| `config` | Get/set brane configuration (git-config style: `--list`, `--unset`) |
| `certify` | Force-refresh TLS certificates (daemon auto-provisions and renews on its own; this is a manual escape hatch) |
| `absorb` | Import conversation history: from provider exports (`chatgpt`, `organelle`) or from agent session stores on this machine (`claude`); `survey` lists what the machine has (`--fold`, `--brane`, `--identity`, `--dry-run`, `--since`, `--session`, `--rebuild`) — delegates to `GET /api/absorb/survey` and `POST /api/absorb`, printing its progress stream |
| `memory` | Semantic search and indexing (`search`, `log`, `index` subcommands) — clients of `POST /api/search`, `GET /api/narratives/recent`, `POST /api/memory/index`. `log --archived` to include absorbed history, which is archived by construction |
| `cost` | Cost ledger maintenance (`backfill [--dry-run] [--all]`, `reprice [--dry-run] [--all]`) — delegates to `POST /api/cost/backfill` and `POST /api/cost/reprice` |
| `token` | Daemon bearer tokens (`list`: the Devices list; `revoke <id> [--cascade]`: sign out one device, and with `--cascade` the devices it added; `rotate`: sign out every web client, keep this shell; revoking a device and rotating wait for Touch ID, see [Presence Check](docs/presence.md#the-gate)) — delegates to `GET /api/tokens`, `POST /api/tokens/:id/revoke` and `POST /api/token/rotate`; from the shell, which holds no token, rotate is one request — see [Token Rotation](docs/token-rotation.md) |
| `doctor` | Check the install: Node vs `engines`, `tmux`, Tailscale, daemon status, which checkout it runs from and whether this shell can reach it over `daemon.sock`, a leftover `.daemon_token`, then the shipped test suite (`dist/test`) against this install — see [Doctor](docs/doctor.md) |

## Database

Single SQLite database at `~/.brane/brane.db` (WAL mode). Key tables:

| Table | Purpose |
|-------|---------|
| `meta` | Instance ID, daemon port/pid/version/tls/http_port/socket, config |
| `tokens` | Daemon bearer tokens as SHA-256 hashes only (`local`: one row for this machine's CLI, which no token opens; `device` per meld, `agent` per narrative session, handed to it as `BRANE_NARRATIVE_SECRET`), revoked never deleted — see [Token Rotation](docs/token-rotation.md) |
| `folds` | Registered spawn directories (path, brane_id, created_at) |
| `branes` | Archived branes (brane_id, archived, archived_at), written lazily, never deleted — see [Multi-Brane](docs/multi-brane.md#archived-branes) |
| `narratives` | Agent sessions (id, brane_id, agent_type, role, status, fold_path, title, summary, archived, agent_session_id) |
| `events` | Append-only event log: (narrative_id, seq, time, type, content, content_type, source, re, payloads, meta) |
| `memory_chunks` | Event chunks for embeddings |
| `memory_vec` | Vector embeddings for semantic search (sqlite-vec) |
| `memory_fts` | FTS5 full-text search table |
| `memory_cursors` | Per-narrative indexing cursors |
| `memory_stats` | Indexing statistics |
| `usage_ledger` | Durable per-message / per-session cost rows — see [Cost Ledger](docs/cost-ledger.md) |
| `absorb_messages` | (brane, provider, message id) → (narrative, seq): the per-message dedup that makes re-absorbing a session store idempotent — see [Absorb](docs/absorb.md) |
| `absorb_files` | (brane, provider, session) → (size, mtime) at its last absorb, so an unchanged file is skipped on a stat |
| `credentials` | The operator's enrolled passkeys and security keys, public keys only, revoked never deleted: any live one satisfies the verification gate — see [Operator Verification](docs/passkeys.md) |

Event types: `narration` (agent), `human_signal` (operator), `agent_signal` (cross-agent).

## Agent Adapters

Brane supports multiple agent types with session resumption. Each agent has an adapter in `src/agents.ts`:

| Agent | Resume Method | Notes |
|-------|--------------|-------|
| `claude` | `--resume <session_id>` | Discovers session from `~/.claude/projects/` |
| `goose` | `-r` | Resumes by session name |
| `gemini` | (none) | Uses `-i` for prompt injection |
| `codex` | `resume <session_id>` | Subcommand-based resumption; spawn and revive share `codexLaunchArgs()`, which passes `--no-daemon` so `brane mcp` inherits the pane's credentials, not those of Codex's shared daemon |
| `amp` | (none) | Uses thread references `@T-<id>` in prompt |
| `copilot` | `--session-id <session_id>` | Daemon-pinned UUID resumes the exact local session |
| `cline` | (none) | Each revive starts a fresh session; brane captures its id for cost |
| `crush` | (none) | Each revive starts a fresh session; brane captures its id for cost |

Spawning a session generates agent-specific MCP config. This happens in `doSpawn()`, which always runs in the daemon — `brane spawn` gets it by delegating to `POST /api/spawn`, not by writing these files itself:
- **Claude**: `.mcp.json` in fold directory
- **Goose**: `--with-extension` argument with env passthrough
- **Gemini**: `.gemini/settings.json` project-level config
- **Codex**: `~/.codex/config.toml` with env references
- **Copilot**: Per-session `.brane-copilot-mcp-<nid>.json`

## Security Model

See `SECURITY.md` for full details. Key features:

- **TCP-level IP filtering** — only allows localhost, Tailscale IPs, RFC 1918 private ranges, and CGNAT
- **TLS auto-provisioning + renewal** — daemon shells out to `tailscale cert` at startup if no valid cert exists, renews when <30d remain, hot-reloads via `setSecureContext` on file change; when TLS is active, an HTTP fallback server (private IPs only) runs on a separate port for local/LAN access. `brane certify` remains as a manual escape hatch.
- **Atomic daemon startup** — `BEGIN EXCLUSIVE` SQLite transaction prevents race conditions
- **Version checking** — daemon stores version for CLI compatibility detection
- **Payload security** — path traversal protection, 50MB size limits, immutable cached URLs
- **The token is the only credential** — no origin allowlist: CORS answers `*` without credentials, the WebSocket upgrade checks the token and nothing else, and the `Origin` a device runs the app from is recorded on its token for the Devices list (`SECURITY.md`, Authentication)

## Rules for Every Change

The full reasoning for each is in the linked doc; these are the parts that
bite outside their own subsystem.

- **The CLI is a daemon client.** A command that touches narratives, folds,
  sessions, or the memory index calls a daemon route (adding one if needed)
  and keeps only terminal-shaped work for itself. It never opens the database
  itself. Every client calls `warnIfVersionMismatch()` first. See [The CLI is
  a daemon client](docs/daemon-api.md#the-cli-is-a-daemon-client).
- **A new daemon route is closed to agents** until it is listed in
  `AGENT_ROUTES` (`src/daemon/agent-scope.ts`). If agents' CLI or bridge
  needs it, add it there; operator acts stay off the list. See [Agent
  tokens](docs/token-rotation.md#agent-tokens).
- **A new daemon route is an act for the verification gate** until it is
  named in `FREE_ROUTES` (`src/daemon/verification-gate.ts`), and
  `src/test/verification-gate.test.ts` fails until it is on that list or
  `ACT_ROUTES`. A read goes on the free list; an act that should be
  configurable by name goes on `ACT_ROUTES`. See [Operator
  Verification](docs/passkeys.md#what-is-an-act).
- **No test opens the operator's database.** `openDatabase()` throws under
  `node --test`; code the suite drives takes a `db`, and tests build one with
  `createTestDb()`. A test that reads *source* (not `dist/`) must `skip` when
  the source is absent, or `brane doctor` goes red on every install. See
  [Doctor](docs/doctor.md).
- **MCP tool errors use `sendToolError()`**, not `sendToolResult({ error })`;
  the bridge maps it to `isError: true`. Tool logic lives in the daemon, never
  in the bridge. See [MCP Architecture](docs/mcp.md).
- **Bodiless app requests send no headers.** The token rides in `?token=`, so
  a GET needs no CORS preflight; `src/test/api-request.test.ts` enforces it.
  Breaking this is invisible on a fast network. See [The Request
  Layer](docs/request-layer.md).
- **Every `Pressable` says what it is.** A `role` (and an `aria-label` when
  its content is a glyph), or `tabIndex={-1}` for a backdrop or card that is
  surface, not control; a `<div onClick>` needs a `role` too.
  `src/test/pressable-roles.test.ts` fails otherwise. `focusable={false}` is
  not an opt-out: RNW's Pressable sets its own tabIndex. See
  [Accessibility](docs/accessibility.md).
- **A `src/shared/` module with a bare npm import needs a metro alias** in
  `expo/metro.config.js`, as `katex` has. See [Math Rendering](docs/math.md).
- **One parse, never a second scanner.** Warnings, mentions and diagram
  diagnostics reuse the renderer's own parse; a parallel regex eventually
  disagrees with what the operator sees. Regexes on the `narrate` path must
  be linear-time. See [Rendering Warnings](docs/rendering-warnings.md),
  [Mentions](docs/mentions.md), [Diagrams](docs/diagrams.md).

- **Every conversational append goes through `announceEvent()`**, which
  records mentions and *then* wakes listeners. A new append site in
  `server.ts` that open-codes the two in the other order leaves a mention
  delivered and never settled. See [Mentions](docs/mentions.md).
- **`expo/public/index.html` is the HTML template that ships**; keep
  `expo/app/+html.tsx` in step with it, but a `<head>` change made only there
  never reaches a browser. See [Math Rendering](docs/math.md) and [Link
  Previews](docs/link-previews.md).

## Further Reading

Relative links into [`docs/`](docs/). Each is the full write-up for its area,
including the "less obvious than it looks" decisions and the tests that pin
them. The paths in parentheses are the code each one goes with: about to
change one of those, read its doc first.

**Daemon and CLI**

- [Daemon](docs/daemon-api.md) (`src/daemon/server.ts` routes,
  `src/daemon/client.ts`, `src/commands/`): every HTTP and WebSocket endpoint;
  the Spawn, Revive, Run and Folds APIs; why the CLI is a daemon client; who
  may register which folds.
- [MCP and the LIVE Loop](docs/mcp.md) (`src/mcp/`, `src/daemon/awaiting.ts`,
  MCP handlers in `server.ts`): the stdio↔WebSocket bridge, listen wakeup and
  cancellation, `narrate({ wait: true })`, the LIVE loop tools, narrative
  metadata.
- [Token Rotation](docs/token-rotation.md) (`src/daemon/token-ring.ts`,
  `src/db/tokens.ts`, `src/daemon/token-routes.ts`, `src/commands/token.ts`):
  tokens stored as hashes only, a token per melded device and per agent session, the Devices list
  and per-device revoke, `brane token rotate`, why the swap happens on first
  use of the new token, and why this machine holds no token (`.daemon_token`
  is retired).
- [Operator Verification](docs/passkeys.md) (phase 2 of 6 built, the gate,
  and phase 3's daemon half: `src/daemon/verification-gate.ts`,
  `src/daemon/verification-ceremony.ts`, `src/daemon/verify-page.ts`,
  `src/webauthn/`, `src/db/credentials.ts`, `src/db/tokens.ts`): why a
  melded device must prove the operator is holding it before it acts, the
  daemon-side gate and its free list, the proof tiers (passkeys, security
  keys, OIDC), the WebAuthn checks and Yubico's vendored roots, the
  ceremony page, the spike's real-device results, decisions, and the
  phased build order.
- [Presence Check](docs/presence.md) (`src/presence.ts`,
  `src/daemon/presence-gate.ts`): confirming the operator is at
  the machine with the OS's own prompt (macOS, Windows Hello from Windows or
  WSL, polkit); the gate it puts on meld, a device's sign-out and rotation
  from the shell, and why agents are refused them.
- [Tailscale, TLS and the Listeners](docs/tailscale.md) (`src/tailscale.ts`,
  `src/tls.ts`, `src/daemon/cert-manager.ts`,
  `src/daemon/tailscale-rebind.ts`, `buildMeldUrl` in
  `src/commands/meld.ts`): what listens and what the kernel refuses, the
  re-probe policy, certificate provisioning, renewal and hot reload, the
  HTTP fallback, why meld never advertises a LAN address, running
  Tailscale beside WARP and in containers.
- [Session Affinity](docs/session-affinity.md) (`src/session-affinity.ts`):
  the `X-Session-Affinity` header for claude sessions on Fireworks.
- [Doctor](docs/doctor.md) (`src/commands/doctor.ts`, `src/test/`): `brane
  doctor`, and the shipped-test-suite rules.
- [Releasing](docs/releasing.md) (`.github/workflows/release.yml`,
  `scripts/mirror-release.mjs`, `scripts/changelog.mjs`, `package.json`
  version): `brane-npm`, one commit per release, and the npm release workflow
  that runs there.

**Data**

- [Multi-Brane](docs/multi-brane.md) (`brane_id` resolution, `src/folds.ts`):
  home and foreign branes, brane_id resolution.
- [Absorb](docs/absorb.md) (`src/absorb/`): importing history (ChatGPT,
  organelle, local Claude Code stores), per-message idempotence, `--rebuild`.
- [Memory and Search Ranking](docs/memory-search.md) (`src/memory/`):
  embeddings, FTS5, and why hybrid search fuses ranks rather than scores.
- [Cost Ledger](docs/cost-ledger.md) (`src/cost/`, `usage_ledger`, adapters'
  usage readers): `usage_ledger`, credit assignment across forks, backfill,
  re-pricing.
- [Mentions](docs/mentions.md) (`src/mentions-scan.ts`, `src/db/mentions.ts`,
  `src/shared/markdown-mentions.ts`): `@nid` addressing, the mentions ledger,
  and the record-before-wake ordering.

**Web app**

- [Web App (Expo)](docs/web-app.md) (`expo/`): what the app offers, view by
  view.
- [Terminal Mirroring](docs/terminal-mirroring.md)
  (`expo/components/TerminalPane.tsx`, the capture loop in `server.ts`):
  capture-pane mirroring, the resync heartbeat, the stranded rAF, the cursor,
  paste and copy, block glyphs.
- [Files View](docs/files-view.md) (`src/files/`, `expo/lib/hexDoc.ts`,
  `expo/lib/hexFind.ts`): `GET /api/files`, every format the Files view shows
  (archives as folders, hex as the floor), searching the bytes.
- [The Request Layer](docs/request-layer.md) (`expo/lib/api.ts`,
  `src/shared/api-request.ts`): CORS preflights, timeouts and retries at
  satellite RTT.
- [View URLs](docs/view-urls.md) (`src/shared/view-url.ts`,
  `expo/app/_layout.tsx`): what the query string and fragment carry, Isolate
  and Meld links.
- [The Selection Store](docs/selection-store.md)
  (`src/shared/message-selection.ts`, `expo/lib/selection.ts`): the chat's
  message selection outside React state.
- [Export Scope](docs/export-scope.md) (`src/export.ts`,
  `src/shared/export-selection.ts`): exporting a selection or its complement,
  and what an excerpt discloses.
- [Link Previews](docs/link-previews.md) (`expo/public/index.html`,
  `expo/scripts/og-membrane/`): the `og:*` card and its image.
- [Accessibility](docs/accessibility.md) (`role` / `aria-*` on every
  `Pressable`, `Markdown.tsx` headings, the chat's live region,
  `src/test/pressable-roles.test.ts`): what a screen reader and a keyboard
  get, the RNW quirks (`focusable` ignored, `Image` wants `aria-label`,
  `role="button"` renders a `<button>`), what is still open.

**Markdown rendering**

- [Diagram Rendering](docs/diagrams.md) (`src/diagram/`): mermaid fences drawn
  on the daemon, the dialect census, labels, self-loops.
- [Math Rendering](docs/math.md) (`src/shared/markdown-math.ts`,
  `src/math.ts`): KaTeX in the app and the export, every delimiter a model
  writes.
- [Rendering Warnings](docs/rendering-warnings.md)
  (`src/markdown-diagnostics.ts`): what `narrate`'s `warnings` report and
  `strict: true`.
- [Wiki: Local and Shared](docs/wiki.md) (`src/memory/wiki.ts`,
  `src/shared/wiki-links.ts`): `wiki/` vs `wiki/shared/`, who sees what, the
  install fold.

Also: `DESIGN.md` (original architecture), `SECURITY.md` (security model),
`CONTRIBUTING.md` (contribution policy), and `protocols/` (agent protocols,
read at runtime).

## Key Patterns

- **Port stability**: daemon restart captures port before SIGTERM, reuses it
- **Scroll preservation**: chat/terminal tabs use absolute positioning with zIndex stacking
- **Terminal resize**: ResizeObserver measures monospace character dimensions, sends cols/rows to tmux
- **Multitouch keyboard**: refs for synchronous state, React state for visual rendering only
- **Event cursor**: monotonic `seq` per narrative, `after`/`before`/`tail` parameters on narrate/listen (supports multi-narrative object format)
- **Hashed tokens, and none for this machine**: the database holds only token hashes; devices get one minted per meld, agents one per session, and `--token` is adopted as a device token. The shell's CLI and MCP bridges hold no token: they present nothing over `daemon.sock`, the only way in for them, and nothing reads or writes `.daemon_token` — see [No local token](docs/token-rotation.md#no-local-token)
- **Atomic daemon claim**: SQLite `BEGIN EXCLUSIVE` transaction ensures singleton daemon
- **IP filtering**: TCP-level socket filtering before HTTP processing
- **Version tracking**: daemon and CLI version compatibility checks
- **Metadata broadcasts**: control WebSocket pushes summary/status changes in real-time
- **Portable paths**: stored as `~/relative` format, converted via `toPortablePath()`/`fromPortablePath()`
- **The mirror sends text; everything else is explicit**: the pane's cursor is the only thing about a terminal that isn't in its text, so it rides the same tmux round trip as the capture — and gets its own message when it moves and the text doesn't
- **The chat never scrolls itself**: after landing, only the operator moves the chat. It is a `column-reverse` scroller (`CHAT_SCROLLER_STYLE`, `expo/app/[nid].tsx`), not a virtualized `FlatList`, so scroll position is measured from the bottom: it opens on the latest message without a scroll, an arrival is followed only when the view is already exactly at the bottom, a page of older history lands at the far end and moves nothing, and no row is ever swapped for an estimated spacer mid-scroll. The one scroll the code writes is landing on `?scrollToSeq=` / `?scrollTo=`, plus the ↑/↓ tab button the operator taps. Sending doesn't scroll, and vertical scroll is never disabled, not even under a horizontal pane swipe. Measured in Chromium and WebKit against a sandbox daemon: the message under the viewport moves 0 px on arrival, on send and on each page loaded
- **A tap should cost what it changed**: the chat's selection lives in a store with per-seq subscriptions, so selecting a message wakes that bubble, the header's count and the composer — not the screen, not `renderItem`, not the other two hundred rows; the same store is what makes two taps in one frame both land
- **The URL carries the view**: anything that must survive an origin hop (Isolate) or a device hop (Meld) goes in the query string, built through `src/shared/view-url.ts` — `sessionStorage` is origin-scoped and does not travel. The app names no host: "isolated" is `location.host` equal to the connection's host, and the way out is the daemon's `app_domain` from `/api/status`; `src/test/app-host-literal.test.ts` keeps it that way
- **Back undoes a jump, never a view change**: a different narrative or any `nid:seq` link (even into the narrative you're reading) is a `router.push`; a tab, pin, file or selection change is `router.setParams`, which replaces. Screens behind the top stay mounted, so Back restores them whole, and narrative subscriptions are refcounted because two of them can watch the same narrative — see [View URLs](docs/view-urls.md)
- **`shared/` is the publication unit**: a fold's `wiki/shared/` is what other folds — and the npm tarball — can see; everything directly under `wiki/` is fold-local, and the install directory is just another fold
- **One renderer, two targets**: markdown features that must survive export (code highlighting, math) render server-side or through shared code, never through a script the exported file carries
- **Fail quietly for the reader, loudly for the writer**: renderers fall back rather than show errors; the same decisions are collected and returned to whoever wrote the markdown, as `narrate` warnings — advisory, unless that call asked for `strict`
- **Ask once, not twice**: a cross-origin request that carries no custom headers needs no CORS preflight, so bodiless API calls authenticate through `?token=` and send none — the extra round trip is invisible on a LAN and fatal at satellite RTT
- **Stale PID cleanup**: daemon info queries verify PID liveness, clean up dead entries
- **A blind start is not a verdict**: Tailscale detection at startup is one `tailscale status` with a 3 s timeout, and the extension can be wedged at exactly that moment (it hung for 11 hours on 2026-08-30 while the menu bar said "Connected"). The daemon therefore keeps re-probing — 5 s doubling to a 60 s cap while blind, 60 s steady once seen — and binds HTTPS + HTTP-fallback listeners on tailnet addresses as they appear (`src/daemon/tailscale-rebind.ts` holds the policy, `src/test/tailscale-rebind.test.ts` pins it). `GET /api/status` reports `listening_on`; empty means "this machine only". `--bind` opts out

## Important Warnings

- **Never restart the organelle Nucleus daemon** — it maintains WebSocket connections to mobile devices
- The brane daemon is separate and safe to restart
- Database has no back-compat concerns yet — schema can change freely
- `~/.brane/` directory should be portable (paths stored as ~/relative)
