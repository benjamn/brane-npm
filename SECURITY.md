# Brane Security Model

Brane is a local-first system. Your data never leaves your machine unless you explicitly connect a device.

## Reporting a vulnerability

Report it privately, through GitHub's [private vulnerability reporting](https://github.com/benjamn/brane-npm/security/advisories/new) (the repository's **Security** tab, then **Report a vulnerability**). Only the maintainer sees the report. Don't open an issue for it: issues are public.

Brane has one maintainer and no support commitment, so there is no promised response time. The report that gets fixed fastest says which version (`brane --version`), what the attacker needs to start with (a tailnet peer, a process on the machine, a melded device, an agent session), and what they end up with.

## Network isolation by default

The daemon binds **only to loopback and Tailscale addresses**. The listen sockets themselves are the first line of defense: by default, the daemon is attached only to `127.0.0.1`, `::1`, and whatever IPs `tailscale status --json` reports (typically one IPv4 and one IPv6 in the 100.x / fd7a::/8 range). **The machine's LAN IP is not bound.** Same-subnet port scans see nothing on the daemon's port — the kernel rejects those SYNs with RST before any userspace code runs.

As a second line of defense, a **TCP-level connection filter** runs on every accepted socket. Even if a connection reached a listener it shouldn't have, the filter would drop it before any HTTP or WebSocket processing. The filter accepts:

