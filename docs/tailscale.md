# Tailscale, TLS and the Listeners

Tailscale is the condition the rest of brane's security model assumes,
not a feature beside it. The daemon's listeners, its certificate, the
address `brane meld` writes into a QR, and the fallbacks for machines
where Tailscale is awkward all follow from one decision: the only
cross-network path to a daemon is the tailnet. `SECURITY.md` is the
canonical threat model and [why-tailscale](../wiki/why-tailscale.md)
is the argument; this page is the mechanism, kept with the code it
describes.

The argument in two sentences, so the mechanism reads as a whole. A
tailnet address is unroutable from anywhere else, so the daemon's port
does not exist in a stranger's network topology: *unreachable*, not
*authenticated*, and the bearer token becomes a second factor rather
than the only gate. Without Tailscale the stack is reachable → encrypted
→ authenticated, the public internet's model, and every bug in the auth
path is the whole defense.

| Piece | Where | Does |
|---|---|---|
| Detection | `src/tailscale.ts` | `tailscale status --json`, 3 s timeout; the machine's MagicDNS name and tailnet IPs, or nothing |
| Listeners and filter | `startServer`, `src/daemon/server.ts` | binds loopback and tailnet addresses, never the LAN IP; a TCP-level filter on every accepted socket |
| Re-probing | `src/daemon/tailscale-rebind.ts` | keeps asking while blind, binds addresses as they appear |
| Certificates | `src/tls.ts`, `src/daemon/cert-manager.ts` | `tailscale cert` on first start, renewal, hot reload |
| HTTP fallback | `startServer` | plain HTTP on a second stable port, private addresses only |
| Meld's host | `buildMeldUrl`, `src/commands/meld.ts` | the tailnet name, else loopback; a LAN IP only by explicit `--host` |

## Detection never throws

`getTailscaleStatus` shells out to `tailscale status --json` with a 3 s
timeout and turns every failure into an empty answer: binary missing,
daemon stopped, not logged in, output malformed. "No Tailscale" is an
ordinary state the daemon runs in (loopback only), and a malformed answer
must look like that state, never like a crash. The sync reader is for
startup; the async twin (`getTailscaleIpsAsync`) is for the event loop,
because a wedged Tailscale extension blocks the sync form for its full
timeout, acceptable once, not every minute for the life of the daemon.

## What listens, and what the kernel refuses

By default the daemon binds `127.0.0.1`, `::1`, and whatever tailnet IPs
detection returned, typically one IPv4 in `100.64.0.0/10` and one IPv6
under `fd7a::/8`. The machine's LAN address is not in the list, so a
same-subnet port scan gets an RST from the kernel and no brane code runs.
A second line sits behind the first: `isAllowedConnection` drops any
accepted socket whose peer isn't loopback, one of this machine's tailnet
IPs, RFC 1918, or CGNAT (which is how tailnet *peers* are admitted: the
filter never enumerates them). `--bind <address>` is the operator's
override: one address, and the filter on the primary listener is off,
because the operator asked to hear from whatever the kernel lets
through. The HTTP fallback below keeps its filter regardless.

## A blind start is not a verdict

Startup asks Tailscale once. That is the right first move and the wrong
last one: on 2026-08-30 the extension hung for eleven hours while the
menu bar said "Connected", three daemon starts in a row logged "No
Tailscale detected", and the phone stayed locked out until the operator
happened to restart the daemon again (claude-9ya34xr8:13, :23). So the
daemon keeps asking. `nextProbeDelay` backs off from 5 s, doubling to a
60 s ceiling while nothing is found, and settles at 60 s once Tailscale
has been seen, which also catches a restart that came back with new IPs.
`addressesToBind` returns the probed addresses not yet bound, in
Tailscale's order, never one already held (rebinding our own listener
would throw `EADDRINUSE`). Each new address gets the HTTPS listener and,
when TLS is on, its HTTP fallback. `GET /api/status` reports
`listening_on`; an empty list means "this machine only". The policy is
pure so `src/test/tailscale-rebind.test.ts` can pin it without a clock.

## The certificate

`provisionTlsCert` (`src/tls.ts`) runs `tailscale cert <magicdns-name>`,
the same command `brane certify` runs by hand, and lands the pair at
`~/.brane/certs/` atomically. Its failure reasons are the operator's
diagnostic: `tailscale_missing`, `https_not_enabled` (the one that needs
the admin console: "HTTPS for your tailnet" must be on, and the daemon
log says so), `bad_host`, `timeout`, `invalid_output`.

`CertManager` (`src/daemon/cert-manager.ts`) owns the promise that an
operator with Tailscale running never runs `brane certify` to keep
HTTPS up:

