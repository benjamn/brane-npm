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
| Wake listener | `src/fly/wake-listener.ts`, started first by `docker-entrypoint.sh`; `[http_service]` in the `fly.toml` (/fly) | A second, public port answering `/wake` with which machine it is on (`{machine, region}`), so Fly Proxy has a service to start the machine for and the app can tell whose door answered |
| Asleep state, Wake, Sleep | `src/shared/sleep.ts` (the rules), `expo/lib/reach.ts` (the store), the switcher in `expo/app/index.tsx` | Probe missed twice: *no answer*, for every kind of host, or *off the tailnet* when the tailnet says so. After a Wake the row follows the door's answer: *machine is up* once the right machine answered, *ewr answered* when a sibling did. Every row with a URL recipe has one Wake/Sleep slot in its ⋯ (`sleepWakeSlot`): Sleep while it answers, Wake while it doesn't, disabled while checking, waking or going to sleep |
| The undead count | `AwaitingTracker.narratives()` → `awaiting` on `GET /api/status`; `multiAwaitingGlow` (`src/shared/narrative-status.ts`); `sleepLine`/`postureLine` (`src/shared/sleep.ts`); `noteAwaiting` (`expo/lib/reach.ts`) | A daemon's row glows with its awaiting narratives' hues |

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
  deadline, step 6), the machine stops because its main process ended,
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
   but are not recorded: reviving one would replay its command.
2. `~/.brane/sleep-manifest.json`: `{ slept_at, reason, narratives, host }`.
3. `~/.brane/exit-record.json`: `{ exited_at, reason, clean: true, pid }`.
4. On a Fly machine only, `tmux kill-server`, then 2 s for the panes'
   processes to exit. The daemon's exit unmounts the volume, and a live
   agent still holding it made that fail on a real machine (`error
   umounting /home/brane: EBUSY`, then a reboot); an idle sleep with no
   sessions unmounted cleanly. Every process dies with the machine
   anyway, and revive reads the agent's session files, not its process.
   Never on a Mac, where a signal is `brane daemon stop` and the
   sessions outlive the daemon by design.
5. `tailscale down`, 10 s budget, errors logged and ignored. Stale
   WireGuard state for a node that vanished without saying so breaks
   iOS peers on the next boot (/fly).
6. The daemon's ordinary shutdown, which exits 0. It waits for every
   listener to close, so for every open connection, and with the tailnet
   already down a client's can't finish (measured: a phone's WebSocket
   held one sleep 31 s); an HTTP response in flight has no timeout at
   all. So an elective sleep arms a 10 s backstop (`SHUTDOWN_BACKSTOP_MS`)
   as it hands off here, and the process exits by then regardless; a
   signal's 90 s runs from its start.

The routine writes nothing into the narratives. It used to append a
`sleeping` note to each live one, which woke the agent's parked `listen`
a second before its bridge dropped: nothing the agent could act on, and
a paragraph-long card per sleep in every chat (claude-qdjo1yqn:97). The
agent learns of the sleep from the prompt it is revived with, which says
when the host slept and resumed, and the chat's `restarted` line marks
the cycle. Older narratives keep the notes they got.

