# Sleep and Wake

**Status: built, unmeasured against a real stopped machine.** The design
was settled in claude-o8o3kg69 (the reasoning and the survey behind it),
amended in claude-3zafmzej (sleep as the daemon's own act, the wake door,
what workspacer did), and built in claude-wl40pour. What remains is at the
end.

Brane assumes the daemon's host never sleeps: agents are processes in
tmux on it, and the daemon is the only way a phone reaches them. Closing
a laptop ends brane until it reopens, and a fleet of rented machines
(/fly) can't be brought up from a phone when the laptop is the only
thing that knows how.

The design: **hosts sleep, narratives don't.** A host shuts down
entirely, machine included, and comes back when something wants it.
Everything durable about a session is already on disk, and every
process is one `revive` can rebuild from its `agent_session_id`. The
static app wakes a sleeping host by itself, with no daemon awake
anywhere and nothing of brane's running in between. A rented machine
can then be several times the size of one anyone would leave on.

| Piece | Where it lives | Does |
|---|---|---|
| Sleep routine | `src/daemon/sleep.ts` (`Sleeper`), wired in `src/daemon/server.ts` | The daemon's own exit: tell the live narratives, write the manifest and exit record, `tailscale down`, shut down |
| Idle rule | `Sleeper.tick`, `idleSleepDue` | The one automatic sleep, below |
| Sleep act | `POST /api/sleep`, `ACT_ROUTES` as `sleep` | The operator's Sleep button; closed to agents |
| Wake manifest | `~/.brane/sleep-manifest.json` on the host's volume | Which narratives were live at sleep; written before shutdown, read at boot |
| Exit record | `~/.brane/exit-record.json` | Written on every exit the routine ran; a boot that finds none means a crash or a kill |
| Boot revive | `bootRevive`, run by `ManifestRestorer` on the first operator connection after boot | Revives the manifest's narratives with a prompt naming when the host slept and resumed; a wake alone revives nothing |
| Wake recipe | `wake` in `GET /api/status`, saved on the device's registry entry (`expo/lib/registry.ts`) at every good probe | How to wake this host; "none" is a recipe, with a reason |
| Wake listener | `src/fly/wake-listener.ts`, started first by `docker-entrypoint.sh`; `[http_service]` in the `fly.toml` (/fly) | A second, public port answering `/wake` with 204, so Fly Proxy has a service to start the machine for |
| Asleep state, Wake, Sleep | `src/shared/sleep.ts` (the rules), `expo/lib/reach.ts` (the store), the switcher in `expo/app/index.tsx` | Probe failed and the entry has a recipe: *probably asleep*, with a Wake button; the active daemon's ⋯ offers Sleep |
| The undead count | `AwaitingTracker.narratives()` → `awaiting` on `GET /api/status`; `multiAwaitingGlow` (`src/shared/narrative-status.ts`); `sleepLine`/`postureLine` (`src/shared/sleep.ts`); `noteAwaiting` (`expo/lib/reach.ts`) | A daemon's row glows with its awaiting narratives' hues and says `3 sessions, 2 undead` |

The shared shapes (`WakeRecipe`, `SleepStatus`) have one definition,
`src/shared/sleep.ts`, which the daemon imports, so the two sides cannot
disagree on the contract.

## Decisions

- **A session keeps its host awake.** An agent that is listening keeps
  its daemon alive indefinitely (claude-o8o3kg69:29).
- **Waking restores nothing; connecting does** (claude-qdjo1yqn:65,
  :67). A wake starts a bare daemon. The last sleep's agents come back
  only when an operator connects: a melded device's control socket, or
  this machine's own client, never an agent's token. Reviving them at
  boot would let anyone who knows the wake URL start agents whose
  sessions then hold the host up indefinitely (claude-46sy2xmw:8,
  finding 2); a wake nobody follows now goes back to sleep after N
  minutes with nothing revived, and the manifest keeps waiting. Any
  device token counts, verified or not: connecting is free under the
  verification gate, and reviving what the operator left running
  restores state rather than taking a new act (claude-46sy2xmw:14). An
  app tab still pointed at the daemon reconnects within 2 s of a wake,
  whoever woke it, and so restores the agents too.
