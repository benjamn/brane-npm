# /fly [init|new|deploy|up|down|meld|status|logs|destroy]

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

**Perch and relaunch:** machines are disposable, volumes are permanent.
Idling costs nothing.

| Verb | What it does |
|------|--------------|
| `down` | Destroy all machines. Zero cost. Volumes preserved. |
| `up` | One machine per region that has a volume, reattaching it. |
| `deploy` | Build and push the image; update running machines only, never create one. |

Volumes are the source of truth: each represents a region the operator
committed to, and machines come and go around them.

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
- **The `fly.toml`**, written beside the image's files (`<app>` is `$APP`):
  ```toml
  app = "<app>"
  primary_region = "sjc"

  [build]
    dockerfile = "Dockerfile"

  [[mounts]]
    source = "brane_data"
    destination = "/home/brane"

  [env]
    TS_HOSTNAME = "daemon-<app>"

  [[vm]]
    size = "performance-1x"
    memory = "2gb"
  ```
  The entrypoint appends the region, so a machine's tailnet name is
  `daemon-<app>-<region>`. There is no `[http_service]`: Tailscale is
  the only way in, so Fly's proxy has nothing to route, and without a
  service it neither warns that nothing is listening nor stops or starts
  machines on its own.

## /fly init

One-time setup.

1. Create the app and remember its name:
   ```bash
   APP=brane-$(openssl rand -hex 3)
   fly apps create "$APP" --org <org>
   brane config fly.app "$APP"
   ```
2. Give it its secrets. `ANTHROPIC_API_KEY`, and a Tailscale credential
   (see [Tailscale](#tailscale)). The operator sets secrets themselves,
   `fly secrets set NAME=… -a "$APP"`, so no secret passes through an agent.
   `TS_CLIENT_ID` is not a secret.
3. Run [/fly deploy](#fly-deploy). With no machines it only builds and
   registers the image.

Then `/fly new` for each region.

## /fly new

Add a region: create its 10 GB volume. No machine yet; `/fly up` starts
it. First check one isn't there already:

```bash
fly volumes list -a "$APP"
fly volumes create brane_data --region <region> --size 10 --yes -a "$APP"
```

## /fly deploy

Build the image on Fly's remote builder from this install, and update
running machines. `--update-only` means it **never creates machines**, so
it's safe while scaled to zero; the next `/fly up` uses the new image.

```bash
CTX=$(mktemp -d)
cp "$BRANE_ROOT/Dockerfile" "$BRANE_ROOT/docker-entrypoint.sh" "$CTX/"
(cd "$BRANE_ROOT" && npm pack --pack-destination "$CTX")
# write the fly.toml above into "$CTX/fly.toml"
(cd "$CTX" && fly deploy --update-only -a "$APP")
```

`fly` may print `Process groups have changed. This will: create 1 "app"
machine` on an app with no machines; `--update-only` still creates none.

## /fly up

One machine per region that has a `brane_data` volume. Scale each region
on its own: a single `fly scale count N --region a,b,c` can stack
machines in one region and create stray volumes.

```bash
fly volumes list -a "$APP" --json   # the regions with a brane_data volume
fly scale count 1 --region <region> --yes -a "$APP"   # once per region
```

Running machines are left alone. Watch the first boot with `/fly logs`:
the machine is ready once its daemon logs `listening on`.

## /fly down

Destroy all machines; volumes and their data survive. Take each running
machine off the tailnet first: stale WireGuard state on the volume breaks
some peers (iOS especially) on the next `up`.

```bash
fly machines list -a "$APP"          # the started ones
fly ssh console -a "$APP" --machine <id> -C "tailscale down"   # each
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

1. `--send` sets the secret, which restarts the machines; each daemon
   adopts the hash as a device row as it starts, once (a hash it has ever
   seen, revoked or not, never comes back), and drops the variable.
2. `--ask` reads back the daemon's address (`brane meld --connection` mints
   nothing), retrying for 3 minutes, and the QR is printed.

Like every QR it lapses if nobody scans it within 10 minutes of the
restart; run it again for a fresh one. More devices are best added from
the app's Meld sheet, which needs no restart.

## /fly status

```bash
fly status -a "$APP"
fly machines list -a "$APP"
fly volumes list -a "$APP"
```

## /fly logs

```bash
fly logs -a "$APP"                                   # follow
fly logs -a "$APP" --region <region> --no-tail | tail -50
```

## /fly destroy

Tearing down is the operator's to do, never an agent's: volumes hold the
database, Tailscale identity, certs and session history. Point them at:

- stop without losing anything: `/fly down`;
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
is down, and `/fly down` can last months. Remove a dead node in the admin
console before its region comes back, or the new one is named `…-1`.

## Volume Safety

**Volumes are never created by accident.** Only `/fly new` creates them,
one region at a time; `/fly deploy` uses `--update-only`, and `/fly up`
scales one region at a time.

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

### Blank terminal after /fly up

Narratives from a previous machine lifetime may show a blank terminal
instead of the restart button, when `/fly down` killed the machine before
the daemon could mark them ended. The server detects this on terminal
connect (`tmux has-session`) and sends the terminated signal.

### Stale Tailscale nodes

After `/fly down`, nodes show as offline within 2–5 minutes. Cosmetic:
they reconnect on the next `/fly up`.