**A stop is not a sleep.** A signal can't say who sent it, and on a
Mac `brane daemon stop` is a SIGTERM whose tmux sessions all outlive
the daemon. So on a signal, step 2 happens only where boot revive is on
and something is live, and steps 4 and 5 only on Fly, whatever the config
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
last_client_disconnect, sessions, sleeps_in_ms }` ([Daemon](daemon-api.md)).
`last_client_disconnect` is null while any control-socket client is
connected, and the clock starts at daemon startup: a host woken by a
stray request that nobody follows goes back to sleep after N minutes,
which is what bounds what a stranger's wake can cost.

`sleeps_in_ms` is what the countdown has left as the daemon answers,
reported only while the rule would fire at its end: a rule set, no
control-socket client, and tmux answering with no sessions (with tmux
unknown the rule never fires, so no countdown is claimed); null
otherwise. It is relative rather than a time so the app needs no
agreement between its clock and the daemon's: the row subtracts the
time since that status arrived (`statusAt`, set only with a status: a
401 or a first miss moves `probedAt` and brings none) and reads `0
sessions · sleeps in 7m`. The words are `relAhead`
(`src/shared/narrative-format.ts`), the countdown twin of the narrative
card's `relPart`: the same units (`3h`, `7m`, `45s`, `2d`, then a date
past a week), rounded up as a countdown clock is, so it never says less
time than is left; the minutes tick down, and the last minute counts in
seconds. The switcher redraws exactly when the soonest such text would
change (`sleepPhraseChangesInMs`): once a minute, once a second in the
last one, and never with no countdown showing. The daemon checks the
rule once a minute (`IDLE_TICK_MS`, kept equal to the app's
`IDLE_CHECK_MS`), so the sleep lands up to a minute after the countdown
ends, and the row says *sleep due* through that minute. Past it the
status says nothing about now, and nothing has asked the host since, so
the row stops claiming a time and gives the rule, whose minutes read
exactly in their largest whole unit (`formatMinutes`: `15m`, `90m`,
`2h`). A held countdown (a
session, a device connected) reads the rule, `sleeps after 15m idle`;
the daemon the app is connected to is always held, by that connection.
A daemon before 0.3.17 sends no `sleeps_in_ms` and reads the rule.

## Wake recipes

| Host | Recipe | Who runs it |
|---|---|---|
| Fly machine | A URL: `https://<app>.fly.dev/wake`, from `FLY_APP_NAME`, and the machine's id, from `FLY_MACHINE_ID` | The app, with one `fetch` whose answer it reads; or any shell or awake daemon with `fly machine start` |
| A box that stays up (a Mac mini) | None: "no way to wake it" (daemons before 0.3.17 said "not a Fly machine"; the row shows no reason either way) | Nobody; its row has no Wake, and reads *no answer* like any other host that doesn't answer |
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

Fly's own APIs send no CORS headers (measured 2026-11-04), so a URL is
the only way a static page reaches Fly. The fetch is exactly `{ mode:
"cors", redirect: "follow", cache: "no-store" }` with no custom headers,
so it is a simple request with no preflight, and the listener answers
`Access-Control-Allow-Origin: *` so the page can read the body.

**One app per machine.** Fly Proxy, not the caller, chooses which machine
of an app a request reaches. It prefers one that is already running and
starts a stopped one only when none is, the nearest to the caller. With
four machines in one app and one awake, every Wake for the other three
was answered by the awake one in under 100 ms and started nothing
(measured 2026-11-25); the app then showed *waking…* for three minutes
over a machine nobody had started. A browser can't send
`fly-force-instance-id`, so the URL can only be made to mean one machine
by giving that machine its own app ([/fly](../protocols/fly.md)).

**The door says who answered.** The listener answers `GET /wake` with
`{"machine": FLY_MACHINE_ID, "region": FLY_REGION}`, and the recipe in
`/api/status` carries the daemon's own machine id. The app compares the
two (`wakeReachedOther`): a match means the machine is up and the row
reads *machine is up* (*connecting…* beneath); a mismatch reads *<region>
answered* (*not this machine* beneath) and offers Wake again, instead
of a wait that can't end. An answer that can't be read (an older image's
204, a recipe from before machine ids) leaves the row *wake sent*. What the app shows after a tap is therefore something a machine
said, not a guess; it is kept in `sessionStorage` (`brane_wakes`) so a
reload doesn't forget a wake in flight and doesn't send another.

**Laptops.** Wake-on-LAN is a LAN broadcast Tailscale can't send
([Tailscale on WoL](https://tailscale.com/blog/wake-on-lan-tailscale-upsnap)),
so the recipe would ask an always-on relay on that LAN. A notebook on
battery with the lid closed doesn't wake for the network at all, so a
laptop has two recipes and the app would show which applies. Not built;
a Mac reports `none`.

## Two addresses

The switcher's probe (`GET /api/status`) goes to the daemon's tailnet
address; a stopped machine's tailnet node is offline, so the probe can't
wake it. Only the Fly Proxy hostname wakes, touched by the ⋯ menu's Wake
and nowhere else. `src/test/sleep-reach.test.ts` reads `expo/lib/reach.ts`
and checks the wake fetch appears once, inside `wakeDaemon`, with no
timer or loop around it; the re-probes after a tap go to the tailnet, at
`WAKE_REPROBE_DELAYS_MS` (4, 8, 15, 30, 45 s, then every 60 s) up to a
3 min ceiling. Once the door has answered for this very machine
(`wakeConfirmed`) the peer is not absent but booting, so the loop asks
every 2 s for the next half minute (`WAKE_CONFIRMED_REPROBE_MS`): on
2026-11-26 nrt was listening 8 s after the proxy started it and the app
connected 7 s after that, all spent waiting for a 5 s tick. Past the
ceiling the row says *no answer* (*tap Wake again* beneath) and sends nothing
on its own.

The probe needs a short budget, since an offline peer times out rather
than refusing: the switcher uses 5 s and one attempt, where melding and
adding a daemon keep the request layer's 60 s with retries. It can't
tell asleep from broken, so the row doesn't pretend to. **It says only
what the app observed**, in as few words as the row's space needs, and
the same for every kind of host: a host that doesn't answer reads *no
answer*, whatever its recipe. A laptop with its lid shut and a stopped
cloud machine look the same from here, and either may be broken. The
recipe decides only whether the row's ⋯ offers Wake; the reason a
`none` recipe carries is not shown. A Sleep the daemon accepted (202)
is not a sleep seen, so once *going to sleep…* has had its grace the
row reads *no answer* too; a wake sent reads *wake sent*, not
*waking*; and *off the tailnet* is said only when the connected
daemon's Tailscale, running and healthy, lists it so ([Web
App](web-app.md)).