- **The daemon never decides a host is idle.** An agent at work looks
  like one that isn't listening, so no heuristic sleeps a host
  (claude-o8o3kg69:33). The daemon reports uptime, sessions and the
  last disconnect, and judges nothing.
- **The one automatic sleep:** a host with **no sessions** (no tmux
  session exists for any narrative) sleeps **N minutes after its last
  client disconnects** (claude-o8o3kg69:35). A working agent can't trip
  it, a connected operator can't, and N is minutes so a bare host woken
  to spawn something doesn't race the sleep. An `/idle`d agent still has
  its tmux pane, so it keeps the host awake; ending sessions is what lets
  a host sleep on its own.
- **Sleep is the daemon's own act** (claude-3zafmzej:9, :10). Both
  triggers are requests to the daemon to perform the routine; nothing
  outside stops the machine in the normal path. The routine's steps
  therefore take as long as they need (only the final shutdown has a
  deadline, step 7), the machine stops because its main process ended,
  and no credential for the platform has to exist anywhere on the host.
  An outside stop (`fly machine stop`, a deploy) still arrives as a
  signal, and the same routine runs from the signal handler, bounded.
- **Wake is automatic and necessarily external** (claude-3zafmzej:12). A
  stopped machine has no daemon to ask. Waking is cheap and reversible;
  sleeping is neither.
- **Acceptance test:** a Fly account, Tailscale on the phone, and never
  a terminal (claude-o8o3kg69:45).
- **No infrastructure** beyond serving the static app
  (claude-o8o3kg69:13). The wake path is a platform feature, not a
  service of brane's.

## The routine

One routine, two entries. *Elective* (the idle rule, the Sleep act) runs
with no time budget. *Signalled* (SIGTERM or SIGINT, from `fly machine
stop`, a deploy, `brane daemon stop`, or Ctrl-C on a foreground
daemon) runs the same steps under a 90 s backstop that exits regardless,
inside Fly's `kill_timeout` of 120 s. In order:

1. Which narratives are live: one `tmux list-sessions`, matched against
   narrative ids. Utility sessions keep the host awake like any session
   but are not recorded or told: reviving one would replay its command.
2. A `sleeping` lifecycle event into each, through `announceEvent()`, so
   a parked `listen` wakes with the reason and what happens next. Then a
   1 s pause for the bridges to hand it on.
3. `~/.brane/sleep-manifest.json`: `{ slept_at, reason, narratives, host }`.
4. `~/.brane/exit-record.json`: `{ exited_at, reason, clean: true, pid }`.
5. On a Fly machine only, `tmux kill-server`, then 2 s for the panes'
   processes to exit. The daemon's exit unmounts the volume, and a live
   agent still holding it made that fail on a real machine (`error
   umounting /home/brane: EBUSY`, then a reboot); an idle sleep with no
   sessions unmounted cleanly. Every process dies with the machine
   anyway, and revive reads the agent's session files, not its process.
   Never on a Mac, where a signal is `brane daemon stop` and the
   sessions outlive the daemon by design.
6. `tailscale down`, 10 s budget, errors logged and ignored. Stale
   WireGuard state for a node that vanished without saying so breaks
   iOS peers on the next boot (/fly).
7. The daemon's ordinary shutdown, which exits 0. It waits for every
   listener to close, so for every open connection, and with the tailnet
   already down a client's can't finish (measured: a phone's WebSocket
   held one sleep 31 s); an HTTP response in flight has no timeout at
   all. So an elective sleep arms a 10 s backstop (`SHUTDOWN_BACKSTOP_MS`)
   as it hands off here, and the process exits by then regardless; a
   signal's 90 s runs from its start.

**A stop is not a sleep.** A signal can't say who sent it, and on a
Mac `brane daemon stop` is a SIGTERM whose tmux sessions all outlive
the daemon. So on a signal, steps 2 and 3 happen only where boot revive
is on and something is live, and step 5 only on Fly, whatever the config
says: a Mac that downed its tailnet on a stop would be off it until
someone at the machine started the daemon again. Boot revive is the
second guard: it skips any narrative whose tmux session is still alive,
so even a manifest written across a stop types nothing into a running
agent and starts no second process. On a Mac a stop does one new thing:
it writes the exit record.

