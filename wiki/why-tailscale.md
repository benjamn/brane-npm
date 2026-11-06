# Why Tailscale

> The mechanism — certificate provisioning and renewal, the listeners
> and their re-probing, the HTTP fallback, meld's host preference —
> is documented in [docs/tailscale.md](../docs/tailscale.md), which
> is kept with the code. This page is the argument.

Tailscale is not incidental plumbing for brane. It is the condition
that makes the rest of the architecture possible. The operator's own
crystallization, from early in brane's design:

> *"Seems like only Tailscale gives me the property that only my
> devices can see and communicate with each other"* [claude-0c9d425b:7]

And the design decision that followed:

> *"Let's keep Tailscale as the only way to network across networks,
> and set up wrangler/etc in a worker/ subdirectory"* [claude-2bbef092:11]

The daemon holds the record of every agent's narration, the live
terminal of every session, and a bearer token that grants all of it.
The only cross-network path to any of that is Tailscale. Everything
else brane does on top of it — TLS, bearer tokens, the TCP-level IP
filter — is hardening *inside* the Tailscale perimeter.

## Invisibility, not authentication

The claim the operator landed on — and that SECURITY.md now codifies
(SECURITY.md "Tailscale provides network-level isolation") — is
sharper than "Tailscale encrypts your traffic." Tailscale gives you **network-level isolation**. The agent
formulation that stuck [claude-0c9d425b:8]:

> *"Tailscale gives you network-level isolation — other devices
> literally cannot route packets to your Tailscale IP. It's not just
> encryption; it's invisibility. Your daemon's port doesn't exist in
> their network topology."*

This is not a pedantic distinction. "Authenticated" means an attacker's
packets reach your process and are rejected there; any bug in your auth
code is a vulnerability. "Invisible" means the packets never arrive.
Bugs in auth code become a second line of defense instead of the only
one. The stack without Tailscale is *reachable → encrypted →
authenticated* — the same model as the public internet. The stack
*with* Tailscale is *unreachable → done* [claude-0c9d425b:8].

At the implementation level the daemon belt-and-suspenders this. First,
the listen sockets themselves are bound only to `127.0.0.1`, `::1`, and
the machine's detected Tailscale IPs — the LAN IP is never in the list
unless the operator asks for it explicitly with `--bind`. Same-subnet
port scans get RSTs from the kernel; no HTTP or WebSocket code runs for
a LAN connection attempt. Second, a TCP-level connection filter drops
anything that does reach a socket and isn't localhost, RFC 1918
(10/8, 172.16/12, 192.168/16), link-local (169.254/16), CGNAT
(100.64.0.0/10) — the range Tailscale addresses live in — or one of
the machine's own Tailscale IPs (`buildPrivateIpFilter` /
`isAllowedConnection` in `src/daemon/server.ts`, SECURITY.md
"Network isolation by default"). Remote tailnet peers are admitted by
the CGNAT rule; the filter does not enumerate peers. But these two
are backstops. The actual isolation is in Tailscale's routing model.

## The QR-code argument

`brane meld` displays a QR code containing the daemon's URL and a
bearer token minted for that one device (`src/commands/meld.ts`; the
daemon keeps only its hash, and a QR nobody scans lapses). That's a convenience for
onboarding a phone in one scan — and it's the feature that most visibly
depends on Tailscale being the trust boundary. The exchange that
produced SECURITY.md's two-factor framing [claude-0c9d425b:10]:

> *"In a coffee shop, someone two tables over photographs your screen,
> and they have `http://192.168.1.x:port/?token=<full-token>`. That's
> complete access — no brute force, no sniffing, just a camera.*
>
> *With Tailscale, the same photograph gives them
> `https://hostname.tailnet.ts.net/?token=...` — a hostname they can't
> resolve and an IP they can't route to. The token is useless without
> network access. Two-factor by construction: something you know (token)
> + somewhere you are (tailnet)."*

