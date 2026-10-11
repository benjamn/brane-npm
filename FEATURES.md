# Brane Features

## Agent Management

| Feature | Status | Description |
|---------|--------|-------------|
| Spawn any process | ✅ | Run Claude, Goose, Gemini, Codex, Amp, Copilot, Cline, lazygit, or any CLI command in a managed tmux session |
| Claude agent | ✅ | Full support: model selection, session resumption, `.mcp.json` auto-config, LIVE loop prompt |
| Goose agent | ✅ | Full support: `--with-extension` MCP injection, `--with-builtin developer`, named session resume |
| Agent roles | ✅ | Assign roles (worker, coordinator, image-analyst) to specialize behavior |
| Model selection | ✅ | Choose model at spawn time (`--model opus`, `--model sonnet`) — Claude only |
| Attach to session | ✅ | Jump into an agent's tmux session for direct terminal access |
| Revive dead sessions | ✅ | Restart a stopped agent, preserving its narrative history and session state |
| Enfold existing sessions | ✅ | Resume a running Claude session inside brane with full LIVE loop |
| Session resumption | ✅ | Agent adapters discover and resume prior sessions (Claude via `.jsonl`, Goose via named sessions) |
| Cross-agent spawning | ✅ | Agents spawn sub-agents with `--re` for parent context |
| Fold registration | ✅ | Register project directories as spawn points |

## Communication (LIVE Loop)

| Feature | Status | Description |
|---------|--------|-------------|
| Cursor-based polling | ✅ | Monotonic sequence numbers guarantee no missed messages |
| Narrate + poll | ✅ | Post a status update and receive pending signals in one call |
| Long-poll listen | ✅ | Block until signals arrive — instant wakeup, no polling delay |
| Operator signals | ✅ | Send messages from web UI, mobile, or CLI |
| Inter-agent signals | ✅ | Agents narrate into each other's narratives for cross-agent communication |
| Event threading | ✅ | `re` back-references create a DAG across events and narratives |
| File payloads | ✅ | Attach images and files to signals and narrations |
| Narrative metadata | ✅ | Agents set title and summary, visible in real-time across all clients |
| Protocol documents | ✅ | Agents read protocol specs (LIVE_loop, memory) via MCP tools |

## Daemon & API

| Feature | Status | Description |
|---------|--------|-------------|
| HTTP + WebSocket server | ✅ | Single daemon process serves REST API and WebSocket channels |
| Control WebSocket | ✅ | Real-time push of event hints, status changes, and metadata updates |
| Terminal WebSocket | ✅ | Live tmux capture-pane streaming at 10 FPS with keyboard input |
| MCP WebSocket bridge | ✅ | Thin stdio↔daemon bridge — all tool logic lives in the daemon |
| Token auth | ✅ | Bearer token required on all endpoints |
| CORS | ✅ | Configurable allowed origins (localhost, Tailscale, custom domain) |
| Port stability | ✅ | Daemon restart reclaims its port — no broken bookmarks |
| Daemon lifecycle | ✅ | start, stop, restart, status, log tailing from the CLI |
| Spawn API | ✅ | POST endpoint for programmatic agent creation (used by web UI) |
| Payload storage | ✅ | Immutable file storage at `~/.brane/payloads/`, cache-forever |

## Web App (Expo PWA)

| Feature | Status | Description |
|---------|--------|-------------|
| Narrative list | ✅ | Live-updating list with status indicators and metadata |
| Chat view | ✅ | Message bubbles with Markdown, syntax highlighting, and image previews |
| Terminal mirroring | ✅ | ANSI-rendered tmux output with resize support |
| Software keyboard | ✅ | Full multitouch keyboard with sticky Shift/Ctrl/Alt modifiers |
| Quick bar & macros | ✅ | One-tap macros (live loop, go) and quick keys (Esc, arrows, 1-2-3) |
| Spawn from UI | ✅ | Fold picker modal for creating new agent sessions |
| Tab switching | ✅ | Swipe or tap between Chat and Terminal tabs |
| Mobile PWA | ✅ | Full-screen Apple Web App with dark theme and safe-area support |
| QR code pairing | ✅ | `brane meld` generates a QR code for Tailscale/LAN mobile access |
| Per-narrative meld | ✅ | 🦠 → 🖖 Meld in the chat header shows a QR for the current narrative URL — scanning on a tailnet device opens straight into the same conversation |
| Meld confirmation | ✅ | Receiving device prompts before registering a new daemon (`user@hostname`, brane id, daemon address) instead of auto-adding silently |

## Memory & Search

| Feature | Status | Description |
|---------|--------|-------------|
| Semantic search | ✅ | Vector similarity search across all narrative events (384-dim embeddings) |
| Full-text search | ✅ | FTS5 keyword search with automatic fallback |
| Incremental indexing | ✅ | Only re-indexes new events since last run |
| Memory log | ✅ | Browse recent narratives with time, status, fold, and content filters |
| IDF filtering | ✅ | Ranks results by inverse document frequency for relevance |

## Storage & Infrastructure

| Feature | Status | Description |
|---------|--------|-------------|
| SQLite (WAL mode) | ✅ | Single portable database at `~/.brane/brane.db` |
| Append-only event log | ✅ | Events are immutable once written — no edits, no deletes |
| Portable fold paths | ✅ | Paths stored as `~/`-relative for cross-machine portability |
| Auto-migration | ✅ | Schema evolves without manual steps |
| Global ID scheme | ✅ | Every event is globally addressable: `brane:narrative:seq` |

## Planned

| Feature | Status | Description |
|---------|--------|-------------|
| MCP revive tool | 🔜 | Allow agents to restart other agents' sessions via MCP (currently stub) |
| Error display in web app | 🔜 | Surface API errors in the narrative detail UI |