**An in-place restart is no signal at all** (`brane daemon restart`,
`POST /api/daemon/restart`): the daemon hands its claim to a successor
it starts itself, and the routine never runs. The handoff writes an
exit record of its own, reason `restart`, before the successor starts,
so the successor's boot reads a clean exit rather than a crash.
**Except on a Fly machine**, where it is refused (409, `restartRefusal`
in `src/daemon/lifecycle.ts`): the entrypoint `exec`s the daemon, so it
is the machine's main process, and a handoff would exit it 0 and stop
the machine with its successor inside, with no manifest and nothing
revived on wake. `fly machine restart` goes through the signal instead.

**Boot revive** waits for the first operator connection after boot
(`ManifestRestorer`, `restoresOnConnect`); the boot only logs that a
manifest is waiting. It runs once per daemon run, and not while the host
is going back to sleep. Until then the manifest stays where it is, and a
later sleep carries it over (`carryManifest`): a wake nobody followed
sleeps again on the idle rule with the earlier sleep's agents, time and
reason intact. It moves the manifest aside, as `sleep-manifest.last.json`,
*before* the first revive, so a revive that brings the daemon down is
not retried on every boot after it. Revives run one at a time, 2 s
apart, each keeping its `launched_by` so revoking the device that started
it still cascades. The prompt names when the host slept and resumed.
With boot revive off, a manifest is still moved aside unread, so a stale
one can't fire the day it is switched on.

## Configuration

Read through `brane config`, re-read on every tick, with the image's
environment as the fallback; a config value that is set wins, so
`brane config sleep.idle_minutes 0` switches off what `fly.toml` turned on.

| Key | Fallback | Means |
|---|---|---|
| `sleep.idle_minutes` | `BRANE_SLEEP_IDLE_MINUTES` (the `fly.toml` sets 15) | N for the idle rule; unset, 0 or junk is never |
| `sleep.boot_revive` | on when `FLY_APP_NAME` is set | Whether startup revives the manifest's narratives |
| `sleep.tailscale_down` | on when `FLY_APP_NAME` is set | Whether an elective sleep leaves the tailnet; a signalled one does so only on Fly |

`GET /api/status` reports `wake` and `sleep: { idle_minutes,
last_client_disconnect, sessions }` ([Daemon](daemon-api.md)).
`last_client_disconnect` is null while any control-socket client is
connected, and the clock starts at daemon startup: a host woken by a
stray request that nobody follows goes back to sleep after N minutes,
which is what bounds what a stranger's wake can cost.

## Wake recipes

| Host | Recipe | Who runs it |
|---|---|---|
| Fly machine | A URL: `https://<app>.fly.dev/wake`, from `FLY_APP_NAME` | The app, with an opaque `no-cors` fetch; or any shell or awake daemon with `fly machine start` |
| Always-on box (a Mac mini) | None: "not a Fly machine" | Nobody; unreachable means *unreachable*, not asleep |
| Laptop, docked | (not built) Wake-on-LAN through a relay on its LAN that is also on the tailnet | An awake daemon or the app, by asking the relay |
| Laptop, mobile | None | Nobody; the app says so instead of offering a Wake that does nothing |

