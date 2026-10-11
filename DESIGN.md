# Brane Design

Brane is a TypeScript npm package providing a CLI tool (`npx brane`) and
userspace daemon for managing narrative agent sessions, with a clean
SQLite-first architecture.

"Brane" is short for membrane — the biological metaphor carries over from
organelle, enabling reuse of terms like nucleus (daemon), narrative, and
organelle (agent).

## Installation

```sh
npm i --save-dev brane
```

## CLI Subcommands

```
brane fold                        # Register cwd as a fold (spawn point)
brane fold --list                 # List all registered folds
brane daemon start|stop|status    # Manage the daemon
brane daemon restart              # Restart, preserving port
brane daemon logs [-f] [-n N]     # View daemon logs
brane spawn <agent> [-- <args>]   # Spawn agent in tmux session
  --role <role>                   #   worker | coordinator | image-analyst
  --attach                        #   Attach to session after spawning
  --model <model>                 #   Model hint (e.g., haiku, sonnet)
brane list                        # List active sessions
brane attach <id>                 # Attach to tmux session
brane revive <id>                 # Restart a dead session
brane meld                        # Show QR + tappable URL for mobile access
brane config <key> [<value>]      # Get/set configuration (git-config style)
brane memory search <query>       # Semantic search across narratives
brane memory index                # Re-index narrative content
brane mcp                         # Stdio MCP server (for agents)
```

### Folds

A "fold" is a registered directory where agents can be spawned. The term
draws from brain folds (gyri/sulci), membrane folding, and folder as
prefix. `brane fold` registers the current directory in the central
SQLite database.

### Agent flexibility

`brane spawn` handles:
- Scrolling TUI apps (Claude, aider) that use the LIVE loop via MCP
- Static/paned TUI apps (lazygit) that need tmux + terminal streaming
- Plain commands (caffeinate) with no UI at all

MCP injection only happens for agents that support it. The tmux-loop
supervisor treats all spawned processes uniformly.

### Meld

`brane meld` auto-detects Tailscale hostname (if available) and prints
a tappable URL + QR code for mobile access. The URL includes the daemon
auth token as a query parameter. Defaults to `brane.organelle.dev` with
the daemon as backend; falls back to local mode (`--local`) automatically
when the daemon lacks TLS certificates.

## Storage

All state lives in `~/.brane/brane.db` (SQLite, WAL mode). No scattered
JSON files. The only files written to fold directories are agent-agnostic
MCP config stubs (`.mcp.json`) pointing back to `brane mcp`.

### Identity

Each brane instance has a stable ID in the format `brane-<slug>` (short
random hex/base36), generated once and stored in SQLite.

### Schema

```sql
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Keys: brane_id, daemon_port, daemon_pid, daemon_version,
--        daemon_tls, daemon_http_port
-- (No token: tokens are stored as hashes in `tokens`.)

CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,   -- SHA-256 of the token; the token is never stored
  kind TEXT NOT NULL,          -- 'local' (this machine's CLI) | 'device'
  label TEXT NOT NULL,
  origin TEXT NOT NULL,        -- 'minted' | 'adopted' (plaintext from before hashing)
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER           -- revoked, never deleted
);

CREATE TABLE folds (
  path TEXT PRIMARY KEY,
  -- ~/relative for portability
  brane_id TEXT,
  created_at INTEGER NOT NULL,
  last_spawned INTEGER
);

CREATE TABLE narratives (
  id TEXT PRIMARY KEY,
  -- e.g. claude-4c7289d1
  brane_id TEXT NOT NULL,
  fold_path TEXT,
  agent_type TEXT,
  -- claude, lazygit, caffeinate
  role TEXT,
  -- worker, coordinator
  created_at INTEGER NOT NULL,
  status TEXT DEFAULT 'active',
  agent_session_id TEXT,
  title TEXT,
  summary TEXT,
  archived INTEGER DEFAULT 0
);

-- Append-only event log
CREATE TABLE events (
  narrative_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  time INTEGER NOT NULL,
  -- unix ms
  type TEXT NOT NULL,
  -- narration, human_signal, agent_signal
  content TEXT,
  content_type TEXT,
  source TEXT,
  -- who produced this event (narrative ID, device name, etc.)
  re TEXT,
  -- JSON array of back-references
  payloads TEXT,
  -- JSON array of attachment paths
  meta TEXT,
  -- JSON object for per-event metadata (e.g. {"model": "gpt-4o"})
  PRIMARY KEY (narrative_id, seq)
);
CREATE INDEX idx_events_narrative_seq ON events(narrative_id, seq);

```

