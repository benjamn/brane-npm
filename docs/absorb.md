# Absorb

`brane absorb` imports conversation history from external LLM providers. Input is an **extracted export directory** (not a ZIP). `--fold` is required.

The import runs **in the daemon**: `brane absorb` POSTs to `/api/absorb` and prints what comes back. `src/absorb/run.ts` holds the orchestration the CLI used to do in-process (`runAbsorb`), and the route streams its `AbsorbEvent`s as NDJSON — `info` lines for the pre-flight report, throttled `progress` lines the CLI renders as its `\r` counter, and a final `summary`; a failure after the stream has opened ends it with an `error` line, while anything the operator has to fix (unknown provider, missing directory, no identity, a fold the daemon would refuse) is refused as a plain 400/403 before the stream opens (`AbsorbInputError`, `FoldRegistrationError`) — a dry run checks the fold too, so it cannot pass a case the real run would fail. A successful import kicks off a memory indexing pass, not awaited, so search works right after it. The CLI resolves relative paths against its own cwd before sending, since the daemon's cwd means nothing to the operator; `~/…` is left for the daemon to expand. The organelle importer yields to the event loop between narratives so the daemon keeps answering — and so the progress lines actually reach the client mid-run.

```bash
brane absorb chatgpt <export-dir> --fold <fold-path> --dry-run  # preview
brane absorb chatgpt <export-dir> --fold <fold-path>            # import
```

The absorb pipeline:
1. Scans directory for conversation shards (`conversations-NNN.json`) + `user.json`
2. Builds a file index mapping asset pointer IDs to local files
3. Stream-parses each shard (one conversation at a time, low memory)
4. Resolves image asset pointers → copies files to `~/.brane/payloads/`
5. Extracts audio transcription text alongside string content parts
6. Inserts conversations as archived narratives with `role: "absorbed"`

`--dry-run` exercises all parsing and asset resolution without writing to the database.

## Local sources

The export providers above read a directory the operator asked a vendor
for. A **local source** reads a session store an agent harness keeps on this
machine, in place, and can be read again tomorrow. `brane absorb claude` is
the first: `~/.claude/projects/<cwd>/<session>.jsonl`, the engineering
half of a Claude user's history, already on the disk of anyone who has run
`claude` once. It is the launch demo — one command and every Claude Code
session ever run is searchable — and the reason `brane absorb survey`
exists: a new user's first step is to be told what is there. A bare
`brane absorb` prints usage, which names it.

```bash
brane absorb                          # usage, naming the providers and `survey`
brane absorb survey                   # what this machine has, what an import would do
brane absorb claude --dry-run         # the import, planned
brane absorb claude                   # the import
brane absorb claude --fold ~/dev/app  # only sessions run in that directory
brane absorb claude --since 2w        # only sessions active recently
brane absorb claude --session 3f1a    # one session, by id prefix
brane absorb claude ~/backup/.claude  # a copied store instead of ~/.claude
brane absorb claude --rebuild         # re-derive absorbed sessions nobody has written into
```

| Piece | Where | Does |
|---|---|---|
| `LocalSource` | `src/absorb/types.ts` | The seam: `locate` (is the store here), `identity`, `survey` (one cheap row per session — a stat and a head read, never message content), `extract` (the parse) |
| `claudeCodeSource` | `src/absorb/claude-code.ts` | Survey and parser for Claude Code's JSONL |
| `surveyAbsorbSources()` | `src/absorb/sources.ts` | The inventory behind `brane absorb survey` and `GET /api/absorb/survey`; also the `PROBES` — stores brane recognises but cannot read yet (codex, goose, copilot, gemini, cline, amp, Claude Desktop agent-mode), reported as *found, no extractor* so the operator learns what is there either way. The list is the tools brane spawns plus Claude Desktop, because those formats have been looked at, not because a source needs spawn support: an importer for a tool brane cannot run is welcome, the probes just aren't speculative (claude-xiy9e8wq:16, :17) |
| `classifySessions()` | `src/absorb/sources.ts` | Each session as `managed` / absorbed-`unchanged` / absorbed-changed / `new`, shared by survey and import so the two cannot disagree. "Unchanged" means same size and mtime *and* read by a parser as new as this one |
| `runLocalAbsorb()` | `src/absorb/run.ts` | The import: survey → select → classify → parse only what is new or changed |
| `createAbsorbContext()` / `absorbOne()` | `src/absorb/index.ts` | The per-conversation *plan* and the write that follows it exactly; the ChatGPT stream feeds the same pair |

Four things are less obvious than they look:

**Idempotent per message, not per conversation.** The count-based append
the ChatGPT path uses ("more messages than events → append the tail")
cannot survive Claude's `--fork-session`, which copies a predecessor's
records — ids included — into the successor's file. `absorb_messages` keys
every written message by the provider's own id (`uuid`); a key already held
is never written again, wherever it is read from. A successor file therefore
lands as **only its new messages, the first of them `re` the predecessor's
last** — a fork reads as a continuation, the same shape the twin protocol
gives a live fork. A file that repeats another with nothing after it is not a
narrative and is skipped. Sessions are absorbed oldest first so the
predecessor's keys are always there before the successor asks (the cost
backfill's ordering rule, for the same reason).

