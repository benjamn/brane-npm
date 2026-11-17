# brane

Brane provides a [web-based remote management interface](https://brane.organelle.dev/) for running long-lived Terminal UI (TUI) applications on any remote machine, securely and directly, without a central server, supporting not only full shells like `zsh` and `fish` and utilities like `lazygit` or `htop`, but also most of the popular _agentic_ TUI commands: `claude`, `codex`, `gemini`, `crush`, `copilot`, `goose`, and so on.

The "intelligent" TUI applications demonstrate their intelligence by using brane's local MCP tools: `whoami`, `narrate`, `listen` and the rest, to implement a protocol for ongoing, purposeful conversation (the "LIVE loop") recorded automatically to a permanent, fully agent-searchable record that remains completely private to the host machine.

Unlike a lot of other remote-coding tools, which let you chat with your agents and accept/deny permissions prompts, brane also _mirrors the terminal of the running agent_, so you can keep ambient tabs on your agents working from any mobile device, with the full power of a software keyboard and touch inputs for interacting with the terminal from afar, whenever you need that level of control.

You can use brane from any web-capable device, anywhere in the world, but you must do so via [Tailscale](https://tailscale.com), which makes your private global network fully invisible/useless to anyone else, the best possible network security posture. Requiring you to install Tailscale first would be a dubious pitch for any consumer product, but brane is not a product.

## Etymology and economics

"Brane" is short for **membrane**, evoking a [_eukaryotic_](https://en.wikipedia.org/wiki/Eukaryote) metaphor for agent management, inherited from [organelle](https://github.com/benjamn/organelle): the daemon is the nucleus (which has a membrane), agents are organelles (which in turn have their own membranes), and narrative event logs trace everything each organelle has encountered and done (biologically implausible, but very useful).

I am not paid to work on brane, except by your donations. Brane is not a product. No one is watching you use it, and no one can stand in the way of your continued use of the software as downloaded, even if all maintenance ceases.

If you find brane useful, perhaps because your tastes align with mine and I have aligned brane relentlessly to my tastes, please consider supporting brane's development so it may remain in active development, unencumbered by centralization, surveillance, or required payment:

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa?logo=githubsponsors)](https://github.com/sponsors/benjamn)

## Quick start

0. **Install [Tailscale](https://tailscale.com/download)** and join your
   tailnet on every trusted device. Skip this only if you're staying on
   localhost: Tailscale is the path to encrypted access from your phone and
   other machines.

1. **Install brane:**

   ```sh
   npm install -g brane
   ```

   npm 12 blocks dependencies' install scripts by default and may list
   `onnxruntime-node`'s as blocked. brane doesn't need it: that script only
   downloads CUDA binaries on Linux x64, and brane runs its embedding model
   on the CPU. `better-sqlite3` and `onnxruntime-node` ship prebuilt
   binaries for macOS, Linux and Windows. `brane doctor` checks the install.

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

## Documentation

All of this ships in the npm package as well as this repository, so every
install carries the docs for the version it runs:

- [AGENTS.md](AGENTS.md): the index. It lists the rules for every change and
  has one line per subsystem pointing into `docs/`
- [docs/](docs/): one page per subsystem, from the daemon's API to terminal
  mirroring
- [DESIGN.md](DESIGN.md): architecture, storage, the ID scheme, threading
- [SECURITY.md](SECURITY.md): the threat model
- [protocols/](protocols/): the protocols agents follow, starting with
  [the LIVE loop](protocols/LIVE_loop.md)
- [wiki/shared/](wiki/shared/): why brane is shaped the way it is

### Ask an agent

The quickest way in is to ask. Every brane agent, in any fold and of any
type, is told where its install's docs live (`whoami` reports
`install_dir`) and to read them rather than guess. So signal it as you would
ask a colleague:

- "How does `brane meld` decide what URL goes in the QR code?"
- "What happens to my phone's session when I run `brane token rotate`?"
- "What did we decide last week about the deploy script?" (this one is
  answered by searching your own narratives, not the docs)

When the agent's fold is some other project, say "brane's own docs", so it
doesn't go looking in that project's.

## Contributing

Brane is developed by one maintainer working with coding agents. Commits an agent writes carry a disclosure trailer; responsibility for every change stays with a human, who reviews, signs off, and merges it. Sign-off is human-only: an agent never certifies a contribution. Issues are open; pull requests are maintainer-only. See [CONTRIBUTING.md](CONTRIBUTING.md) for the rules, including the DCO sign-off, and for working from a clone.

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See [LICENSE](LICENSE) for the full text.

Brane is designed to be run as a standalone daemon by individual operators, not embedded into other products. The AGPL's network-use clause ensures that anyone who modifies brane and offers it as a hosted service must share their modifications back.

> Note: the `brane` name on npm previously carried unrelated MIT-licensed packages (0.0.x in 2015, 0.1.1 in 2020). This codebase is a complete rewrite under AGPL-3.0-or-later, first published as 0.3.0.