## ID Scheme

Globally unique event addressing: `<brane-id>:<narrative-id>:<seq>`

- `brane-a7f3c2:claude-4c7289d1:42` — full global address
- `claude-4c7289d1:42` — local address (within a brane)
- `claude-4c7289d1` — narrative address (no specific event)
- `42` — seq within current narrative

## MCP Architecture

The MCP server (`brane mcp`, defined in `src/mcp/server.ts`) is a **thin
stdio↔WebSocket bridge** (~230 lines). It has zero SQLite dependency.
All tool logic lives in the daemon (`src/daemon/server.ts`), which the
MCP bridge connects to via `/ws/mcp?nid=<id>`.

When `brane spawn` creates an agent session, it generates `.mcp.json`
in the fold directory with `BRANE_NARRATIVE_ID` as an environment
variable.

### MCP Tools

#### narrate

Post a narration and receive pending signals in one call.

```jsonc
{
  "say": "Working on the auth module",
  // Cursor: last seq you've processed
  // Number for own narrative, or map for multi-narrative
  "heard": 42,
  // OR: "heard": { "self": 42, "claude-def": 10 }

  // Optional: target narrative (default: self)
  "narrative": "claude-def",
  // Optional: reply-to refs
  "re": [42, "claude-def:10"]
}
```

- Writes to one narrative at a time: self (default) or explicit
  `narrative` target
- Foreign narration (narrative != self) is always explicit
- `re` is metadata only — does not affect routing
- `heard` polls for signals newer than the cursor

#### listen

Block and wait for signals. Stateless cursor-based long-polling.

```jsonc
{
  // Number for own narrative
  "heard": 42
  // OR map for multi-narrative polling:
  // "heard": { "self": 42, "claude-def": 10 }
}
```

#### whoami

Returns the agent's narrative ID and brane ID.

#### revive

Restart a dead tmux session. Idempotent. Optional prompt injection.

#### narrative_search

Semantic search across narrative history. Auto-indexes unindexed events.
Takes `query` (required) and `limit` (optional). Returns ranked results
with narrative_id, seq, content, and score.

#### narrative_info

Get info about narratives. Without `nid`: browse recently active
narratives (takes optional `since`, `search`, `status`, `fold`, `limit`).
With `nid` (string or array): get detailed info on specific narratives
including event count, metadata, timestamps, mcp_connected, and archived
status.

#### list_protocols / read_protocol

List and read protocol documents (LIVE_loop, memory, worker, etc.).

## Daemon

The daemon (`src/daemon/server.ts`) serves:

- **Static files**: the built Expo web app from `expo/dist/`
- **HTTP API**: narratives, events, signals
- **WebSocket endpoints**:
  - `/ws/control` — event hints for live UI updates
  - `/ws/terminal/:nid` — tmux terminal streaming (capture-pane at 10fps)
  - `/ws/mcp/:nid` — MCP tool bridge (daemon owns all tool logic)

All endpoints require `Authorization: Bearer <token>`.

Port reuse: the daemon automatically reuses its previous port across
restarts. The restart command captures the port before sending SIGTERM
(since the shutdown handler deletes it from SQLite).

### TLS

The daemon owns its TLS cert lifecycle end-to-end via
`src/daemon/cert-manager.ts`:

- **Auto-provision on first start.** If `tailscale` is available and no
  cert exists at `~/.brane/certs/tls.{crt,key}`, the daemon shells out
  to `tailscale cert <host>` (same call `brane certify` makes) and
  binds HTTPS with the result. First-run users never need to run
  `brane certify`.
- **Auto-renewal.** An hourly tick re-checks the cert's `notAfter`. When
  fewer than 30 days remain (Tailscale issues 90-day Let's Encrypt
  certs), the daemon re-provisions in the background. Failures back
  off `1h → 2h → 4h → 8h → 24h`.
- **Hot-reload.** `fs.watch` on the certs directory catches both
  internal renewals and operator-driven `brane certify` runs, then
  calls `https.Server#setSecureContext` with the new bytes — no
  daemon restart required.
- **Subject-CN check.** A cert whose CN doesn't match the current
  Tailscale host is treated as invalid and forces re-provisioning,
  catching tailnet/node renames.

When TLS is active the daemon also starts an HTTP fallback on a
separate ephemeral port (restricted to private/local IPs only). This
allows local and LAN clients to connect without TLS certificate
hostname mismatches. The HTTP fallback port is stored as
`daemon_http_port` in the meta table and cleaned up on shutdown.