Without Tailscale, the QR code is **single-factor**: one glance gives
an attacker the hostname and the token, and the network path is open
(SECURITY.md "Without Tailscale", claude-0c9d425b:10). The token travels in cleartext
on the same LAN that any coffee-shop patron shares. No
cryptographic primitive in brane changes this; it is a property of how
the secret is presented (visually, all-at-once) and what networks are
reachable (everyone on the subnet).

This argument was the one that flipped the README and SECURITY.md into
their current shape [claude-0c9d425b:11,13]. *"On public WiFi, Tailscale
is not optional — it **is** the security model"* (SECURITY.md "The
practical summary", claude-0c9d425b:10) is the summary both documents
now end with.

## Free TLS for a real hostname

The second stubborn problem in "run a daemon at home, reach it from my
phone" is that browsers don't like plain HTTP for anything that uses
secure cookies, clipboard APIs, service workers, or WSS upgrades — and
self-signed certs are a warning-click deterrent that trains users to
ignore warnings. A real cert for a real hostname is the only clean
answer.

The daemon solves this by shelling out to `tailscale cert` itself,
which mints a Let's Encrypt cert for the machine's Tailscale hostname
(`<host>.<tailnet>.ts.net`) (`src/tls.ts`, `src/daemon/cert-manager.ts`,
SECURITY.md "TLS adds encryption"). On first start it provisions a fresh cert; while
running, it renews automatically when fewer than 30 days remain and
hot-reloads via `https.Server#setSecureContext` — no operator action,
no daemon restart. The `brane certify` CLI still works as a manual
escape hatch but is no longer part of normal setup. The hostname is a
real public DNS name with a real public cert — even though the IP it
resolves to is only routable inside your tailnet. You get a green-lock
HTTPS connection without running a public-facing server, without a
domain registrar, and without configuring ACME clients by hand.

### Why not `tailscale serve`

An earlier design proposed using Tailscale's built-in reverse proxy
(`tailscale serve`) instead of native TLS in the daemon
[claude-c11142c9:6]. That approach was cleaner on paper — zero code
changes, one shell command — but was ultimately passed over in favor
of native TLS so the daemon owns the cert lifecycle directly and works
identically whether or not `tailscale serve` is running
[claude-c11142c9:7,9,10]. The daemon checks `~/.brane/certs/tls.crt`
at startup, provisions one via `tailscale cert` if it's missing, and
flips to HTTPS once a valid cert is on disk
[`src/daemon/cert-manager.ts`, claude-c11142c9:10].

### Hostname-only, by design

The cert is valid for the Tailscale DNS name and nothing else. `brane
meld` enforces this: it prefers the Tailscale hostname and only
advertises `https://` when the hostname it's about to use **is** the
Tailscale hostname (the `useTls` gate in `src/commands/meld.ts`,
claude-019f721c:17,19). Certs on disk alone are not enough — the host
has to match, or meld falls back to HTTP.

When TLS is active, the daemon keeps a private-IPs-only HTTP fallback
port open for local and LAN clients that can't use the hostname
(SECURITY.md "Dual HTTP + HTTPS when TLS is available"). TLS for
Tailscale, plain HTTP for same-subnet convenience, no manual switch.
WebSocket upgrades on the HTTP server are forwarded to the main
server's handler so terminal streaming and MCP work on either
transport (same section).

## Volumes as Tailscale identity

The cloud-deploy path — `brane fly` — leans on Tailscale harder than
any other surface. (`brane fly` was retired in #582; its verbs are now
the /fly recipe, e.g. `/fly down`, and `src/commands/fly.ts` is gone.) The architecture note from the Fly build arc
[claude-70589c55:495, claude-e99276df:5]:

> *"Volumes are the persistent identity. Each volume holds the SQLite
> DB (all narrative history), Tailscale state, auth tokens, TLS certs,
> and MCP config. Machines are fully disposable — `fly down` destroys
> them, `fly up` recreates them with the same hostname, port, and
> token. Meld URLs survive indefinitely across down/up cycles."*