- **Startup:** ensure a valid cert exists at the canonical path, provisioning one if it is missing or expired.
- **Renewal:** check hourly; renew when fewer than 30 days remain on the 90-day issuance. A failed renewal backs off 1 h, 2 h, 4 h, 8 h, 24 h and stays there; the old cert keeps serving until it actually expires.
- **Hot reload:** `fs.watch` on the cert file, debounced 200 ms (a rename emits several events), and every bound HTTPS server gets `setSecureContext`. No restart, whether the manager renewed or the operator ran `brane certify`.
- **State:** `disabled` (no Tailscale: HTTP only, and that is fine), `valid`, `renewing`, `failed`, with expiry, next attempt and last error. Surfaced on `GET /api/status`, pushed to the app, printed by `brane daemon status`.

The cert is valid for the MagicDNS name and nothing else, which is why
`brane meld` advertises `https://` only when the host it is about to
write *is* that name (`useTls = tls && host === tailscaleHost`); any other
host gets `http://`, and the result says `tlsDegraded` when TLS was
available but could not be used for the host chosen.

**Why not `tailscale serve`.** Tailscale's own reverse proxy would have
been one shell command and no code (claude-c11142c9:6). The daemon
terminates TLS itself so it owns the cert lifecycle, reports its state,
and behaves identically whether or not `serve` is running on the
machine (claude-c11142c9:7, :9, :10).

## The HTTP fallback

With TLS on, a client that reaches the daemon by IP rather than by name
would hit a hostname mismatch, so the daemon also serves plain HTTP on a
second port, one per bound address. That port is stored as
`daemon_http_port` and deliberately survives restarts, so a meld URL
written against it stays good. The fallback is always behind the
private-address filter, even under `--bind`, and its WebSocket upgrades
are handed to the main server's handler, so the terminal mirror and the
MCP bridge work over either transport. Without TLS there is one HTTP
listener and the ordinary filter.

## Meld's host, and why the LAN is never advertised

`buildMeldUrl` prefers the Tailscale DNS name; with none it uses
`127.0.0.1` and marks the result `isLoopbackFallback`, which `brane meld
--remote` reads as "the remote machine has no Tailscale name yet: wait".
It never picks a LAN IP on its own. The reason is the coffee-shop camera
(SECURITY.md, "The meld QR is safe to display in public"): a photographed
QR with a LAN host and a token is complete access from the next table,
and the same photograph with a tailnet host is a name the stranger
cannot resolve and an address they cannot route to. The daemon keeps
only the token's hash, a minted token lapses if nobody scans it, and
each device gets its own, but none of that would make a LAN URL safe to
show. An operator on a trusted home network can pass `--host <ip>`, an
opt-in made with knowledge of the network; `--local` points the link at
the daemon's own bundle instead of the shared app. The earlier design
fell back to the LAN IP with a warning (claude-4a56879c:36) and was
tightened to this (claude-b94e87ea:3).

## Where Tailscale is awkward

- **Cloudflare WARP on a work laptop.** WARP and Tailscale are both
  WireGuard and compete for macOS's single Network Extension slot
  (claude-f49ec493:4). Tailscale's userspace networking avoids the kernel
  tun device entirely: `tailscaled --tun=userspace-networking`, or for the
  Mac app `defaults write io.tailscale.ipn.macos UserspaceNetworking
  -bool true`. Subnet routes and exit nodes stop working; direct
  device-to-device connections, which is all brane needs, keep working.
  The alternatives are WARP split tunneling (exclude `100.64.0.0/10` and
  Tailscale's coordination addresses; needs an admin) or a Cloudflare
  Tunnel, which would put a relay in the path and is not supported.
- **Containers and cloud machines.** The Fly and exe.dev images run
  userspace networking too, and `tailscaled`'s socket is not always ready
  when the entrypoint runs `tailscale up`, so the entrypoint retries. A
  Fly volume carries the Tailscale state along with the database, so a
  machine destroyed and recreated keeps its node identity and its meld
  URLs (claude-70589c55:495). The recipes are /fly and /exe.dev.
- **Sandboxes.** macOS sandboxes block `/Library/Tailscale/` unless a
  hole is punched (organelle-dbff7e6b:13).

## What you are trading for

Tailscale is a proprietary overlay run by a company. Brane inherits its
availability, its breach model, and its willingness to keep offering the
service; a compromised Tailscale account is "game over regardless of
brane" (SECURITY.md, "What brane doesn't protect against"). When
Tailscale is unavailable, brane degrades to this machine: agents run,
the data stays, the pages render, and the daemon is reachable from
nowhere else until it is back. A cloud-hosted brane cannot survive it at
all: no tailnet, no route.

## Tests that pin it

| Test | Pins |
|---|---|
| `src/test/tailscale-rebind.test.ts` | the backoff schedule and that bound addresses are never rebound |
| `src/test/cert-manager.test.ts` | the renewal window, the backoff, and the hot reload on a replaced file |
| `src/test/meld.test.ts` | the host preference, the `useTls` gate, `--local` and `--app` |
| `src/test/remote-meld.test.ts` | the loopback-fallback "wait" on a remote machine with no tailnet name |
