# Changelog

Notable changes to brane, by published version. Each version's full notes
are on the [GitHub releases](https://github.com/benjamn/brane/releases)
page, which is also what triggers its publish (see
[docs/releasing.md](docs/releasing.md)). This file is the summary that
travels in the npm tarball.

## 0.3.0 - 2026-10-11

The first release of this codebase. What ships:

- The `brane` CLI and userspace daemon: register directories as folds,
  spawn agents in them (Claude Code, Codex, Gemini, Goose, Crush, Copilot,
  or any command) under tmux, and keep every session's narrative in one
  SQLite database, every message with a stable `nid:seq` address.
- The LIVE loop: an MCP server injected into each agent session
  (`narrate`, `listen`, `whoami`, wiki and memory search), and the
  protocols agents read at runtime, in `protocols/`.
- The web app the daemon serves to any browser on your tailnet: chat,
  terminal mirroring, files, export, markdown with math and diagrams, and
  meld by QR code. Per-device and per-agent tokens, a presence prompt for
  new devices, and `brane token rotate`.
- Memory: local embeddings on `onnxruntime-node` fused with FTS5, across
  narratives and absorbed history (ChatGPT, organelle, local Claude Code
  stores).
- `brane doctor`, which runs the shipped test suite against the install.
- Node 20 or newer. AGPL-3.0-or-later.

## 0.1.1

An unrelated earlier package that held the name on npm (2022). Not an
ancestor of this code.