The current state (`expires_at`, `state`, `last_error_*`,
`next_attempt_at`, `host`) is exposed on `GET /api/status` and
broadcast over `/ws/control` as `{ type: "tls", ... }` on every
transition for the UI to surface a banner. `brane certify` remains as
a manual escape hatch for forcing an immediate re-provision.

### CORS

The daemon allows cross-origin requests from:
- `http://localhost:*` — any port, for local dev
- `https://*.organelle.dev` — production domains
- Configurable `app_domain` via config

## Web App (Expo)

The Expo app at `expo/` is a React Native Web PWA served by the daemon.

### Views

- **Narrative list** (`app/index.tsx`) — shows all active narratives
- **Narrative detail** (`app/[nid].tsx`) — chat + terminal tabs

### Chat Tab

- Operator messages: blue bubbles (#1a4a7a), right-aligned
- Agent narrations: dark gray (#2a2a2a), left-aligned
- Foreign narrations: centered, hash-based pastel backgrounds
- Source labels on agent/foreign messages

### Terminal Tab

- Live tmux mirroring via `ansi_up` ANSI→HTML conversion
- ResizeObserver calculates cols/rows from monospace metrics
- Physical keyboard capture on desktop (tabIndex + keydown)
- Quick bar: macros (live loop, go) + quick keys (1, 2, 3, ↑, ↓)
- Full software keyboard with multitouch modifier support
- Swipe gestures for tab switching

### Building

```sh
cd expo && npx expo export --platform web
```

Output goes to `expo/dist/`, served by the daemon as static files.

## Threading Model

Invariants:

1. Every event belongs to exactly one narrative (stored in `narrative_id`)
2. Every event has a monotonic `seq` within its narrative
3. Every event has a `re` field — an array of back-references (can be
   empty)
4. Long-polling a narrative returns all new events with `seq > cursor`,
   regardless of their `re` values
5. Threading is metadata, not routing — `re` affects display, not
   delivery

### re: references

The `re` field is a JSON array. Each element is either:
- A bare seq number — refers to that seq in the same narrative
- A qualified string `"narrative-id:seq"` — cross-narrative reference
- A narrative ID without seq `"narrative-id"` — refers to the narrative
  as a whole

Examples:
- `re` omitted or `[]` → new topic / continuation by adjacency
- `[42]` → replying to one specific event in the same narrative
- `[42, "claude-def:10"]` → synthesizing multiple sources

### UI threading

The web UI displays a linear timeline (all events in seq order). `re:`
links render as clickable back-references. Click to scroll/highlight
the referenced event. No visual nesting — threading is navigational.

Foreign agent messages are stored in the timeline but collapsed by
default to avoid clutter from side conversations. Expandable on demand.

### Prefix memory (copy-on-write)

When spawning with `--re <narrative-id>`, the new narrative logically
shares prefix memory with the parent. Events are not duplicated — the
parent's history is resolved on demand by walking the ref chain.

## Payloads (Attachments)

Payloads are copied into a stable location on receipt:
`~/.brane/attachments/<narrative_id>/<seq>_<index>.<ext>`

Referenced in the events table as a JSON array in the `payloads` column:
```json
["attachments/claude-abc/42_0.png"]
```

Paths stored relative to `~/.brane/` for portability. The MCP server
resolves to absolute paths when returning events to agents.

## Identity and Security

- All IDs are server-assigned (UUIDs / random slugs) — unspoofable
- The MCP server fixes a narration's narrative and type server-side: an
  agent's bridge binds only as its own narrative, and narration into
  another arrives as an `agent_signal`
- A `human_signal`'s `source` is stamped from the authenticated token
  (`web` for a device, `local` for this account), never taken from the
  request, and an agent's token cannot send one
- **Not built yet:** telling two humans apart. Signals are not tied to
  the device token that sent them. See SECURITY.md, "Who a signal is from"

## Dependencies

- **citty** — TypeScript-native CLI framework (subcommand definitions)
- **better-sqlite3** — SQLite driver (synchronous, WAL mode)
- **ws** — WebSocket library
- **qrcode-terminal** — QR code generation for `brane meld`

Optional (for semantic search):
- **onnxruntime-node** — runs the local embedding model (`bge-small-en-v1.5`); tokenizer and pooling are in `src/memory/`
- **sqlite-vec** — vector search extension for SQLite

## Code style

- Comments above what they annotate, not trailing