**`--brane` is a destination, and destinations are independent.** Both
ledgers and the absorbed-narrative lookup are keyed by brane as well as
provider, so the same store imported into two branes is two complete
copies, each with its own idempotent re-runs. The first cut keyed on
provider alone, and a second brane saw every file as "unchanged" and read
nothing (claude-xiy9e8wq:38); the provider-only rows were carried over by a
migration that keeps the old tables as `_v1`. The survey answers for the
brane a plain `brane absorb <source>` would target, the one derived from
the account.

**Sessions brane already owns are not imported** (claude-xiy9e8wq:13). A
brane-spawned agent's session file sits in the same store as everyone else's.
`classifySessions` marks a session `managed` when a live (non-absorbed)
narrative of that agent type holds its id in `agent_session_id` or
`session_ids`, and the import skips it and says so. Beneath that, the append
path matches only `role = 'absorbed'` narratives, so nothing an import reads
can ever be written into a live narrative's log. The agent-type filter is
load-bearing, not an oversight: an ordinary `claude` run in a fold with a
`.mcp.json` still bridges in, as an `external` narrative holding the session
id, and it is deliberately *not* managed. That narrative is a participant
that narrates almost nothing; the transcript is the only copy of the
conversation, so skipping it would make the conversation unsearchable rather
than deduplicated. The two coexist — the participant live in the home brane,
the record absorbed into the account's.

**Tool calls go to `tool_uses`, not into the text** (claude-xlolbv6l:65). A
`tool_use` block becomes a row with `source: "absorb"` through the same
`recordToolUse` the hooks use, keyed on the block's `toolu_…` id; the
`tool_result` that follows supplies output, `failed` on `is_error`, and a
duration from the two records' timestamps. `recordToolUse` grew an optional
`afterSeq` for this: a hook's row belongs at the narrative's head because the
call is happening now, an absorbed row belongs beside the message that made
it. `thinking` blocks are not imported, and reasoning is not something
absorb promises for any source: some tools withhold it, brane has nowhere
to show it, it is far more text than a reader wants, and it reads as
authoritative while being the part most likely to be wrong
(claude-xiy9e8wq:20, :22). A narrative still never records itself: for a brane-managed session the whole
file is skipped, so no `narrate`/`listen` row is ever written from a
transcript.

