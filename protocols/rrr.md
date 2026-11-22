# Protocol: rrr

`/rrr [branch=main]` puts the running code on what is actually merged.
Fetch, rebase onto `origin/<branch>`, rebuild, restart.

Three letters, four r's:

| r | step |
|---|---|
| *refetch* | `git fetch origin` — elided from the name, because it's implied |
| **rebase** | onto `origin/<branch>` |
| **rebuild** | the project's build |
| **restart** | whatever long-running process serves that build, if there is one |

The first half is the same in every repository. The second half is
whatever *this* fold's build and process are — read them off the
project (`package.json` scripts, a `Makefile`, a `justfile`, its
README) rather than assuming. When the fold is the brane repository
itself, they are `npm run build` and `brane daemon restart`, and that
case has enough of its own consequences to get its own section at the
end of this document.

## Why

An agent's working tree is a claim about the world; `origin/main` is
the world. Between them sit merged PRs you never pulled, your own
commits that were squashed on the way in, and build output compiled
from neither. `/rrr` collapses the three into one state and puts the
live process on it, so that what you are about to test is **what has
actually been merged** rather than what your branch believes.

The last step is the one that matters. A build writes files; a
process that started before the build holds its code in memory. Until
it is restarted, a green build is a claim about files on disk and
nothing more.

**The operator knows the restart will blink.** On an explicit `/rrr`,
do not spend a narration warning about the process going down or
asking whether to proceed; the invocation *is* the consent. Report the
restart as a step you took, not a risk you weighed.

## Restart from the right checkout

A restart is only "testing this tree" if the process is started *from*
this tree. Many restart commands re-exec whatever checkout invoked them
— so restarting from a worktree does not test the worktree; it installs
that worktree's build as the process for everyone who shares it, until
someone restarts from somewhere else.

So before step 6, ask where the running process was started from, and
compare it to `whoami`'s `fold_dir`. If they differ:

- **Don't restart from here** unless the operator has said to, knowing
  what it means. It is a wider side effect wearing the costume of a
  local one.
- You may still do the read-only half — `git fetch origin`, and rebase
  *your own branch* onto `origin/<branch>` if that is what you want.
  That is ordinary work, not `/rrr`.
- If what you need is the process on merged code, say so and let the
  operator run `/rrr` in the checkout it runs from, or ask for
  permission to walk over to it. Then come back.

## Steps

Narrate as you go — each step's real output, not a plan restated. A
`/rrr` that reports "rebased, rebuilt, restarted" without ever showing
what git and the build said is indistinguishable from one that did
nothing.

**1. Fetch.** `git fetch origin` — or `git fetch origin <branch>`.
This comes first because the next step is a question about the
*target*, and you cannot ask it before you have one.

**2. Take stock of the tree.** `git status --porcelain`, and then, for
each path it names, the question that actually matters:

```
git show origin/<branch>:<path> | diff - <path>
```

The question is **not** "is the tree dirty?" — that is tidiness. It is
**"does this tree hold bytes that exist nowhere else?"** Dirt is only
dangerous when it is the sole copy of something.

- **Empty diff — a duplicate.** The file already matches where you are
  going; the sync will not change it. `git add` it and continue. That
  is not a workaround: git compares the *index* against the target, so
  an entry that already equals the incoming content applies cleanly and
  the file lands tracked and clean. An untracked file matching an
  incoming *new* file is the same case and takes the same `git add`.
- **Non-empty diff, or the path doesn't exist upstream — real work.**
  **Stop here and report it.** Do not stash, do not `git checkout --`,
  do not `git clean`, do not `git rebase --skip` your way past a
  conflict. The golden rule at the head of this document covers
  uncommitted work, which is the most easily destroyed artifact in the
  repository and the only one with no copy anywhere.
- **Mid-conflict** (`UU`, a `rebase-merge/` directory) — stop
  regardless. Someone's resolution is in progress.

Untracked files unrelated to the sync — scratch scripts, tarballs,
build droppings — are neither; leave them in place, say what they are,
and continue.

The duplicate case is worth spelling out because it is the *common*
one, not an edge: you merged your own PR, so your working copies are
copies of the destination. Treating that as a blocker stops the run
over files that hold no information — and a guard that fires on the
ordinary case is one people learn to route around, which is how the
guard stops protecting the case that matters.

**3. Switch and rebase.**

```
git checkout <branch>          # default: main
git rebase origin/<branch>
```

On a checkout of `main` that has no local commits this is a
fast-forward and says so. If the rebase **conflicts**, stop: narrate
the conflicting paths and the operator decides. Do not resolve
conflicts inside `/rrr` — you were asked to sync, and a conflict means
the sync is a question rather than a mechanism.

**4. Reinstall if the dependencies moved.** Note the pre-rebase commit
(`git rev-parse HEAD`) before step 3, then afterwards ask what actually
moved among the project's lockfiles and anything that patches
installed packages:

