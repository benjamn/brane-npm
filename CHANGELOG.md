# Changelog

Notable changes to brane, by published version. Each version's full notes
are on the [GitHub releases](https://github.com/benjamn/brane/releases)
page, which is also what triggers its publish (see
[docs/releasing.md](docs/releasing.md)). This file is the summary that
travels in the npm tarball.

## 0.3.8 - 2026-10-22

- The web app works with a screen reader and a keyboard. Every control
  says what it is: the send 🦋 is "Send", the tab 📌 is "Pin Chat" and says
  whether it is pressed, the 🦠 is "Narrative menu", the on-screen terminal
  keys are named. The narrative cards on the list, which a keyboard could
  not reach before, are links with a tab stop. Markdown headings are real
  headings, so a long narration can be walked by them, and a message that
  arrives is announced. The 📋 copy button keeps its look and gains a 24 px
  hit box. What is still open (pinch zoom, the terminal mirror, contrast)
  is in `docs/accessibility.md`
  ([#635](https://github.com/benjamn/brane/pull/635)).
- The audio dial no longer keeps scrubbing after a release it never heard,
  as when the mouse is let go outside the window: the drag ends and the
  playhead stays put. Letting go inside the ring, where a pixel swings the
  angle a long way, cancels the scrub rather than seeking somewhere
  arbitrary
  ([#633](https://github.com/benjamn/brane/pull/633),
  [#634](https://github.com/benjamn/brane/pull/634)).

Published while the repository is private, so like 0.3.0–0.3.7 it
carries no npm provenance attestation.

## 0.3.7 - 2026-10-21

- Operator verification, off until you turn it on. Enroll a passkey or
  security key from the Devices view, then run `brane config verification
  passkey`. From then on, a melded device must prove it is you (Face ID,
  Touch ID, a PIN, or a YubiKey's touch) before it acts: sending,
  spawning, typing into a terminal. Reads stay open. A refused act opens a
  lock sheet, which hops to the daemon's own `/verify` page and then retries
  what was refused. `brane config verification off`, from the Mac's shell,
  is always the way back. The design is in `docs/passkeys.md`
  ([#621](https://github.com/benjamn/brane/pull/621),
  [#625](https://github.com/benjamn/brane/pull/625),
  [#626](https://github.com/benjamn/brane/pull/626),
  [#630](https://github.com/benjamn/brane/pull/630)).
- Audio files open in the Files view and keep playing while you move around
  the app. One track plays at a time. A dial on the narrative's list card
  and in its header pauses it and scrubs
  ([#623](https://github.com/benjamn/brane/pull/623),
  [#628](https://github.com/benjamn/brane/pull/628)).
- Codex agents start again under Codex CLI 0.163, which removed
  `--full-auto`, and a revived one connects as its own narrative. Spawn and
  revive now share one launch line, run outside codex's shared daemon
  ([#627](https://github.com/benjamn/brane/pull/627)).
- A terminal mouse message whose fields aren't plain integers is dropped,
  not typed into the pane
  ([#622](https://github.com/benjamn/brane/pull/622),
  [#624](https://github.com/benjamn/brane/pull/624)).

Published while the repository is private, so like 0.3.0–0.3.6 it
carries no npm provenance attestation.

## 0.3.6 - 2026-10-15

- The 🦠 menu has a 🐚 Utility item, beside 🧬 Twin, that opens the
  Spawn dialog on its Utility side, in that narrative's fold, with the
  last utility run already picked: a `zsh` next to an agent is 🦠 → 🐚
  → Run. The list card's status-badge menu offers it too
  ([#618](https://github.com/benjamn/brane/pull/618)).
- Long fold paths in the Spawn dialog scroll sideways under a fade
  instead of ending in an ellipsis, so the tail that tells similar
  folds apart can be read
  ([#617](https://github.com/benjamn/brane/pull/617)).

Published while the repository is private, so like 0.3.0–0.3.5 it
carries no npm provenance attestation.

## 0.3.5 - 2026-10-14

- A browser holds daemons from one tailnet only. A meld link or "+ Add
  Daemon" entry for a host on another tailnet is refused before anything
  is sent to it, so a stranger's daemon (behind Tailscale Funnel, say)
  can't be melded into a browser that holds yours. To use another
  tailnet, use another browser, or remove this one's daemons first
  ([#613](https://github.com/benjamn/brane/pull/613)).
- A browser's first meld gets a warning card: continue only if you
  installed brane and ran `brane meld` yourself, and cancel a link
  someone sent you. A loopback daemon is accepted beside a tailnet and
  never decides one
  ([#615](https://github.com/benjamn/brane/pull/615)).
- Every row of the brane switcher has a ⋯. A daemon can be archived on
  this device, keeping its token so it is one tap from Reconnect, or
  deleted, which first signs this device out of it
  (`POST /api/token/forget`). A brane can be archived on the daemon, for
  every device: its ended narratives leave All branes, and its running
  ones never do. The home brane and the last brane showing can't be
  archived. The long-press that silently removed a daemon is gone
  ([#614](https://github.com/benjamn/brane/pull/614)).

Published while the repository is private, so like 0.3.0–0.3.4 it
carries no npm provenance attestation.

## 0.3.4 - 2026-10-14

- "All narratives" in the narrative switcher pushes the list in this tab
  again, so Back returns to the narrative; 0.3.3 opened it in a new tab
  on every click. It is still a link, so a ⌘-click opens a new tab, and
  that tab lands on the same daemon
  ([#611](https://github.com/benjamn/brane/pull/611)).

Published while the repository is private, so like 0.3.0–0.3.3 it
carries no npm provenance attestation.

## 0.3.3 - 2026-10-14

- A fresh `npm install brane` audits clean. The math syntax extension
  is now vendored (`src/math-syntax.ts`) instead of depending on
  `micromark-extension-math`, which pinned a second, older katex into
  every install (GHSA-238p-pmpm-9mq7) and led `npm audit fix --force` to
  propose brane@0.1.1 ([#608](https://github.com/benjamn/brane/pull/608)).
- In the web app, "All narratives" opens the list in a new tab, and a
  link opened in a new tab lands on the daemon it came from rather than
  the browser's default one ([#607](https://github.com/benjamn/brane/pull/607)).
- The 膜 glyph carries a caption — a quip or a tip about brane — that
  changes on each tap and nothing else; the empty state's words move
  above it, and it no longer says "No narratives yet" when they are all
  archived ([#606](https://github.com/benjamn/brane/pull/606)).
- The README, which is also the npm page, opens with a new
  introduction: what brane is for, the LIVE loop, and terminal
  mirroring ([#610](https://github.com/benjamn/brane/pull/610)).

Published while the repository is private, so like 0.3.0–0.3.2 it
carries no npm provenance attestation.

## 0.3.2 - 2026-10-13

- Archive is offered only once a narrative has ended, and the daemon
  enforces it: `PATCH /api/narratives/:id/archive` answers 409 while the
  narrative's status isn't `ended`, its agent is still connected, or its
  tmux session is up. Unarchiving is never refused
  ([#604](https://github.com/benjamn/brane/pull/604)).
- Archiving from a narrative's own 🦠 menu goes to the narrative list,
  and Back returns to the archived narrative
  ([#603](https://github.com/benjamn/brane/pull/603)).
- Swiping the narrative's header card down dismisses it to the list;
  Back returns ([#604](https://github.com/benjamn/brane/pull/604)).

Published while the repository is private, so like 0.3.0 and 0.3.1 it
carries no npm provenance attestation.

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
  reporting (see `SECURITY.md`)
  ([#597](https://github.com/benjamn/brane/pull/597)).

Like 0.3.0, published while the repository was private, so it carries
no npm provenance attestation. The copy of this entry in the 0.3.1
tarball says otherwise; it is wrong.

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