**A user turn is not always the operator's.** Claude Code writes its own
text into `user` records, each kind in a tag, and read as prose the tags
show through (claude-xiy9e8wq:29). Measured over one machine's store, by
text block: 2,100 `<task-notification>` (a background task finished), 398
`[Request interrupted by user]`, 17 `<command-name>` slash commands with
their `<local-command-stdout>`, and 9 `<bash-input>`/`<bash-stdout>` pairs
from `!` commands. `classifyUserBlock` gives each the rendering its meaning
calls for, per block, so typed text beside an injected block keeps its own
shape: a `!` command becomes `$ cmd` in a `sh` fence and its output a plain
fence (stderr labelled), a slash command a code span, an interrupt an italic
marker. A task notification is the completion of a call the agent made, not
something the operator said, so it becomes a `tool_uses` row of its own
(`name: task-notification`, keyed on the record uuid since one task can
notify twice, `parent_id` the call's `toolu_…` id when the harness names it)
and never enters the chat. Fences are sized past the longest backtick run
inside them, so a captured code block cannot break out.

**A message sent mid-turn is an attachment, and the attachment is the
receipt** (claude-jdfccmvh:10). What the operator types while the agent is
working is never written as a `user` record. The harness queues it
(`queue-operation`: enqueue, then dequeue or remove), and when the running
turn takes it in, writes an `attachment` of type `queued_command` at the
point the agent read it — after the tool result it was waiting on, in the
`parentUuid` chain — stamped with the time it was typed. Reading only `user`
records dropped every such message, and left the record full of confident
answers to questions it did not contain. `queuedTurnOf` reads the attachment
and nothing else: `commandMode: "prompt"` is the operator's message,
`"task-notification"` is a background task finishing by the same route and
goes to `tool_uses` like its `user`-record twin, and an unknown mode is left
out rather than guessed at. The queue-operation records are no second
signal — older harness versions write `remove` with no reason for a
delivery, and task notifications carry no `origin` — and none is needed: a
message the operator cancelled (popped back into the editor) or that was
never delivered has no attachment, so it stays out of the record as it
stayed out of the conversation (claude-jdfccmvh:8). Measured on one
machine's store: 450 attachments, 103 `prompt` and 347 `task-notification`;
of 113 queued messages that never went through, none had one.

**A pasted image is a payload** (claude-7irbudpw:52). Claude Code writes a
pasted image into the `user` record itself, base64 in an `image` block
beside its `[Image #N]` text; an image that arrives mid-turn is a
`turnCompanion` record written the same way, with `isMeta` set and no text.
The parser carries both as `attachments` on the message, the inline
counterpart of the ChatGPT path's `assetPointers`, and the write decodes
them into `~/.brane/payloads/<nid>/<time>_<seq>_<j>.<ext>` with the
extension from the block's `media_type`, so the chat shows them inline
through the payload route with no change on that side. A record with an
image and no words becomes a message reading `(attachment)`, the placeholder
the web app writes for an image-only signal, rather than falling to the
empty-body guard; an `isMeta` record still contributes no text, only its
images. Per-message idempotence covers the files: a message written once has
its payloads written once. `createAbsorbContext` takes a `payloadsDir`
override so the suite never writes under `~/.brane`. Not yet a payload: an
image inside a `tool_result` (a `Read` of a `.png`), because `tool_uses` has
no payload column; today that base64 lands in `output` under the capture cap.

**A parser improvement reaches old narratives late, not out of order.**
Events are append-only, so a record type the parser learns to read (#460's
slash commands, the mid-turn messages above) has no key in `absorb_messages`
and lands at the narrative's tail on the next ordinary re-run — after
messages it preceded. `plan()` notices: a new message that belongs before
something the narrative already holds is written `re` the held message it
follows in the conversation (`lateFor`). It reads as late, it links to its
place, and every `nid:seq` anyone has cited still says what it said. For
the re-run to happen at all, `absorb_files` records which parser read each
file (`LocalSource.parserVersion`): a finished session's file never changes
again, so on (size, mtime) alone the improvement would reach it only through
`--rebuild`. A file last read by an older parser is not "unchanged", and the
next ordinary run reads it once more; the survey counts such files as their
own bucket ("to re-read (newer parser)"), so a parser upgrade does not read
as every absorbed file having changed. Bump the version when the parser
learns to read something it used to skip. That is the default way a parser
change reaches history; `--rebuild` is not. (Run over one machine's store
for the mid-turn change: every absorbed session re-read, 0 of 11,812
existing events altered, one recovered message landing `re` the narration it
interrupted.)

**`--rebuild` is the one deleting operation, and it deletes only a
rendering.** It empties each selected narrative this brane has absorbed —
events, tool rows, ledger rows, memory-index rows and cursor — and imports
its file again: same narrative id and `created_at`, but **seqs from 1**, so
the narrative still resolves and a `nid:seq` citation into it may now land
on a different message; title refreshed; payload files left where they are
and rewritten by name with the same bytes. It is allowed under the golden
rule because the flag is the operator's explicit instruction and what is
discarded is derivable from a file that is demonstrably still on disk (only
survey candidates reach it). That holds only while the narrative is nothing
but that rendering. An absorbed narrative can still be written into — a
signal from the app, a foreign narration, a payload attached live — and
none of that is in any file. So a narrative holding an event with no
`absorb_messages` row (`liveContributions`) is **locked in**: `--rebuild`
reads it as an ordinary re-run, which only appends, and reports it as "Not
rebuilt" (claude-jdfccmvh:13). Talking in an absorbed narrative should be
uncommon anyway — a conversation that wants to continue belongs in a
`/twin`, which reads the record and leaves it alone (claude-jdfccmvh:15).
The guard is in the SQL (`resetAbsorbedNarrative`): only `role =
'absorbed'`, only this brane, only the narrative bound to that session id,
and only one holding nothing but what an import wrote; a live narrative is
never a candidate. Composes with `--fold`, `--since`, `--session` and
`--dry-run`. `memory_content_df` is left alone; `brane memory index
--rebuild` recomputes it. An ordinary re-run also refreshes a narrative's
title from a grown file now, since the harness retitles as it goes.

**No fold is registered.** Each session knows the directory it ran in, and
that becomes the narrative's `fold_path`. Registering it too would call
`registerFold` with the foreign brane id and *rebind* the operator's own
`~/dev/x` to the absorbed brane, changing what `brane spawn` does there. So
for a local source `--fold` is a **filter** ("sessions from this directory"),
never a destination, and the survey reports directories as a count.

What the survey promises a new user, and how it keeps it: nothing is read
but a stat and the first 64 KB of each file (for `cwd` and the start time),
nothing is imported until a source is named, and an import makes no network
call — `src/absorb/` imports node builtins, better-sqlite3 and stream-json,
and nothing else. The identity that names the brane comes from
`~/.claude.json`'s `oauthAccount` (the account uuid, so one person's sessions
from two machines share a brane), falling back to the OS user.

Not yet a source, and each is one `LocalSource` away: Claude Desktop's
agent-mode `audit.jsonl` (stream-json records, plaintext, tool lineage
included), a claude.ai data export, and the codex/goose/copilot/cline stores
whose readers `src/agents.ts` already has for resume and cost.
