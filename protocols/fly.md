# /fly [init|new|deploy|up|sleep|wake|down|meld|status|logs|destroy]

Running brane daemons on Fly.io machines, reached over Tailscale.
**Experimental.** It needs a tailnet you administer and an authenticated
`fly` CLI (`fly auth whoami`).

Bare /fly means this protocol. `/fly <verb>` asks for that verb's
section below; follow its steps with plain `fly` commands. There is no
`brane fly` subcommand. Brane supplies only the image (`Dockerfile`,
`docker-entrypoint.sh`, shipped in the package) and `brane meld --remote`.
Nothing here is specific to brane's CLI except that one command, so the
same steps adapt to any host that runs a container.

Every verb except `status` and `logs` changes something on Fly, and some
cost money. Say what you're about to run and get the operator's go before
running it.

## Mental Model

**Stop, not destroy.** Hosts sleep, narratives don't (`docs/sleep.md`):
a machine that isn't wanted is *stopped*, its volume attached and its
sessions on disk, and the next wake brings them back.

| Verb | What it does |
|------|--------------|
| `sleep` | Stop a machine. The daemon's own exit; the app's Sleep act; or `fly machine stop` from outside. |
| `wake` | Start a stopped machine. Wake in the app's ⋯ (`https://<app>.fly.dev/wake`), or `fly machine start`. |
| `deploy` | Build and push the image; update existing machines, never create or start one. |
| `up` | Provisioning: the app's one machine, in the region of its volume, reattaching it. |
| `down` | Provisioning: destroy the app's machine. Its volume is preserved. |

**Sleep and wake are the daily verbs.** `up` and `down` create and
destroy machines, and are for when the fleet's shape changes, not for
the end of a day.

Sleep is the daemon's elective exit: it narrates, writes
`~/.brane/sleep-manifest.json`, takes the node off the tailnet
(`tailscale down`) and exits 0, and Fly leaves the machine stopped (see
`[[restart]]` below). It happens when the operator taps Sleep, or
automatically when the host has had no sessions for
`BRANE_SLEEP_IDLE_MINUTES` after its last client left. Wake is
necessarily from outside, since nothing on a stopped machine runs: Fly
Proxy starts the machine when a request arrives for its wake port.

