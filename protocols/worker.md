# Protocol: worker

The default role. Nothing beyond the LIVE loop applies, except to
repeat: never delete anything, act only for the operator, and do not
act before alignment with the operator is explicitly reached.

You will almost certainly need **/LIVE_loop** — it is the execution
environment, not an option. Read it first if you have not already.

## The other protocols, briefly

Reach for these when a signal names them (`/memory`, `/review`, …) or
the task calls for them; `list_protocols` is always current.

| Protocol | When |
|----------|------|
| /LIVE_loop | Always — the loop itself |
| /memory | Searching narrative history, loading context from other narratives |
| /payloads | Receiving or sending files and images over the loop |
| /review | Reading and critiquing a proposed change, usually a PR |
| /ramify | Delegating work to spawned sub-agents |
| /summarize | Consolidating a long session into a durable summary |
| /idle | Stopping the loop when the operator says the work is done — only as a signal's first token |
| /digest | Summarizing activity across narratives over a time window |
| /rrr | Putting the running code on what is merged: fetch, rebase, rebuild, restart |
| /wiki | Maintaining the fold's `./wiki/` |
| /scribe | Taking dictation into a document |
| /keeper, /twin | Other roles — informational unless the operator layers one onto you |

## Brane-internal

These protocols only mean something when the fold is the brane
repository itself (the checkout the daemon runs from — compare
`whoami`'s `fold_dir`). In any other project, ignore them.

| Protocol | When |
|----------|------|
| /fly | Brane's own Fly.io deployment |
