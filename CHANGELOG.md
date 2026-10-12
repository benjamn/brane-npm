# Changelog

Notable changes to brane, by published version. Each version's full notes
are on the [GitHub releases](https://github.com/benjamn/brane/releases)
page, which is also what triggers its publish (see
[docs/releasing.md](docs/releasing.md)). This file is the summary that
travels in the npm tarball.

## 0.3.1 - 2026-10-12

- The shared web app ships with the release. It serves the `latest`
  release's own `expo/dist`, and a merge to `main` deploys nothing; a
  daemon running `main` serves its own newer bundle, through Isolate
  ([#600](https://github.com/benjamn/brane/pull/600)).
- The app knows no host. `brane meld` and `brane spawn --meld` point
  their QR at the `app_domain` config (`--app` / `--meld-app` for one
  QR), `GET /api/status` reports it, and Isolate and the in-app Meld
  work from whichever host serves the app
  ([#598](https://github.com/benjamn/brane/pull/598),
  [#599](https://github.com/benjamn/brane/pull/599)).
- The token is the only credential. The daemon no longer checks an
  origin allowlist: CORS answers `*` without credentials. The origin
  each device runs the app from is recorded and shown in the Devices
  list and `brane token list`
  ([#593](https://github.com/benjamn/brane/pull/593),
  [#595](https://github.com/benjamn/brane/pull/595)).
- The spawn dialog's "Other…" agent runs any command on the daemon's
  `PATH`, as `brane spawn <agent>` does, and spawn errors show in the
  dialog ([#596](https://github.com/benjamn/brane/pull/596)).
- New terminals start at the viewer's size, so launch redraws no longer
  pile up in scrollback, and the 🦾 menu gains "Clear 🧽" to clear a
  pane's scrollback ([#574](https://github.com/benjamn/brane/pull/574)).
- On a Fly machine the daemon keeps its ports across boots, and a revive
  repoints the fold's hook config at the running daemon
  ([#594](https://github.com/benjamn/brane/pull/594)).
- Vulnerabilities are reported through GitHub's private vulnerability
  reporting (see `SECURITY.md`). This is the first release published
  from the public repository, so it carries npm provenance; 0.3.0 has
  none ([#597](https://github.com/benjamn/brane/pull/597)).

## 0.3.0 - 2026-10-11

The first release of this codebase. What ships:

- The `brane` CLI and userspace daemon: register directories as folds,
  spawn agents in them (Claude Code, Codex, Gemini, Goose, Amp, Copilot,
  Cline, Crush, or any command) under tmux, and keep every session's
  narrative in one SQLite database, every message with a stable `nid:seq`
  address.
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

An unrelated earlier package that held the name on npm (2020). Not an
ancestor of this code.