**Ask a daemon before dialing a machine.** The app can't ask its own
device's Tailscale anything, which is why it learned "asleep" by dialing
and timing out. But the daemon it is connected to is on the tailnet and
its `tailscale status` already knows, for every peer and without sending
one a packet, whether control has it online. A machine that slept ran
`tailscale down` and shows offline within seconds. So when the switcher
opens with a control socket up, it asks that daemon first (`GET
/api/tailnet?hosts=…`, `probeAllReach` in `expo/lib/reach.ts`):

- **offline**: the row reads *off the tailnet*, for every kind of host,
  and **no request is sent to it**. The phone's Tailscale never hears
  about a stopped machine. The words are the tailnet's listing, not a
  claim that the machine is off.
- **online**: it gets the one probe; if that goes unanswered the row
  says *no answer*, with *on the tailnet* beneath: a daemon or a path in
  trouble, not a sleeping machine.
- **unknown** (the daemon has no Tailscale to ask, doesn't have the
  host as a peer, or predates the route): probed as below.

The daemon's word is taken only when its own Tailscale answered with
`BackendState` `Running` and no health warnings (`tailnetTrusted`,
`src/shared/sleep.ts`); anything else is *unknown*. A stopped or
logged-out Tailscale still prints its last peer list, and one cut off
from the coordination server reports each peer's `Online` only as of
its last contact, so either would make *off the tailnet* a claim
nobody checked. The cost is a dial that a healthy view would have
spared. The path to this device (*direct*, *relayed via …*) is held to
the same rule.

The waking loop asks the same way before each re-probe, so a machine
that has not rejoined yet is not dialed. The answer also carries the
daemon's view of the device that asked, which the active row shows as
*direct* or *relayed via nyc* (`pathLabel`): the first thing to know
when a connection is slow. With no daemon connected there is nobody to
ask, and the rules below are all there is. Pinned by
`src/test/tailnet-view.test.ts` and `src/test/sleep-reach.test.ts`.

**Probes are sparing, and one miss is not a verdict.** A probe of a
stopped machine is not free: its tailnet node stays in every peer's
netmap, and a request to it makes the phone's Tailscale dial the peer's
home relay and retry every few seconds for as long as something keeps
asking. So the store (`expo/lib/reach.ts`) probes on the rules in
`src/shared/sleep.ts`, pinned by `src/test/sleep-reach.test.ts`:

- An answer is fresh for `PROBE_FRESH_MS` (30 s); opening the switcher
  again inside that asks nothing.
- A daemon that missed is asked again no sooner than
  `PROBE_MISS_BACKOFF_MS` (60 s), doubling per miss to
  `PROBE_MISS_BACKOFF_MAX_MS` (5 min) (`probeDue`). A tap on Wake, a
  control-socket connect, and the operator's own refresh force one.
- A daemon that answered last time is not marked failed by one miss: it
  is asked once more after `PROBE_CONFIRM_DELAY_MS` (3 s)
  (`probeAfterMiss`). Probes fail in normal operation (a path being
  re-established, a phone changing networks), and a failed probe never
  does anything but change a label: it does not drop the active
  connection, clear a recipe, or block a switch.
- A refusal inside `PROBE_REFUSED_UNDER_MS` (1.5 s) means the machine is
  up and the daemon is not listening yet (the tailnet comes up about 2 s
  before the daemon does, measured 2026-11-25), so it is retried at
  `PROBE_NOT_READY_RETRY_MS` up to `PROBE_NOT_READY_RETRIES` times
  rather than counted as a miss.
- Every probe has its own deadline (`withDeadline`), so one that never
  settles can't leave a row *checking…* forever.