Tailscale state on the volume is what makes this work. When `fly down`
destroys a machine, the volume persists; when `fly up` brings a new
machine back to the same volume, `tailscaled` resumes with the same
node identity — no re-authorization required [claude-02cc27ea:132]. The
meld URL the operator's phone scanned last week still works this week,
in a different datacenter, against a different physical machine.

Concrete implementation details that protect this property:

- **Graceful `tailscale down` before destruction.** `brane fly down`
  shells into each machine and runs `tailscale down` before Fly kills
  it, so the node leaves the tailnet cleanly instead of going dark
  (`brane fly down` in `src/commands/fly.ts`, claude-bc167555:132). Without
  this, nodes show "offline" in the admin console until they expire
  or are cleared manually [claude-02cc27ea:177,178] — cosmetic, but
  the kind of grit that compounds.
- **Region-tagged hostnames.** `FLY_REGION` gets appended to the
  Tailscale hostname (`brane-5a04ec-sjc`, `brane-5a04ec-ewr`, etc.) so
  a global fleet coexists in one tailnet without collisions
  [claude-70589c55:495].
- **A single reusable auth key.** One `TS_AUTHKEY` Fly secret is
  shared across all machines in the app; new regions join the tailnet
  automatically on first boot [claude-70589c55:332]. No per-machine
  provisioning step.
- **No ports exposed.** Fly machines don't expose any ports publicly.
  The only way in is Tailscale [claude-70589c55:15]. Bind-on-zero
  works because nothing routes to the machine except over the
  tailnet.

The net effect is that a global brane fleet parked at zero cost — four
regions idle, meld URLs memorized by the operator's phone — is
something Tailscale identity on a persistent volume makes possible at
all. Not a convenience: a precondition.

## The pre-brane lineage

Tailscale-as-trust-boundary predates brane. The organelle era (the
predecessor narrative base) had already articulated a six-layer defense
stack with Tailscale as Layer 1 [organelle-dc62127a:14,49]:

> *"Layer 1 — Network Isolation (Tailscale). Remote access requires
> Tailscale VPN. The server binds HTTPS to 0.0.0.0 but only devices on
> your Tailscale tailnet can reach it. No public internet exposure."*

Earlier still, a ChatGPT-era thread framed the cross-host protocol in
Tailscale terms from the very start [chatgpt-a48bcfc0:49]:

> *"Local SQLite nodes come into contact with each other via
> Tailscale"*

And the organelle design thread [organelle-65f599f5:3-13] treated the
whole project as *"Tailscale-based mesh discovery and communications"*
— Tailscale was the substrate, not an add-on. Brane inherited this
framing; it did not invent it. When SECURITY.md says *"Tailscale is
the trust boundary,"* it is restating a position the operator has held
across three generations of the system.

## Graceful when absent

The code is disciplined about not requiring Tailscale. `src/tailscale.ts`
shells out to `tailscale status --json` with a 3-second timeout and
catches anything that fails — Tailscale missing, stopped, or
unauthenticated all degrade to an empty result rather than an error.
Callers fall through to private-IP-only operation with a warning
recommending Tailscale for remote access (`src/daemon/server.ts`).

The original directive allowed meld to silently fall back to the
LAN IP with a warning [claude-4a56879c:36]:

> *"Yes I want meld to work without Tailscale, but perhaps print a
> warning"*

That position was later tightened [claude-b94e87ea:3]: the LAN-IP
fallback was itself the coffee-shop camera's target. Meld now refuses
to auto-advertise an address reachable by anyone on the same subnet.
The non-Tailscale path is no longer a LAN convenience — it is strictly
a same-machine fallback [claude-0c9d425b:5]:

> *"This is trivially/provably solved if I have Tailscale turned on,
> so that's not the solution I'm asking about now"*

Meld's host preference is now: Tailscale DNS hostname if present, else
`127.0.0.1` (`src/commands/meld.ts`). An operator who wants to
advertise a LAN IP on a trusted home network can pass `--host <ip>`
explicitly — an opt-in made with knowledge of the network. The daemon
has no origin allowlist: the token is the credential, and which origin a
device runs the app from is recorded on its token rather than judged
(`SECURITY.md`, Authentication). None of this requires a flag or an env
var; if Tailscale is running, brane uses it.