**Fly.** Fly Proxy starts a stopped machine when a request arrives for a
service with `auto_start_machines = true`; `auto_stop_machines = "off"`
leaves stopping to the daemon ([autostart/autostop](https://fly.io/docs/launch/autostart-stop/)).
The `fly.toml` in /fly has that service on port 8080, where the image
runs the wake listener as its own process, started before tailscaled so
the request that woke the machine is answered as soon as the container
is. The daemon is never behind it: under `--bind 0.0.0.0` the daemon has
no IP filter, so anything the proxy could reach would be reachable from
the internet, and the proxy routes only the listener's port. `[[restart]]
policy = "on-failure"` is what makes exit 0 a stopped machine and a crash
a restart.

**The listener is unauthenticated, and no scheme fixes that.** The proxy
starts the machine before any path or body reaches the listener, so a
token in the URL would protect nothing (claude-7ujodtiu:17, confirmed by
workspacer's own notes, claude-3zafmzej:16). The bounds are the app
name's entropy, which `/fly init` now draws with `openssl rand -hex 8`,
and the idle rule. Opening the door at all, by allocating a public IP, is
a deliberate operator step in `/fly init`, and `fly ips release` closes
it, leaving `fly machine start` as the only wake. Deploys pass
`--no-public-ips` so one never opens it by accident.

A browser can send the wake with no CORS: a `no-cors` fetch returns an
opaque response the page can't read and doesn't need to. Fly's own APIs
send no CORS headers (measured 2026-11-04), so a URL is the only way a
static page reaches Fly. The fetch is exactly `{ mode: "no-cors",
redirect: "follow", cache: "no-store" }`: Chromium refuses a `no-cors`
request whose redirect mode is `error` before sending it at all. A
`no-cors` request carries no custom headers, so it wakes *a* stopped
machine in the app, the nearest; a specific machine gets its own app, or
an awake daemon starts it by id.

**Laptops.** Wake-on-LAN is a LAN broadcast Tailscale can't send
([Tailscale on WoL](https://tailscale.com/blog/wake-on-lan-tailscale-upsnap)),
so the recipe would ask an always-on relay on that LAN. A notebook on
battery with the lid closed doesn't wake for the network at all, so a
laptop has two recipes and the app would show which applies. Not built;
a Mac reports `none`.

## Two addresses

The switcher's probe (`GET /api/status`) goes to the daemon's tailnet
address; a stopped machine's tailnet node is offline, so the probe can't
wake it. Only the Fly Proxy hostname wakes, touched on the Wake tap and
nowhere else. `src/test/sleep-reach.test.ts` reads `expo/lib/reach.ts`
and checks the wake fetch appears once, inside `wakeDaemon`, with no
timer or loop around it; the re-probes after a tap (every 5 s, up to a
3 min ceiling that boot-to-first-narration will set) go to the tailnet.
Past the ceiling the row says *still asleep; tap Wake again* and sends
nothing on its own.

The probe needs a short budget, since an offline peer times out rather
than refusing: the switcher uses 5 s and one attempt, where melding and
adding a daemon keep the request layer's 60 s with retries. It can't
tell asleep from broken: a host with a recipe that doesn't answer is
*probably asleep*; one without is *unreachable*, with the recipe's
reason. The app shows that word ([Web App](web-app.md)).

## The undead count

An agent parked in a blocking `listen` or a `narrate({ wait: true })`
is not running and not dead: it is waiting for the operator, and its tmux
session is one of the `sessions` that keep the host awake. The operator's
word for those agents is *the undead*, and the switcher counts them.

The daemon already knows the set exactly (`src/daemon/awaiting.ts`
holds the parked calls, and a parked call needs a live bridge), so `GET
/api/status` lists it as `awaiting`. The switcher's probe carries it for
every daemon it opens on; for the active daemon the control socket's
`awaiting` edges keep it current (`noteAwaiting`, `expo/lib/reach.ts`).
A probe that fails, and a Sleep, clear it: no daemon, no parked call.

The row shows it twice. In words, under the name: `sleeps after 15 min
idle · 3 sessions, 2 undead`, and `2 undead` alone on a row whose status
carried no posture. And as the glow the narratives' own cards wear: one
awaiting narrative lights the daemon's row with its ring, in its hue;
several split the rim by edge, top, bottom, left, right, one hue each
(`multiAwaitingGlow`), so the colors and the count read together until
the edges run out at four, where the words carry the rest. The hues come
from the same per-device allocator as the cards' (`src/shared/glow-hues.ts`),
so a remote daemon's waiting narrative previews the hue it will glow in
once the operator switches there. Each edge is the ring's layers pushed
to that side alone, the way the ring's one-sided top layer already is,
pinned by `src/test/awaiting-glow.test.ts`. The geometry is reasoned,
not yet eyeballed on a device; it is one table in that module to tune.

## Provisioning from a phone

`/fly` needs a shell for `fly`, and `/fly meld` needs the operator's
daemon to mint the device token after a presence check. The phone-only
path: launch a public `brane-fleet` template repository from Fly's
dashboard; mint the device token in the browser and paste its SHA-256
into the dashboard as `BRANE_DEVICE_TOKEN_SHA256`, which the entrypoint
already adopts; open the app at the tailnet name, known in advance.
Three gestures. A one-tap launch can't call Fly from a static page; the
nearest is a `workflow_dispatch` to a fork running `fly launch --from`,
which adds a GitHub account and is the second-host shortcut, not the
baseline. Not built.

## Measured on Fly

On 2026-11-24, on the operator's fleet (`performance-1x`, 2 GB, ewr),
with this branch's image:

| What | Result |
|---|---|
| `fly deploy --update-only --no-public-ips` with an `[http_service]`, no machines | No machine and no IP created, though `fly` prints "create 1 app machine" |
| Idle rule, no sessions, no client | Slept exactly 15 min after boot; `tailscale down`; exit 0; Fly: "exited with exit code 0, not restarting". The machine stays *stopped* under `on-failure` |
| Wake, `GET https://<app>.fly.dev/wake` on a stopped machine | Proxy starts it; VM up in ~0.8 s; 204 after ~2.1 s; tailnet rejoined at ~3 s; daemon listening, on its old port, at ~4 s |
| Sleep act with one agent awaiting | 202 naming it; the agent's parked `listen` woke with the sleeping note; manifest; exit 0; machine stopped 3 s after the request |
| `fly deploy` onto a running machine (the signal path) | SIGINT ran the routine: manifest, `tailscale down`, exit 0; the new image booted and revived the agent |
| Volume unmount after a sleep with a live agent | `error umounting /home/brane: EBUSY`, then a reboot, until the routine learned to end the sessions on Fly (step 5); clean since |
| Boot revive | Agent revived ~5 s after the daemon listened. With the old fixed-2 s prompt, its wake prompt sat unsubmitted in Claude's input; since `revive-prompt.ts` it submits, and the agent is back awaiting ~9 s after its revive |

So a woken host is reachable in seconds and its agents are back within
about 15 s (measured with revive at boot; it now waits for the app to
connect, which the app does as soon as the probe answers). The app's waking ceiling (3 min) is generous, and suspend
would buy little for the cost of a token on the machine.

## What remains

1. **Still unmeasured on Fly:** whether iOS Tailscale peers reconnect
   cleanly after a *stop* (the warning /fly carries is for a destroy);
   which machine the wake URL starts when another region's is already
   up; and whether the machine can suspend itself through `/.fly/api`
   without a token, which would keep processes across a sleep on
   machines of 2 GB or less. Also how long a phone that vanishes without
   closing its control socket holds the idle clock: the count drops only
   on the socket's `close`, and how soon the 30 s heartbeat write errors
   through userspace tailscaled is unknown.
2. **The Sleep act on a Mac.** The app hides Sleep where the recipe is
   `none`, and rightly: nothing could wake the host from the phone. Since
   #679 a bridge never starts a daemon, so the old reason a Mac's sleep
   wouldn't hold is gone; what's left is that the Mac itself stays up,
   so a "sleep" there is a `brane daemon stop` by another name. Worth
   building only with a real wake for a Mac (Wake-on-LAN, below).
3. **The list while asleep.** The switcher's probe is quick, but the
   narrative list's opening requests still wait the request layer's full
   60 s with retries before erroring when the active daemon is asleep.
4. **The template repository and the token page**, above.
5. **Wake-on-LAN for a docked laptop**, above.

Separately: `caffeinate -i` (`src/daemon/keep-awake.ts`) runs for the
daemon's lifetime with no opt-out, deciding for every operator that
their Mac shouldn't idle-sleep, and it doesn't cover the lid. A
`keep_awake` config, default on, with a line in the README.