**The same care on the way in.** A control WebSocket dialed into a path
that is still forming can sit unopened for over a minute, so the app
closes it and dials again after 5, 10, then 15 s. Requests are not
treated that way: each attempt waits its whole timeout, so a slow GET is
never sent twice ([The Request
Layer](request-layer.md#a-slow-request-is-not-re-sent)). And a request's
deadline covers its body, not only its headers
([there](request-layer.md#the-deadline-covers-the-body)).

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

The row shows it as the glow the narratives' own cards wear, and no
longer in words: it once also said `3 sessions, 2 undead`, but each of
the undead is already one of the sessions, so the line counted one agent
twice and read as two kinds of thing. One
awaiting narrative lights the daemon's row with its ring, in its hue;
several split the rim by edge, top, bottom, left, right, one hue each
(`multiAwaitingGlow`), until the edges run out at four. The hues come
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
| Wake, `GET https://<app>.fly.dev/wake` on a stopped machine | Proxy starts it; VM up in ~0.8 s; the door answers (204 then, 200 with the machine now) after ~2.1 s; tailnet rejoined at ~3 s; daemon listening, on its old port, at ~4 s |
| Sleep act with one agent awaiting | 202 naming it; the agent's parked `listen` woke with the sleeping note (since removed); manifest; exit 0; machine stopped 3 s after the request |
| `fly deploy` onto a running machine (the signal path) | SIGINT ran the routine: manifest, `tailscale down`, exit 0; the new image booted and revived the agent |
| Volume unmount after a sleep with a live agent | `error umounting /home/brane: EBUSY`, then a reboot, until the routine learned to end the sessions on Fly (step 4); clean since |
| Boot revive | Agent revived ~5 s after the daemon listened. With the old fixed-2 s prompt, its wake prompt sat unsubmitted in Claude's input; since `revive-prompt.ts` it submits, and the agent is back awaiting ~9 s after its revive |

So a woken host is reachable in seconds and its agents are back within
about 15 s (measured with revive at boot; it now waits for the app to
connect, which the app does as soon as the probe answers). The app's waking ceiling (3 min) is generous, and suspend
would buy little for the cost of a token on the machine.

## What remains

1. **Measured 2026-11-25, and not good:** a wake of lax from the phone
   took 101 s from the machine starting to the app connected. The
   machine was up in 2 s, on the tailnet in 5, and the phone had a
   direct path in 6; four connections were refused because the daemon
   was not listening until second 7; then the phone's path dropped and
   nothing arrived for 78 s. Why the path drops after first contact is
   not known, nor why a phone that has visited a Fly machine sometimes
   can't reach the laptop until its Tailscale is restarted (the stale
   node state of PR #299 is the suspect). Seen again on 2026-11-26 with
   nrt alone in its own app: 16 s after nrt ran `tailscale down`, the
   laptop's Tailscale had lost its direct path to the phone on the same
   Wi-Fi and heard from it only through a relay, until the phone's
   Tailscale was restarted. The laptop, a peer of nrt too, was
   unaffected. The retries above shorten what the app adds to that, and
   asking a daemon instead of dialing takes away the traffic to stopped
   machines; neither explains it.
2. **Remote meld restarts every machine of the app**, because `fly
   secrets set` does. One app per machine confines that to the machine
   being melded.
3. **Still unmeasured on Fly:** whether the machine can suspend itself through `/.fly/api`
   without a token, which would keep processes across a sleep on
   machines of 2 GB or less. Also how long a phone that vanishes without
   closing its control socket holds the idle clock: the count drops only
   on the socket's `close`, and how soon the 30 s heartbeat write errors
   through userspace tailscaled is unknown.
4. **The Sleep act on a Mac.** The app hides Sleep where the recipe is
   `none`, and rightly: nothing could wake the host from the phone. Since
   #679 a bridge never starts a daemon, so the old reason a Mac's sleep
   wouldn't hold is gone; what's left is that the Mac itself stays up,
   so a "sleep" there is a `brane daemon stop` by another name. Worth
   building only with a real wake for a Mac (Wake-on-LAN, below).
5. **The list while asleep.** The switcher's probe is quick, but the
   narrative list's opening requests still wait the request layer's full
   60 s with retries before erroring when the active daemon is asleep.
6. **The template repository and the token page**, above.
7. **Wake-on-LAN for a docked laptop**, above.

Separately: `caffeinate -i` (`src/daemon/keep-awake.ts`) runs for the
daemon's lifetime with no opt-out, deciding for every operator that
their Mac shouldn't idle-sleep, and it doesn't cover the lid. A
`keep_awake` config, default on, with a line in the README.