## The WARP escape valve

The most common real-world collision is Cloudflare WARP on a work
laptop. Both WARP and Tailscale are WireGuard-based and compete for the
macOS Network Extension slot, which allows only one VPN at a time
[claude-f49ec493:4]. Three paths around it, recorded from the
conversation that worked through them:

- **Tailscale userspace networking** — `tailscaled
  --tun=userspace-networking`, or on the macOS app, `defaults write
  io.tailscale.ipn.macos UserspaceNetworking -bool true`. Avoids the
  kernel tun device entirely; subnet routing and exit nodes don't work
  but direct device-to-device connections do, which is exactly what
  brane needs [claude-f49ec493:4,6].
- **WARP split tunneling** — exclude the Tailscale CGNAT range
  (`100.64.0.0/10`) and Tailscale's coordination IPs from WARP's
  tunnel. Requires admin cooperation [claude-f49ec493:4].
- **`cloudflared tunnel`** — if Tailscale truly can't run, Cloudflare
  Tunnel is a functional alternative for "reach my daemon from my
  phone." It needs a Cloudflare account and some brane changes to
  origin/auth handling, but is workable [claude-f49ec493:4].

Userspace networking is the path brane deploys assume is available;
the Fly image uses it explicitly [claude-70589c55:15].

## What you are trading for

Tailscale is a proprietary overlay network operated by a company.
Brane's security posture inherits that company's availability, its
breach model, and its willingness to keep offering the service.
SECURITY.md's threat list calls this out explicitly: a compromised
Tailscale account is *"game over regardless of brane"* (SECURITY.md
"Tailscale as the trust boundary" and "What brane doesn't protect
against"). Brane cannot and does not try to defend against it.

The practical version: if Tailscale becomes unavailable, brane
degrades to LAN-only. Your agents still run, your data is still local,
your wiki pages still render. You just can't reach the daemon from the
coffee shop until you're home again. For a local-first tool this is an
acceptable failure mode — but it is worth naming, because the cloud
path (`brane fly`) cannot survive it at all: no Tailscale means no
route to the Fly machine.

There is also the operational question of running Tailscale itself.
Sandboxes block `/Library/Tailscale/` on macOS unless you punch a hole
through [organelle-dbff7e6b:13]; certain containers need
`--tun=userspace-networking` [claude-70589c55:15]; early fly deploys
discovered that `tailscaled`'s socket isn't always ready when the
entrypoint runs `tailscale up` and needed a retry loop [claude-70589c55:495].
These are real costs; they're smaller than the alternatives.

## The practical summary

Install Tailscale, start the daemon, run `brane meld`, scan the QR
code. The daemon provisions and renews its TLS cert on its own. What
you get is a service that is invisible to the LAN,
encrypted in transit, authenticated by a token no one else can
transmit, reachable only from your own devices — and no cloud backend
holds any of it (SECURITY.md "The practical summary"). The same
invocation works for a
Fly-deployed brane machine on another continent, because the tailnet
is where "reachable" is defined.

SECURITY.md's bottom line (its closing sentence), which this page is a
longer-form version of:

> *"On public WiFi, Tailscale is not optional — it **is** the security
> model."*

Everything brane does to harden the daemon (TCP-level IP filter,
256-bit bearer token, stored as a hash, TLS on the hostname) is hardening
that assumes the network path is already narrowed. Tailscale is what
narrows it.

## Related

- [sequestering the narrative](shared/sequestering-the-narrative.md) — the
  narrative is set apart from other agents' contexts by code;
  Tailscale sets it apart from other networks' devices by routing.
  The two separations compose.
- [`SECURITY.md`](../SECURITY.md) — canonical threat model. This page
  distills the Tailscale-specific argument; the rest lives there.

---

*Candidate future pages this one would link to (ontology call is yours):*
*`brane-fly.md`, `brane-meld.md`, `brane-certify.md`,*
*`cgnat.md`, `public-wifi-threat-model.md`,*
*`tailnet-as-trust-boundary.md`.*