- **Localhost** (`127.0.0.1`, `::1`)
- **Your Tailscale IPs** (auto-detected from `tailscale status --json`)
- **RFC 1918 private ranges** (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
- **CGNAT range** (100.64.0.0/10, covering Tailscale peer addresses)

There is no code path — not HTTP, not WebSocket, not even a TCP handshake completion — for a public internet IP to reach the daemon. This holds even if the machine has a public IP, port forwarding, or a misconfigured firewall.

Use `--bind <address>` to override the default bind list (e.g., `--bind 0.0.0.0` to listen on every interface; `--bind 192.168.1.42` to deliberately expose a specific LAN IP). The explicit override also disables the TCP-level filter, since the operator is asking to hear from whatever the kernel lets through.

## The Fly wake door is public, and the daemon is not behind it

A brane daemon on a Fly machine can put its host to sleep (the machine stops) and be woken from the app with one request to `https://<app>.fly.dev/wake` ([Sleep and Wake](docs/sleep.md), /fly). That hostname is the one thing brane ever exposes to the public internet, and it is a separate process on its own port that answers `GET /wake` with 204 and everything else with 404; the daemon runs under `--bind 0.0.0.0` in the container, with no IP filter, and Fly Proxy routes only the wake port. The door is **unauthenticated by construction**: the proxy starts the machine before any request reaches the listener, so a token in the URL would protect nothing. Anyone who knows the hostname can start the machine and cost minutes at the running rate until the idle rule puts it back to sleep; they reach nothing else. A wake starts a bare daemon: the agents a Sleep recorded are revived only when the operator connects (a melded device's token), so a stranger's wake starts no agent and nothing that would keep the host up, unless one of the operator's own devices is still pointed at that daemon: the app retries its control socket every 2 s, so an open tab connects as soon as the host is up, whoever woke it, and restores the agents ([Sleep and Wake](docs/sleep.md#decisions)). The bounds are the app name's entropy (`/fly init` draws 64 bits) and the idle rule, and opening the door at all is the operator's step, by allocating a public IP; `fly ips release` closes it, leaving `fly machine start` as the only wake.

## Tailscale as the trust boundary

The recommended setup puts Tailscale between you and brane. Tailscale IPs (100.x.y.z) are **only routable within your tailnet** — they're CGNAT addresses that don't exist on the public internet. An attacker who captures your bearer token still can't use it unless they're on your tailnet, which requires either:

- Compromising your Tailscale account (game over regardless of brane)
- Root access to your machine to install their own Tailscale client (game over regardless)
- Social engineering you into sharing your node (deliberate user action)

This means the daemon's bearer token is a **second factor**, not the sole gate. Network-level access is the first.

## The meld QR is safe to display in public

`brane meld` will not auto-advertise your machine's LAN IP. The QR encodes one of:

- **A Tailscale hostname** — `https://your-host.your-tailnet.ts.net/#token=…`. Only routable inside your tailnet.
- **`http://127.0.0.1:port/#token=…`** — only useful from the same machine the daemon is on.

The token rides in the URL **fragment**, not the query string. A fragment is never sent to any server: not to `brane.organelle.dev` (Cloudflare serves the app bundle, and a query string would have been part of that request), not to a chat app's link-preview fetcher when a meld URL is pasted, and not into the daemon's own request log. The app reads it from `location.hash` and removes it from the address bar as soon as it has been used. Old links with `?token=` are still honored.

A stranger who photographs your QR from across the coffee shop gets a token they can't use, because the address it's paired with is dead in their network: a Tailscale hostname won't resolve outside your tailnet, and `127.0.0.1` points at *their own* loopback where nothing is listening. This holds whether or not Tailscale is running and whether or not the WiFi you're on is hostile. The QR is single-glance-useless by construction, not by operator vigilance.

To opt in to LAN reach on a trusted home network, pass `brane meld --host <lan-ip>` paired with a matching `--bind`. That is an explicit choice — the over-the-shoulder threat reappears for the duration of that session, but only because the operator asked for it.

## One tailnet per browser

The QR's safety is about the link *you* show. The reverse case is a link someone sends *you*: a meld link to a daemon they run. Anyone can stand one up behind Tailscale Funnel, which gives it a public `*.ts.net` name and a valid certificate, and the meld card's **Daemon** and **Brane** rows are whatever that daemon says about itself, so it can claim to be `you@your-mac`. A browser keeps every melded daemon's token in one origin's `localStorage`. Any script that runs in that origin, through a renderer bug fed by the hostile daemon, can read every one of them. Your browser is on your tailnet, so the script can then use those tokens against your own daemons directly. Tapping **Meld** on such a link must cost nothing, whatever bugs the renderer has.

So a browser origin holds daemons from **one trust domain** only (`src/shared/tailnet.ts`). The domain is read from the host the browser connects to, never from anything the daemon reports. For a MagicDNS name, which is what `brane meld` writes, it is the tailnet: `tail1234.ts.net` for `mac.tail1234.ts.net`. Only Tailscale issues names and certificates under a tailnet's domain. Any other host is a domain of just itself. Loopback is no domain at all: only this machine can serve a loopback daemon, so one is accepted beside any tailnet and never decides one. A browser holding only loopback daemons still has its domain to pick. The first meld of anything else sets it. After that, a meld link or an **+ Add Daemon** entry for a host in another domain is refused **before anything is sent to it**, not even the status probe that would tell its owner the link was opened. The card names both domains. To use another tailnet, open the link in another browser or profile, or remove this browser's daemons first.

What this does not cover:
- **A hostile member of your own tailnet** passes. On a tailnet shared with other people, that person is inside the trust boundary, as they are for every other tailnet service.
- **A browser with no domain yet** (no daemons, or only loopback ones) takes whatever it is sent first, which is why that meld gets its own card. It says to continue only if you installed brane and ran `brane meld` yourself, and to cancel if someone sent you the link. It also names the tailnet the browser will be held to. Connecting to a stranger's daemon is already the loss: it sees everything you do in the app. So the defense is at that tap, not after it. Your own daemon is refused afterwards, which is how you would find out.
- **A browser melded before this rule may already hold two domains.** It can add daemons to either, but not to a third.

## Authentication

Every API and WebSocket request over TCP requires a 128-bit UUID bearer token, passed via `Authorization: Bearer` header or query parameter. Brute-forcing 128 bits of entropy is not feasible. The one exception is a request over the daemon's Unix socket, which needs no token and acts as this machine's account (below).

**The token is the only credential; the origin is reported, never gated.** The daemon does not care which hostname serves the app: `brane.organelle.dev`, a staging hostname, a fork's own deployment, a daemon's own bundle, or a page on a laptop's `localhost`. A page holding no token gets a 401 whatever its origin. A page holding one can *act* with it from any origin: the token is accepted in `?token=` on any method, and request bodies are parsed as JSON whatever their `Content-Type`, so a `text/plain` POST, which needs no preflight, signals or spawns from any origin regardless. An origin allowlist would only hide responses and refuse WebSockets, never block a write, and the browser is the bridge across the IP filter that `curl` off the tailnet does not have. So the only honest boundary is the token. CORS therefore answers `*` with no credentials (brane sets no cookies, and `Allow-Credentials` with a reflected origin is the one CORS combination that could ever be dangerous), and the WebSocket upgrade checks the token and nothing else. What the origin *is* for is the Devices list: the first `Origin` a token is presented from, and the latest, are recorded on its row (`app_origin`, `last_app_origin`) and shown as "via main.brane.organelle.dev", so you can see which copy of the app each device runs. The one request that still looks at `Origin` is a tokenless one on the Unix socket, below, where its presence is what marks a browser behind a relay.

**Tokens are stored as hashes only.** The `tokens` table holds the SHA-256 of each token, never the token, so the daemon's own record of who may connect authenticates nothing by itself, and the daemon cannot print a token back. Each melded device gets its own token, minted when its QR is made, whether by `brane meld` or by the app's Meld item; that QR is the only copy. The device showing an in-app Meld QR never hands over its own token, and opening the sheet mints a fresh one each time. A minted token nobody uses within 10 minutes lapses, so an unscanned or photographed QR stops working. This machine's CLI and MCP bridges hold no token: they reach the daemon over its Unix socket, `~/.brane/daemon.sock`, and present nothing. `~/.brane` is `0700` and the database is `0600`, so other accounts on the machine can read none of it, and cannot connect to the socket either: reaching it takes search permission on that directory. That is why a request over the socket needs no token: only this account can have sent it, and it acts as this machine's `local` row, which no token opens. This machine's standing therefore exists only on the socket and cannot be copied off the machine. Older branes kept a local token in `~/.brane/.daemon_token` instead, which worked from any address the IP filter admits; the daemon revokes it at its first start and empties the file, and `brane doctor` reports the empty leftover, which is yours to remove. Where the daemon cannot listen on the socket (a `~/.brane` path too long for one, a filesystem that cannot hold one), the shell CLI cannot reach it and says why; agents and devices, which hold tokens, still can. The daemon checks the directory is still owned by it and closed to group and other before every such request, and refuses them if it is not. It also refuses a tokenless request that carries an `Origin` header or a `Host` other than `localhost`, which is what a browser's request looks like when something relays a port to the socket (`ssh -L`, socat, a devcontainer forward). Even so, a relay to `daemon.sock` extends "this account" to whoever can reach the relay: don't run one.

**What hashing does not cover.** Two things.

- *A process that can already act as you.* Every process running as your user, agents included, can connect to `daemon.sock` and write to `brane.db`.
- *A token that was written down.* The database is also a record of what was said and done, kept verbatim and never redacted: narrations and signals as they were written, and every captured tool call with its input and output. A token that reaches that record is stored in the clear. It gets there when an agent prints its own token, runs `curl` with a bearer header, or quotes a meld URL in a narration; the agent harness's own session logs hold the same text. Daemons from before hashing also printed their token into `~/.brane/daemon.log` at every start.

So a copy of `brane.db` (a backup, a debugging copy) is not safe to hand out merely because the `tokens` table is hashed: treat it as you would the token. The remedy for a token that has been written down anywhere is rotation. A revoked token is a dead string wherever it was recorded.

### Who the operator is

The **operator** is any human who can pass this machine's local authentication for the Unix account brane runs as, at the moment brane asks: Touch ID, a paired Watch or the login password on macOS; Windows Hello; polkit's own-password check on Linux (`src/presence.ts`, [Presence Check](docs/presence.md)). It names an account, not a person: anyone with a finger enrolled on that account, or its password, passes. And it means passing *then*: being logged in, over SSH say, is not enough when the prompt appears on a screen nobody is at.

Two things follow.

- **A process is never the operator**, even one running as the operator's account. Agents run as that account, but none can answer the prompt, which the daemon raises and reads itself, with wording it builds from the act being approved. What a process running as the account can do is what the account can already do with its own files and tmux, and brane does not pretend otherwise: an agent token names an agent and makes it revocable, it does not contain one. Brane offers no sandbox.
- **Every credential should trace back to an operator act**: a device token to a meld, an agent token to a spawn or revive. Acts that reach off this machine or cut the operator off — minting a device token, revoking a device, signing out every device — are the operator's: asked from this machine's shell they are gated by the presence check — the daemon holds the request until the operator passes the OS prompt (`src/daemon/presence-gate.ts`, [Presence Check](docs/presence.md#the-gate)) — and asked with an agent's token they are refused. A device token is the operator's delegate, minted by an operator act, and is not prompted. The gate is one more act an agent has to get past, not containment: a process that can already mint itself a device token, or edit `dist/`, is not stopped by it. The local row is the exception, since nobody approved it beyond starting the daemon: it is what a tokenless request over the socket acts as. It is not a credential, though: no token opens it, so it cannot be carried off this machine.

### Rotating the token

"Sign out other devices", at the foot of the Devices list in the app's brane switcher, replaces that device's token. The device that asked keeps its access; every other web client is refused from that moment and must scan a fresh `brane meld` QR. Local processes are unaffected — the CLI and MCP bridges hold no token, and agent sessions authenticate per narrative. `brane token rotate` in a shell signs out every device: the shell has no token of its own to replace, so once the operator passes the presence prompt the daemon revokes every device token in that one request.

For a device, the daemon retires the old token on the **first use** of the new one rather than on the rotate request itself, so a lost response cannot lock every device out; an unused replacement lapses after 60 seconds. The cost of that is a window of at most 60 seconds during which both tokens are valid, and only if the requesting device vanished before confirming. Rotation revokes credentials, not sessions on the host: a tmux session someone already attached to stays attached.

**What rotation guarantees, and what it cannot.** Once your rotation completes, holders of the old token are out. It cannot stop someone who already holds the old token from calling the rotate route themselves — that adds nothing, since the token already grants keyboard input to every tmux session — but the daemon is careful never to *help* them: a pending token is issued exactly once, in the response that minted it, and a second rotate within the window voids the first rather than repeating it. If an attacker rotates after you, your confirm fails visibly and the daemon logs that a pending rotation was replaced before use. If you suspect the token is being used by someone else *right now*, rotate from the shell: `brane token rotate` signs every device out in the one request it makes, so there is no window at all.

### Agent sessions authenticate per narrative

Each agent session has a token of its own. At spawn and revive the daemon mints an **agent token** for that narrative (kept only as a hash, in `tokens`, bound to the narrative) and puts it in the session's tmux environment as `BRANE_NARRATIVE_SECRET` beside `BRANE_NARRATIVE_ID`; each launch's token revokes the previous one. The MCP bridge authenticates with it, the `brane` CLI inside the session uses it, and the agent-harness hook presents it on every tool record. An agent token can bind only as its own narrative. It shows in the Devices list and can be revoked there, which closes its bridge (4401) and leaves its tmux session alone; a revoked agent comes back only by being revived. A claim that cannot prove itself is refused — the connection is bound instead to a fresh `external-*` narrative of its own, and a `binding_rejected` event is written on the narrative that was claimed, so the attempt is visible to its owner rather than only to the log.

**What an agent token does not do.** The agent runs as your Unix user, so it can drop its token, reach `daemon.sock` with none, and act as this machine instead. A per-agent token makes each agent nameable, attributable and revocable; it does not contain one that goes around it. What no process can do any more is take this machine's standing somewhere else: there is no local token to copy.

**What an agent token can do.** Less than a device token. Its routes are a default-deny list (`src/daemon/agent-scope.ts`): it may read brane (narratives, events, files, wiki, search), use the renderers, spawn and revive sessions, update the memory index, and bind the MCP bridge as its own narrative. It may not open the app's channels (a narrative's terminal, the control socket), send a `human_signal`, start a utility session (`POST /api/run`), see the Devices list, or do the operator's housekeeping (registering or archiving folds, archiving narratives, absorb, cost backfill and reprice); the gated acts are refused it as before. A closed route answers 403 and says to run the command from a utility session, which the operator starts from the app's spawn dialog and whose environment carries no agent token. And it works **only from this machine**, over `daemon.sock` or loopback, on every route including the agent-harness hook: every MCP bridge, spawned or external, runs here and dials the socket, so a copy of an agent token that leaks off the machine opens nothing.

**Who a signal is from is the daemon's to say.** `POST /api/narratives/:id/signal` and the control socket's `signal` message stamp `source` from the token that sent them — `web` for a device, `local` for this account over the socket — and ignore any `source` the request names; an agent's token is refused (`src/daemon/signal-source.ts`). An agent that wants to speak into another narrative narrates into it, which records an `agent_signal` under its own narrative. So a `human_signal` comes from a device or this account's shell. It does not say which device: signals are not yet tied to the token row that sent them.

All of this is hygiene, not containment, for the reasons in the paragraph above: an agent can still go around its token to `daemon.sock`. It is not handed a sanctioned way around, though: a utility session (`POST /api/run`) is one whose environment carries no agent token, so starting one is closed to agents, and so is reviving or prompting one (a prompt typed into it, or its command replayed, would run as this account). There is no `brane run` command either: the operator starts those sessions from the app's spawn dialog, so no `brane` verb an agent can type at its shell exists whose job is to start a session as this account. `brane attach <nid>` still attaches to one the operator started. tmux, too, lets any process running as you type into any session, agents included; that is known and accepted.

This is what keeps a crossed `BRANE_NARRATIVE_ID` — two processes sharing a fold, a copied env, a reused id — from narrating into a session that isn't theirs. It is not a second line of defence against an outsider: a device token's holder can already type into every tmux session. It is a guarantee about *attribution*, which is the thing a narrative log is for.

An unauthenticated client is still a first-class participant. It simply gets a narrative the daemon mints for it, with an agent token of its own returned in the connection's `welcome`, so its later reconnects are authenticated like everyone else's and it stays on one narrative rather than fragmenting into a new one per reconnect.

Narratives spawned before per-narrative secrets existed have no token, and for a time they were allowed to bind without one — a migration grace, so that upgrading the daemon would not sever a session already in flight. That grace is gone. A tokenless row can no longer be bound at all. Reviving a *dead* one mints it a token first, which is the supported way back. A tokenless session that is still running cannot be rescued in place — `revive` answers `already_running` without minting, and a running bridge could not pick up a new environment variable anyway — so it has to be ended (its tmux session killed) and then revived.

## No cloud dependency

Brane has zero cloud backend. `brane.organelle.dev` is a static Expo web bundle served from Cloudflare — it's a convenience for loading the PWA. The browser then connects **directly to your daemon** over your Tailscale network. If you don't trust the hosted app, `brane meld --local` serves the same bundle from the daemon itself. There is no telemetry, no account system, no data relay.

## Dual HTTP + HTTPS when TLS is available

When TLS certificates are present (the daemon auto-provisions them via `tailscale cert` if Tailscale is running, and otherwise lets you provision them manually with `brane certify`), the daemon serves HTTPS on the main port (for Tailscale hostname access) and simultaneously starts an HTTP fallback server on a separate ephemeral port. The HTTP server is **always** restricted to private/local IPs only — even if `--bind` is used to open the HTTPS server. This ensures that:

- **Tailscale clients** connect over HTTPS using the valid hostname certificate
- **Local and LAN clients** (localhost, RFC 1918, CGNAT) can still reach the daemon over plain HTTP without TLS certificate hostname mismatches
- The HTTP fallback port is stored in SQLite as `daemon_http_port`, and deliberately survives shutdown so meld URLs stay stable across daemon restarts
- WebSocket upgrade requests on the HTTP server are forwarded to the main server's handler, so terminal streaming and MCP connections work over either transport

When TLS is not configured, the daemon serves HTTP only on a single port, with the standard IP filtering applied.

## Daemon singleton guarantee

A SQLite `BEGIN EXCLUSIVE` transaction prevents race conditions when starting the daemon. Two processes cannot simultaneously claim the daemon role — the second one sees the first's PID and exits cleanly. Version mismatches between CLI and daemon are detected and surfaced with actionable warnings.

## The bundled tmux binary is integrity-checked

Brane needs `tmux` to run agent sessions. If `tmux` is already on your `PATH` — the common case for the developers brane targets — that system binary is used and **nothing is fetched**. Only when no system `tmux` exists does the daemon download a static build, and it does so **lazily on daemon startup**, never as an `npm` lifecycle script. There is no `postinstall` hook: `npm install` performs no network fetch and runs no brane code, so install-time script policies (`--ignore-scripts`, sandboxed CI) neither break brane nor are needed to contain it.

When a fetch does happen, the archive is pulled over **HTTPS** from the official `tmux/tmux-builds` GitHub releases and then verified against a **SHA-256 digest pinned in brane's source** before it is extracted or made executable. Verification is **fail-closed**: any mismatch, an unrecognized platform, or a truncated/corrupted download causes the archive to be deleted and the install abandoned — brane never extracts or runs a binary it did not pin. A compromised CDN, a re-uploaded release asset, or a network-level tamper therefore cannot result in an unverified `tmux` executing; the worst case is no `tmux`, which surfaces as an actionable "install tmux" error rather than a silent compromise.

The fetch never blocks startup and a failure is recoverable by construction: restarting the daemon re-attempts it from scratch, and a failed attempt leaves no partial binary behind. The pinned digests come from GitHub's release-API asset digests; as with any vendored-binary pin, this is trust-on-first-use for the *initial* value and a hard integrity guarantee for every fetch thereafter — you are guaranteed the exact bytes brane pinned, not a moving target.

## Why Tailscale matters on untrusted networks

By default the daemon doesn't bind to your LAN IP, so devices on the same coffee-shop / hotel / airport WiFi can't reach the daemon's port at all. The default is safe on hostile networks **without** any operator vigilance.

The threat reappears only when an operator opts in to LAN reach by running with `--bind 0.0.0.0` (or `--bind <lan-ip>`, or `brane meld --host <lan-ip>` paired with an open bind), typically on a trusted home network. Once that opt-in happens, the RFC 1918 filter accepts every device on the subnet — which is the same range every coffee shop, hotel, and airport WiFi uses. On a shared LAN with that configuration, every device on the subnet can reach your daemon's port, and the bearer token is the only remaining gate.

In that opted-in configuration, without TLS, the token travels in cleartext HTTP headers and URL query parameters. An attacker on the same WiFi can capture it by sniffing traffic. Worse, `brane meld --host <lan-ip>` displays the token alongside a LAN-reachable URL in a QR code — anyone who photographs the screen from across the room has the address and the token in a single frame.

### Tailscale provides network-level isolation

Tailscale assigns your devices addresses in the 100.x.y.z CGNAT range, routable **only within your tailnet**. Other devices on the coffee shop WiFi cannot even send packets to your Tailscale IP — your daemon is invisible to them, not just authenticated against them.

This means the QR code from `brane meld` becomes **two-factor by construction**:
1. **Something you know** — the bearer token
2. **Somewhere you are** — on the tailnet (requires a device authenticated to your Tailscale account)

Even if someone photographs the QR code, they get a hostname they can't resolve and an IP they can't route to. The token is useless without network access.

Without Tailscale, the QR code is **single-factor**: one glance gives an attacker everything they need. No amount of encryption or auth hardening changes this — the secret is displayed on screen and the network path is open.

### TLS adds encryption (and the daemon handles it for you)

Once Tailscale is running, the daemon auto-provisions a Let's Encrypt cert for your Tailscale hostname on its next start (via `tailscale cert`) and re-issues it before expiry. This encrypts all traffic between your phone and the daemon, preventing even other tailnet members from reading your data in transit. You never have to run `brane certify` to keep things working — the command remains as a manual override.

The recommended setup:
```sh
brane daemon start   # First start with Tailscale up auto-provisions the cert.
                     # The daemon log records the issuance and every renewal.
                     # The one operator-side prerequisite is enabling "HTTPS
                     # for your tailnet" in the Tailscale admin console; the
                     # daemon log will point you there if it isn't already on.

# Connect your phone
brane meld           # Generates https://hostname.tailnet.ts.net/#token=...
```

With both Tailscale and TLS active, you get:
- **Isolation** — only your devices can reach the daemon
- **Encryption** — traffic is unreadable even if intercepted
- **Authentication** — 128-bit bearer token as a second factor

### Without Tailscale

Without Tailscale, `brane meld` emits `http://127.0.0.1:port` — a QR that is **safe to display in public** (a stranger photographing it points at their own loopback, where nothing is listening) but only usable from the same machine the daemon is running on. That's the deliberate tradeoff: cross-device reach requires a trust boundary, and Tailscale is the supported one. `brane meld` will not auto-advertise your LAN IP, because on a hostile network that QR would hand the bearer token to anyone on the same subnet (the RFC 1918 filter accepts all of them). If you need LAN reach on a trusted home network, pass `--host <ip>` explicitly with a matching `--bind` — that's an opt-in you make with knowledge of the network you're on.

**On public WiFi, no LAN-reachable flavor of meld is safe.** Tailscale is the only supported cross-device path.

## Mentions add an unlogged *push*

A narrative's log has never been a complete account of what shaped that session, and it was never designed to be. `narrative_search`, `narrative_info`, `list_peers`, reading another narrative through a multi-narrative cursor, protocol documents, and everything else in the terminal scrollback all reach an agent's context without appearing anywhere in its own log. Any of them can change what it does next.

What mentions add is not unlogged *influence* — that is the normal case — but unlogged influence a **third party initiates**. Every vector above is pulled by the agent: it decided to search, it decided to read. A mention is pushed, by someone else, and can resolve a parked `listen`. The one existing push, foreign narration, is unauthenticated within a brane but leaves an event in the recipient's history; a mention deliberately does not, because not writing into someone else's conversation is the entire point of the feature.

So the narrow new property is: **another narrative can act on X, and X's log will not show it.** That is worth knowing when reading a transcript to reconstruct why an agent did something.

It adds no new *authority*: anyone who can mention could already narrate into that narrative outright, which is louder. What it adds is a quieter channel, and the mitigations are correspondingly modest:

- The receipt carries **pointers, never prose** — `{id, src, seq, author, time}`. A mention cannot exfiltrate text across a brane boundary; the reader has to go and read the source narrative, through the same access it already had.
- Cross-brane mentions are allowed (the handle namespace is already brane-wide — `list_peers` has no `brane_id` filter, so blocking them would make an id you were just shown un-mentionable), but the receipt stamps `brane_id` when it differs, so a cross-brane wake is legible rather than unexplained.
- Handles resolve only to narratives that exist, and only outside code spans, fences, links and URLs — so a pasted log cannot be used to page an agent invisibly.
- A mention **never revives**. It cannot start a process; it waits for the operator.
- `mentions.enabled=false` disables recording entirely. You cannot hotfix a fleet of running agents, so the kill switch is not optional.

Surfacing mentions on the recipient's own timeline — so a transcript reader can see the push the log doesn't record — is not yet done.

## What brane doesn't protect against

- An attacker with root on your machine (nothing can)
- A process running as your Unix account, agents included: it can reach `daemon.sock` and act as this machine, or use tmux directly (see [Who the operator is](#who-the-operator-is)). An agent token's narrower scope stops an agent that follows the rules, not one that goes around it
- A compromised Tailscale account (same as any tailnet service)
- A hostile member of your own tailnet: a browser accepts daemons from its tailnet, and only from its tailnet (see [One tailnet per browser](#one-tailnet-per-browser))
- A compromised brane.organelle.dev deployment (use `--local` to eliminate this)
- Independent auditing of the upstream `tmux` build (the pinned SHA-256 guarantees you receive exactly the bytes brane vetted, not that those bytes were audited beyond trust-on-first-use)

## Dependency advisories

`npm audit` on the root package is clean, with and without dev dependencies: zero known vulnerabilities in anything the daemon or CLI installs or runs, and none in the build and deploy tooling (TypeScript, wrangler).

One of those zeros is held by an `overrides` entry in `package.json` (and in `expo/package.json`), which pins `katex` to a single copy. `micromark-extension-math` still declares `katex@^0.16`, which carries a low-severity prototype-pollution advisory; brane imports only that package's syntax extension and renders math through the top-level katex 0.18, so the nested copy is never loaded. npm applies overrides only to this repository's own install, so `npm install brane` still reports that one nested katex (as "3 low") until `micromark-extension-math` releases against katex 0.18. `stream-json`, which `brane absorb` uses to stream a ChatGPT export, is on the 3.x line for the same reason: the 1.x and 2.x lines carry a prototype-pollution advisory and two denial-of-service ones, all reachable only through the operator's own export file.

The Expo web app carries residual advisories (5 moderate, 23 high at last check), all inside the **build-time** toolchain — metro, jest, react-native's CLI — and all rooted in three packages that have no patched version: `braces` (stack exhaustion on deeply nested glob patterns), `node-forge` (an RSA signature-verification flaw, under expo's code-signing certificates), and `sprintf-js` (unbounded precision specifiers, under an old `argparse`). None of that code ships in the daemon, and none of it runs in the served web bundle; it runs on the developer's machine, on the project's own files, when producing the bundle. npm's only offered "fix" for each is a major downgrade of expo or react-native, which is not happening.

All of this is re-examined whenever expo or a root dependency is upgraded; if any of it grows a non-breaking fix, take it.

## The practical summary

Install Tailscale, start the daemon, then `brane meld`. The daemon auto-provisions and renews its TLS cert via Tailscale, so HTTPS is on by default once Tailscale is up. Your daemon is reachable only from your own devices, encrypted in transit, and authenticated by a 128-bit token. The attack surface is equivalent to running any other localhost service behind Tailscale — a well-understood and battle-tested security model.

On public WiFi, Tailscale is not optional — it **is** the security model.
