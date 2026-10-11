# brane

A TypeScript CLI and userspace daemon for managing narrative agent sessions.

"Brane" is short for **membrane**, evoking a [_eukaryotic_](https://en.wikipedia.org/wiki/Eukaryote) metaphor for agent management, inherited from [organelle](https://github.com/benjamn/organelle): the daemon is the nucleus (which has a membrane), agents are organelles (which in turn have their own membranes), and narrative event logs trace everything each organelle has encountered and done (biologically implausible, but very useful).

I am not paid to work on brane, except by your donations. Brane is not a product. No one is watching you use it, and no one can stand in the way of your continued use of the software as downloaded, even if all maintenance ceases.

You can use brane from any web-capable device, anywhere in the world, but you must do so via [Tailscale](https://tailscale.com), which makes your private global network fully invisible/useless to anyone else, the best possible network security posture. Requiring you to install Tailscale first would be a dubious pitch for any consumer product, but brane is not a product.

If you find brane useful, perhaps because your tastes align with mine and I have aligned brane relentlessly to my tastes, please consider supporting brane's development so it may remain unencumbered by centralization, surveillance, or required payment:

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa?logo=githubsponsors)](https://github.com/sponsors/benjamn)

## What it does

Brane runs long-lived coding agents (Claude Code, Codex, Gemini, Goose and
others, or any command) in tmux on your own machine, keeps everything they
say and hear in one SQLite database, and lets you read, steer and search
them from a phone or any browser on your tailnet.

Four ideas cover most of it:

- **Fold**: a directory you've registered as a place agents may be spawned.
- **Narrative**: one agent session's append-only log of everything it said
  and everything said to it. Every message has a stable address
  (`claude-4c7289d1:42`) you can link to from anywhere.
- **The LIVE loop**: the protocol agents follow to talk to you through an
  MCP server brane injects into each session: listen, interpret, vocalize,
  execute.
- **Meld**: a QR code that signs a phone or browser into your daemon.

## Quick start

0. **Install [Tailscale](https://tailscale.com/download)** and join your
   tailnet on every trusted device. Skip this only if you're staying on
   localhost: Tailscale is the path to encrypted access from your phone and
   other machines.

1. **Install brane:**

   ```sh
   npm install -g brane
   ```

2. **Start the daemon:**

   ```sh
   brane daemon start
   ```

   If Tailscale is running, the daemon provisions a Let's Encrypt cert via
   `tailscale cert` on first start and renews it automatically before
   expiry, so you never run `brane certify` by hand. This needs "HTTPS for
   your tailnet" enabled in the Tailscale admin console; the daemon log
   tells you if you need to flip it.

3. **Register a project directory as a fold** (a spawn point):

   ```sh
   brane fold ~/dev/myproject
   ```

   Or run `brane fold` from inside the directory.

4. **Spawn an agent** from inside the fold:

   ```sh
   cd ~/dev/myproject
   brane spawn claude --meld
   ```

   `--meld` prints a QR code that opens the new narrative on your phone.
   Spawn each agent type once from the CLI, so any first-run login lands in
   a real terminal.

Other useful commands once you're up:

```sh
brane spawn claude --model sonnet --role coordinator --attach
brane spawn claude -- --continue   # anything after -- goes to the agent

# List active sessions
brane list

# Attach to a running session
brane attach claude-4c7289d1

# Restart a dead session
brane revive claude-4c7289d1

# Check the install
brane doctor
```

When attached to a tmux session (via `--attach` or `brane attach`), press
**`Ctrl-b` then `d`** to detach without killing the session — the agent
keeps running in the background and you can re-attach anytime.

`brane --help` lists every command, and `brane <command> --help` its options.

### Enfolding an existing session

Already have a Claude session running outside brane? You can **enfold** it —
stop the session and resume it inside brane with full LIVE loop capability:

1. **Register the project directory as a fold**, if it isn't one already:

   ```sh
   brane fold
   ```

2. **From inside the running Claude session**, have the agent run:

   ```sh
   brane spawn claude -- --resume <session-id>
   ```

3. The agent exits, and its session continues inside brane.

The agent constructs the resume command itself (it knows its own session ID)
and hands off to brane. The resumed session gets tmux wrapping, terminal
mirroring, MCP tools, and the LIVE loop — all from a single `spawn` call.

## Security

Brane's security model has two layers: **network isolation** via Tailscale
and **token authentication**, with a token of its own for every device you
meld and every agent session. This machine's CLI needs none: it reaches the
daemon over a Unix socket only your account can open. Melding a device asks
you to confirm you're at the machine (Touch ID, Windows Hello, polkit).

**On public WiFi, Tailscale is required.** Without it, `brane meld` will only advertise `http://127.0.0.1:port` (same-machine only) unless you opt into a LAN address with `--host <ip>`. Even then, any device on the same subnet can reach the daemon — `brane meld` without Tailscale is a trusted-network feature only. Tailscale makes your daemon invisible to other devices on the LAN: they can't even route packets to your Tailscale IP. TLS on top of that encrypts all traffic — and the daemon handles that for you.

See [SECURITY.md](SECURITY.md) for the full threat model.

## Privacy

Brane is operator-owned by design. All narrative history, events, payloads,
embeddings, and config live in `~/.brane/` on your own machine. There is no
hosted control plane, no telemetry, no analytics, no third-party sync — the
daemon talks to your devices over Tailscale and to your chosen LLM provider.
Semantic search runs a small embedding model locally, so your history is
never sent anywhere to be indexed. If you delete `~/.brane/`, the data is
gone; if you back it up, it's yours.

The one unavoidable trust boundary is **inference**: every prompt you send
to Claude or GPT or any other hosted model leaves your machine and is
subject to that provider's data policies. Brane doesn't filter or redact
this traffic — the agent process talks directly to the provider, the same
way it would if you ran it without brane. Local models would close this
gap, but the agentic-coding competence gap between frontier hosted models
and anything that fits on a laptop is still wide enough that brane treats
hosted inference as the default. Run a local model with a brane-compatible
CLI whenever that calculus changes for you.

## Further reading

- [DESIGN.md](DESIGN.md): architecture, storage, the ID scheme, threading
- [docs/](docs/): one page per subsystem, from the daemon's API to terminal
  mirroring
- [protocols/](protocols/): the protocols agents follow, starting with
  [the LIVE loop](protocols/LIVE_loop.md)

## Contributing

Brane is developed by one maintainer working with coding agents. Commits an agent writes carry a disclosure trailer; responsibility for every change stays with a human, who reviews, signs off, and merges it. Sign-off is human-only: an agent never certifies a contribution. See [CONTRIBUTING.md](CONTRIBUTING.md) for the rules, including the DCO sign-off asked of outside contributors, and for working from a clone.

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See [LICENSE](LICENSE) for the full text.

Brane is designed to be run as a standalone daemon by individual operators, not embedded into other products. The AGPL's network-use clause ensures that anyone who modifies brane and offers it as a hosted service must share their modifications back.

> Note: the `brane` package was previously published on npm under MIT in 2020. This codebase is a complete rewrite that supersedes that release; any future npm publication would ship as a new major version under AGPL-3.0-or-later.