```
git diff --name-only <old>..HEAD -- <lockfiles> <patch dirs>
```

If any of them changed, run the matching install. A repository can
hold more than one independent package tree — a root and a sub-app,
each with its own lockfile and `node_modules` — and a top-level build
that *runs* the sub-app's build without installing for it; check each
tree, not just the root. Patch directories (`patch-package`,
`patches/`) belong in the list because a changed patch rewrites code
inside an installed package and shows up in **no** lockfile at all, so
it is invisible to the check everyone thinks to run.

Skipping this is not a build failure, which is what makes it worth a
step. A stale dependency tree usually compiles and then misbehaves at
runtime, and the hour goes to debugging the code that was merged rather
than the install that wasn't. When in doubt, install everything — it
is seconds when nothing changed.

**5. Rebuild.** The project's full build — not just its typecheck, if
the two differ, and not just one half of a multi-part build: a server
compiled against a stale client bundle presents as a UI bug rather
than a build one. If the build fails, **stop and report the error**;
do not restart onto half-written output.

**6. Restart.** The process that serves the build, with whatever
command the project uses for it. Mind the checkout question above.

**7. Confirm.** Check the process actually came back on new code —
its pid changed, it is alive, its reported version or start time
moved. A restart that silently failed leaves the old process running
and every subsequent test measuring the old code.

## Afterwards

Say what changed, concretely: the commit range the rebase brought in
(`git log --oneline <old>..HEAD`), whether the build was clean, the
new pid. That list is the point of the exercise — it is the answer to
"what am I now testing?"

Then return to the LIVE loop and `listen`. `/rrr` is preparation; the
operator usually has something they wanted to test *on* merged code,
and that instruction is the next signal.

## In the brane repository itself

Everything below applies only when the fold **is** the brane checkout
— the one whose `dist/` the daemon is running. In any other project,
none of it does.

**The four r's, concretely.** Rebuild is `npm run build` — `tsc` plus
the Expo web export. Not `npx tsc` alone: that leaves `expo/dist/`
stale, so the daemon serves the *old* app bundle over the new server.
Restart is `brane daemon restart`; it preserves port and token, so
existing links and QR codes keep working. Confirm with `brane daemon
status` and check the pid moved.

**The daemon is one process per machine, and restart keeps it where it
is.** `brane daemon restart` asks the running daemon to start its own
successor: the same script, from the same checkout, with the same
environment and so the same permissions the operator started it with,
not your shell's. A restart run from another checkout therefore
restarts the daemon's own checkout, and says so. Putting a different
checkout's build in as the daemon is the operator's call: `brane daemon
stop`, then `brane daemon start` from that checkout. `/rrr` belongs in
the checkout the daemon already runs from; confirm with `whoami`'s
`fold_dir` against `brane doctor`'s daemon line rather than assuming.
If the daemon is not running, an agent cannot start it: say so, and ask
the operator to run `brane daemon start`. Nor can an agent stop it
(`brane daemon stop` refuses in your session), and a daemon too old to
restart itself refuses a restart from your session: ask the operator to
run `brane daemon stop`, then `brane daemon start`.

**What the blink is.** Every agent's MCP bridge drops, the app
reconnects, terminal mirrors resync — a few seconds, and none of it is
news to the operator.

**Two package trees.** `package-lock.json` at the root and
`expo/package-lock.json`, each with its own `node_modules`, not a
workspace. `npm run build` *runs* the Expo build (`npm run build:web
--prefix expo`) but never installs for it. So step 4's diff is:

```
git diff --name-only <old>..HEAD -- \
  package-lock.json expo/package-lock.json expo/patches
```

- root lockfile → `npm i`
- `expo/package-lock.json` **or** `expo/patches/` → `(cd expo; npm i)`
- both, or you'd rather not read the diff → `npm i && (cd expo; npm i)`

`expo/patches/` is there because `expo/package.json`'s `postinstall`
runs `patch-package`.

**Your own bridge goes down with it.** You are restarting the daemon
your MCP bridge is connected to. The bridge reconnects on its own with
backoff, but in the window around the restart a brane call in flight
comes back `daemon connection lost (reconnecting — please retry)` and
a parked `listen` is answered and dropped. **Retry the call.** Once.
That error is the restart working, not the restart failing — and it is
not something to narrate an alarm about. Only if calls are still
failing after several seconds of retries has something actually gone
wrong; then report it with the real error text, and check `brane
daemon logs` before concluding anything.

**Protocol changes need no `/rrr`.** The daemon reads `protocols/`
from disk on every `read_protocol`, so a protocol edit is live the
moment it is written. Same for `wiki/`. If a rebase brought in only
markdown under those directories, the rebuild and restart are honest
work but they are not what made the change take effect — say so rather
than implying the restart was load-bearing.