What a stopped machine costs ([pricing](https://docs.fly.io/about/pricing)):
no compute; its root filesystem at $0.15/GB/month (the image is about
2 GB, so about $0.30 a month); and the 10 GB volume at $1.50 a month,
which is billed whether the machine runs, stops or doesn't exist.

Volumes are the source of truth: each represents a region the operator
committed to, and machines come and go around them. One region is one
app with one volume and at most one machine ([One app per
machine](#one-app-per-machine)).

Each machine runs **tailscaled** (its only network access) and a **brane
daemon**. The volume is mounted at `/home/brane`, the whole home
directory, so `~/.brane` (database, certs, payloads), `~/.claude`, agent
configs and git state all persist. The embedding model is baked into the
image at `/opt/brane/models`, outside the volume.

## Shared values

- **The app name** is remembered in brane config:
  `APP=$(brane config fly.app)`. `init` sets it.
- **The install directory**, where the `Dockerfile` and entrypoint live:
  ```bash
  BRANE_ROOT=$(node -e 'const p=require("path"),fs=require("fs");console.log(p.resolve(fs.realpathSync(process.argv[1]),"../.."))' "$(command -v brane)")
  ```
  That needs `brane` on `PATH`. Without it (`npx brane`), the install
  directory is the one above `dist/cli.js`.
- **The wake URL**: `https://$APP.fly.dev/wake`. It answers only once the
  operator has allocated a public IP ([/fly init](#fly-init), step 4).
- **The `fly.toml`**, written beside the image's files (`<app>` is `$APP`):
  ```toml
  app = "<app>"
  primary_region = "sjc"
  kill_timeout = 120

  [build]
    dockerfile = "Dockerfile"

  [[mounts]]
    source = "brane_data"
    destination = "/home/brane"

  [http_service]
    internal_port = 8080
    auto_start_machines = true
    auto_stop_machines = "off"
    min_machines_running = 0

  [[restart]]
    policy = "on-failure"
    retries = 3

  [env]
    TS_HOSTNAME = "daemon-<app>"
    BRANE_SLEEP_IDLE_MINUTES = "15"

  [[vm]]
    size = "performance-1x"
    memory = "2gb"
  ```
  Line by line ([fly.toml reference](https://docs.fly.io/reference/configuration),
  [autostart/autostop](https://docs.fly.io/launch/autostart-stop)):
  - `kill_timeout = 120`: when Fly stops a machine from outside (`fly
    machine stop`, a deploy's update) it sends `SIGINT` and waits this many
    seconds (default 5, max 300) before killing it, time for the daemon's
    own clean shutdown.
  - `[http_service]` is the **wake door**, nothing more. Fly Proxy
    terminates TLS on 443 and routes to `internal_port`, where the image
    runs a separate listener (`dist/fly/wake-listener.js`) that answers
    `GET /wake` with 200 and which machine it is on
    (`{"machine": …, "region": …}`) and everything else with 404. It is never the
    daemon's port: the daemon runs under `--bind 0.0.0.0`, where it has no
    IP filter, and stays reachable only over Tailscale.
  - `auto_start_machines = true`: a request for the app starts a stopped
    machine and is routed to it. That's the wake. The proxy chooses the
    machine, and prefers one already running, which is why an app holds
    exactly one ([One app per machine](#one-app-per-machine)).
  - `auto_stop_machines = "off"`: the proxy never stops a machine. It
    couldn't judge: all real traffic goes over Tailscale, so the proxy sees
    none, and `"stop"` would put every machine to sleep minutes after it
    woke. Stopping is the daemon's.
  - `min_machines_running = 0`: no machine has to be running. Fly ignores
    it unless `auto_stop_machines` is `"stop"` or `"suspend"`; it's written
    so nobody wonders.
  - `[[restart]] policy = "on-failure"`: Fly restarts a machine only when
    its process exits non-zero. A daemon going to sleep exits 0, which
    leaves the machine stopped; a crash restarts it, up to `retries`
    times. This is Fly's default, written out because sleep depends on it:
    `"always"` would turn every sleep into a reboot.
  - `TS_HOSTNAME`: the entrypoint appends the region, so a machine's
    tailnet name is `daemon-<app>-<region>`.
  - `BRANE_SLEEP_IDLE_MINUTES`: the one automatic sleep. A host with no
    sessions sleeps this many minutes after its last client disconnects.
  - **No `[checks]`**, on purpose. A health check that fails while
    tailscaled is still reconnecting lets Fly declare a slow boot dead.
    The image's `HEALTHCHECK` is Docker's and Fly ignores it.

## One app per machine

An app holds exactly one machine, and a fleet is one app per region,
named `brane-<region>-<16 hex>` (`brane-nrt-…`). Two things in Fly act on
the app, not the machine, and both went wrong with four machines in one:

- **The wake URL.** `https://<app>.fly.dev/wake` reaches whichever
  machine Fly Proxy picks, and it picks a running one first. With ewr
  awake, a Wake for ams, lax or nrt was answered by ewr in under 100 ms
  and started nothing (measured 2026-11-25). A browser can't send
  `fly-force-instance-id`.
- **Secrets.** `fly secrets set` restarts every running machine of the
  app, so one remote meld restarted the fleet.

`brane config fly.app` holds one name, the app the next command is for;
with several, name the app in each command (`fly apps list` shows them).
`up` therefore never scales an app past one machine: a second region is
a second `init`.

## /fly init

One-time setup.

1. Create the app and remember its name. The name is the only secret
   the wake door has (`<app>.fly.dev`), so it gets 64 random bits:
   ```bash
   APP=brane-$(openssl rand -hex 8)
   fly apps create "$APP" --org <org>
   brane config fly.app "$APP"
   ```
2. Give it its secrets. `ANTHROPIC_API_KEY`, and a Tailscale credential
   (see [Tailscale](#tailscale)). The operator sets secrets themselves,
   `fly secrets set NAME=… -a "$APP"`, so no secret passes through an agent.
   `TS_CLIENT_ID` is not a secret.
3. Run [/fly deploy](#fly-deploy). With no machines it only builds and
   registers the image.
4. **Open the wake door: the operator's deliberate act**, never an
   agent's default. Without a public IP the proxy has no address to
   answer on, and the machine can be woken only by `fly machine start`
   from a shell. A shared IPv4 and IPv6 are free
   ([pricing](https://docs.fly.io/about/pricing)). Take both: the IPv4
   is the one every network reaches (plenty of cellular and hotel
   networks have no IPv6), and `<app>.fly.dev` answers on whichever the
   client asks for:
   ```bash
   fly ips allocate-v4 --shared -a "$APP"
   fly ips allocate-v6 -a "$APP"
   ```
   What it exposes, in plain words: anyone who knows the hostname can
   start the machine, and each such start costs minutes at the running
   rate until the idle rule puts it back to sleep. They reach only the
   wake listener, which says which machine it is or 404; the daemon is
   not behind it.
   An app named before this step existed (`brane-` and 6 hex digits) has
   a door anyone patient could find; whether to open it is the
   operator's call.
   `fly ips list -a "$APP"` shows the door, and `fly ips release <ip>
   -a "$APP"` (each address) takes it off.

Then `/fly new` for the app's region. Another region is another app:
run `init` again with that region in the name.

## /fly new

Give the app its region: create its one 10 GB volume. No machine yet;
`/fly up` starts it. First check one isn't there already, since an app
with a volume has its region and gets no second:

```bash
fly volumes list -a "$APP"
fly volumes create brane_data --region <region> --size 10 --yes -a "$APP"
```

## /fly deploy

Build the image on Fly's remote builder from this install, and update
existing machines. `--update-only` means it **never creates machines**,
so it's safe while scaled to zero; the next `/fly up` uses the new image.
`--no-public-ips` keeps it from allocating addresses on its own: the wake
door opens only by [/fly init](#fly-init)'s step 4.

```bash
CTX=$(mktemp -d)
cp "$BRANE_ROOT/Dockerfile" "$BRANE_ROOT/docker-entrypoint.sh" "$CTX/"
(cd "$BRANE_ROOT" && npm pack --pack-destination "$CTX")
# write the fly.toml above into "$CTX/fly.toml"
(cd "$CTX" && fly deploy --update-only --no-public-ips -a "$APP")
```

`fly` may print `Process groups have changed. This will: create 1 "app"
machine` on an app with no machines; `--update-only` still creates none.

**Before an app's first `/fly up`, pin the image by digest.** A deploy
registers its image by tag (`registry.fly.io/<app>:deployment-…`), and
creating a machine from that tag can fail with `MANIFEST_UNKNOWN`. On
2026-11-26 that happened six times in a row, over several minutes and
two deploys, for a new app's first machine (ams), although a tag had
updated nrt's existing machine the day before. Put a digest in `[build]`
in place of `dockerfile`, and deploy again, which builds nothing:

```toml
[build]
  image = "registry.fly.io/<app>@sha256:<64 hex>"
```

What has worked is **a digest that already sits in another app's
registry**. lax's and ewr's first machines both came up on the first
try, minutes after their apps were made, from ams's digest, so one
build can serve every region. The deploy's build output names the
digest, in its `pushing manifest for …@sha256:…` line. The other form,
an app's own digest pinned right after its first push, is untried:
ams's own digest worked, but only 15 hours later, so pinning and the
wait can't be told apart. If it fails, pin another app's digest. Put
`dockerfile = "Dockerfile"` back for the next build.

**A deploy doesn't start a stopped machine** (and exits 0 all the same):
a sleeping machine gets the new image on its next wake. A running one is
restarted onto it, through the same `SIGINT` and `kill_timeout` as
`fly machine stop`.

## /fly up

The app's one machine, in the region of its `brane_data` volume. Always
name the region, and never a count above 1 or a list of regions: `fly
scale count` can stack machines in one region and create stray volumes,
and a second machine breaks the wake URL.

```bash
fly volumes list -a "$APP" --json   # the app's one brane_data volume, and its region
fly scale count 1 --region <region> --yes -a "$APP"
```

A running machine is left alone, and so is a stopped one: an app
whose machine is asleep needs [/fly wake](#fly-wake), not `up`. Watch
the first boot with `/fly logs`: the machine is ready once its daemon
logs `listening on`.

## /fly sleep

The normal paths need no shell: the app's **Sleep** act, or the idle
rule (`BRANE_SLEEP_IDLE_MINUTES`, in the `fly.toml`), each of which has
the daemon narrate, write its manifest, leave the tailnet and exit 0.

From a shell, the outside hand, for a daemon that is wedged or for
stopping a machine without the app:

```bash
fly machines list -a "$APP"            # the started ones
fly machine stop <id> -a "$APP"
```

Fly sends the daemon `SIGINT` and waits up to `kill_timeout` (120 s)
before killing it. The machine stays stopped, its volume attached.

Every sleep ends every tmux session on the machine before the daemon
exits, including one started by hand over `fly ssh console`. Only
narratives' sessions hold the host awake or come back on wake.

To restart the daemon on a machine, restart the machine (`fly machine
restart <id> -a "$APP"`); `brane daemon restart` is refused there,
since the daemon is the machine's main process.

## /fly wake

The normal path is the app's **Wake** button, which fetches the wake URL.
From a shell, either:

```bash
curl -s "https://$APP.fly.dev/wake"   # {"machine":"…","region":"…"} once up
fly machine start <id> -a "$APP"
```

`fly machine start` picks a machine by id. The URL can't: Fly Proxy
sends the request to a machine of the app that is already running if
there is one, and starts a stopped one, the nearest to the caller, only
when none is. So the URL means a particular machine only when the app
holds one machine ([One app per machine](#one-app-per-machine)); the
answer's `machine` says which one took it. When it was a sibling, the
app's Wake reads that and names the machine that answered, rather than
reporting a wake. Without a public IP (see
[/fly init](#fly-init), step 4) the URL fails and only `fly machine
start` works.

The answer means the machine is running, not that the daemon is ready: a
wake costs a whole boot (tailscaled rejoining, the daemon starting)
before the app can reach it. The agents the last Sleep recorded come
back only when the app connects, so a `curl` or a stranger's wake
starts none of them. Measured on a
`performance-1x` in ewr: the answer in about 2 s, the daemon listening about
4 s after the request, and a revived agent back in its loop about 10 s
after that. `/fly logs` shows `listening on` when the daemon is up.

## /fly down

Destroy all machines; volumes and their data survive. Usually
[/fly sleep](#fly-sleep) is what's wanted: a stopped machine costs about
$0.30 a month more than none, and only a machine that exists can be
woken from the app. Destroy when a region is retired for a long while,
or to recreate machines from scratch with `/fly up`.

Take each machine off the tailnet first: stale WireGuard state on the
volume breaks some peers (iOS especially) on the next start. A daemon
that went to sleep on its own already ran `tailscale down`, so stopped
machines need nothing. Only a running machine whose daemon is wedged
needs it by hand:

```bash
fly machines list -a "$APP"          # the started ones
fly ssh console -a "$APP" --machine <id> -C "tailscale down"   # only if wedged
fly scale count 0 --yes -a "$APP"
```

## /fly meld

Connect a device to a machine's daemon. The machine can't show a presence
prompt, so the device token is minted by the operator's own daemon, after
Touch ID (or the platform's prompt) on their machine, and the remote gets
only its hash. **The operator runs this, not an agent**: it prints the
token in the QR and URL, and an agent's session is refused. Hand them the command with the app's name written in, since
their shell has no `$APP`:

```bash
brane meld --remote \
  --send "fly secrets set BRANE_DEVICE_TOKEN_SHA256={hash} -a <app>" \
  --ask  "fly ssh console -a <app> -C 'gosu brane brane meld --connection'"
```

Wake the machine first ([/fly wake](#fly-wake)): setting a secret
doesn't start a stopped machine, and `--ask` needs one running.

1. `--send` sets the secret, which restarts **every** running machine of
   the app, agents and all, not only the one being melded (another reason
   an app holds one machine); each
   daemon adopts the hash as a device row as it starts, once (a hash it
   has ever seen, revoked or not, never comes back), and drops the
   variable.
2. `--ask` reads back the daemon's address (`brane meld --connection` mints
   nothing), retrying for 3 minutes, and the QR is printed.

Like every QR it lapses if nobody scans it within 10 minutes of the
restart; run it again for a fresh one. More devices are best added from
the app's Meld sheet, which needs no restart.

## /fly status

```bash
fly status -a "$APP"
fly machines list -a "$APP"   # started = awake, stopped = asleep
fly volumes list -a "$APP"
fly ips list -a "$APP"        # empty: no wake door
```

## /fly logs

```bash
fly logs -a "$APP"                                   # follow
fly logs -a "$APP" --region <region> --no-tail | tail -50
```

## /fly destroy

Tearing down is the operator's to do, never an agent's: volumes hold the
database, Tailscale identity, certs and session history. Point them at:

- stop without losing anything: `/fly sleep`, or `/fly down`;
- `fly volumes destroy <id> -a "$APP"` for one region;
- `fly apps destroy "$APP"`, then `brane config --unset fly.app`, for all
  of it.

## Tailscale

Machines join the tailnet as **tag-owned** nodes (`tag:brane`, or
`TS_TAGS`), so their keys never expire; the identity persists on the
volume and later boots reuse it. Every `tailscale up` in the entrypoint
names the tags and has a `--timeout`: an `up` without the tags asks
control to drop them, which waits for a login nobody on the machine can
complete.

A new volume (or one whose node was removed) joins with one of two
credentials, set as Fly secrets:

- **`TS_CLIENT_ID` (preferred): no secret on Fly.** The entrypoint asks
  Fly for this machine's OIDC token (`/.fly/api`, `POST
  /v1/tokens/oidc`) and Tailscale's workload identity federation trades
  it for a node key. One-time setup in the Tailscale admin console:
  1. Add `"tag:brane": ["autogroup:admin"]` to `tagOwners` in the policy
     file.
  2. Trust credentials → OpenID Connect → **Custom issuer**
     `https://oidc.fly.io/<org>`, subject `<org>:<app>:*`, scope
     `auth_keys` with `tag:brane`. `<org>` is the org's own name, which
     for a personal org is *not* the `personal` that `fly orgs list`
     shows. Read it from a token's claims on a running machine:
     `fly ssh console -C "sh -c 'curl -fsS --unix-socket /.fly/api -X POST
     http://localhost/v1/tokens/oidc --data {} | cut -d. -f2 | base64 -d'"`
     prints `iss` and `sub` (base64 may warn about padding). Pinning the
     app keeps every other app in the org from joining as `tag:brane`.
  3. `fly secrets set TS_CLIENT_ID=<client id> -a <app>`. The audience
     defaults to `api.tailscale.com/<client id>`; set `TS_AUDIENCE` if the
     console shows a different one.
- **`TS_AUTHKEY`:** an OAuth client secret with the `auth_keys` scope and
  `tag:brane` (never expires), or an auth key allowed to apply the tag
  (expires within 90 days). Append `?ephemeral=false&preauthorized=true`
  to an OAuth secret.

Nodes are never ephemeral: an ephemeral node is deleted while its machine
is down, and a sleep or a `/fly down` can last months. Remove a dead node in the admin
console before its region comes back, or the new one is named `…-1`.

## Volume Safety

**Volumes are never created by accident.** Only `/fly new` creates them,
one per app; `/fly deploy` uses `--update-only`, and `/fly up`
scales the app's one region to one machine.

Intentional volumes are 10 GB; stray ones from Fly auto-provisioning are
typically 1 GB. Investigate with `fly volumes list -a "$APP"` before
anything is deleted, and leave deleting to the operator.

## Troubleshooting

### Machine won't start, or restarts every ~30 s

`/fly logs`. Common causes:
- **Not on the tailnet.** The log says `token exchange failed with status
  403` (the trust credential's issuer, subject or audience doesn't match
  the token; read the claims as above), `entrypoint: could not get an
  OIDC token`, `neither TS_CLIENT_ID nor TS_AUTHKEY is set`, or `tailscale
  up` timed out. See [Tailscale](#tailscale).
- A volume in the old layout: the entrypoint migrates it.

### `/fly up` fails to launch the machine

- `failed to get manifest … MANIFEST_UNKNOWN … unknown tag=deployment-…`:
  the image is referenced by tag. Pin it by digest ([/fly
  deploy](#fly-deploy)) and run `up` again. Nothing was created.
- `insufficient resources to create new machine with existing volume`:
  the host holding the volume has no room for the machine's size right
  now. Nothing was created. The one time it happened (ams), the second
  retry, about 50 s later, succeeded.
  Leave the volume alone: Fly may later move the machine and its volume
  to another host by itself (`migrated=true` in `fly machine status`,
  and a new volume id with the same data). That cost one wake 84 s
  instead of about 10 s.

### A wake does nothing

- `curl` can't connect or resolve: no public IP. `fly ips list`; see
  [/fly init](#fly-init), step 4.
- An answer naming another machine: the app holds more than one machine
  and a running sibling took the request; nothing was started. See
  [One app per machine](#one-app-per-machine); `fly machine start <id>`
  meanwhile.
- An answer naming this machine, but the app still can't reach the
  daemon: the boot isn't done. `/fly logs` until `listening on`.
- The machine started and stopped again: the daemon exited 0 (an idle
  sleep with nobody connecting, say) or crashed through its `retries`.
  `/fly logs` says which.

### Blank terminal after /fly up

Narratives from a previous machine lifetime may show a blank terminal
instead of the restart button, when `/fly down` killed the machine before
the daemon could mark them ended. The server detects this on terminal
connect (`tmux has-session`) and sends the terminated signal.

### Stale Tailscale nodes

After a sleep or `/fly down`, nodes show as offline within 2–5 minutes.
Expected: they reconnect on the next wake or `/fly up`.
