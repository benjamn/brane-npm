# Session Affinity

A `claude` narrative whose Claude Code talks to Fireworks (an
`ANTHROPIC_BASE_URL` on a `fireworks.ai` host) sends `X-Session-Affinity:
<nid>` with its LLM requests. `ensureSessionAffinityConfig`
(`src/session-affinity.ts`) runs on every spawn and revive, from `doSpawn`,
`prepareAgentLaunch`, and the same-agent revive path in `src/daemon/server.ts`,
and returns `{ args, env }`: CLI args for the agent and an env prefix for the
tmux command. Fireworks uses the header to keep a session on one replica, and
its per-replica KV prefix cache only stays warm that way. The nid survives
revives, so the affinity does too. Every other claude spawn launches exactly as
before. Opt out with `brane config session-affinity.enabled false`.

The header name and its alternatives come from Fireworks' prompt-caching guide:
`x-session-affinity` (header), `prompt_cache_key` (request body, the
preferred field), `user` (body, fallback), and `x-multi-turn-session-id`
(agent traffic). Claude Code can't set a body field (it has no config surface
for one), so the header is what it gets. Cache hits show up as
`usage.cache_read_input_tokens` on the Anthropic-compatible `/v1/messages`
path, which the cost ledger already records, and in the
`fireworks-cached-prompt-tokens` response header.

Claude Code reads `ANTHROPIC_CUSTOM_HEADERS` (newline-separated
`Name: Value`) from its environment. Where that value comes from decides how
brane adds to it:

**A settings file defines it.** A settings file's `env` block is written
*over* the inherited shell value, and settings `env` values are not
`${VAR}`-expanded (verified against claude 2.1.278). So nothing in the shell
can add to it, and a shared fold file could only hold one literal nid. The
workaround is `claude --settings <path>`, which outranks every settings file.
brane writes one file per narrative at `~/.brane/session-affinity/<nid>.json`
containing one key: the value from the highest-precedence file (local >
project > user), with any stale affinity line stripped (case-insensitive
name match, the same parse Claude Code performs) and the affinity line
appended. That value includes whatever credentials the operator's headers
carry, so the file is `0600` in a `0700` directory, re-tightened on every
write. The operator's own settings files are never written. This was verified
end to end against a header-logging listener: the nid arrives, the fold's other
lines come through, and a hand-added stale affinity line is replaced.

**Nothing defines it.** Then Claude Code uses whatever the *session's* shell
inherits, which comes from the tmux server, and the tmux server need not share
the daemon's environment. Reading the daemon's `process.env` into a
`--settings` file would *replace* headers the session had and the daemon
didn't. The first draft did exactly that, and an `X-Shell` header exported
where tmux started disappeared from the wire. So the header goes in the tmux
command's env prefix instead (`shellAffinityEnv`), and the session's own shell
appends it to whatever it inherited. The Fireworks check does read the
daemon's env as a last resort for `ANTHROPIC_BASE_URL`. If that misses a URL
only the session has, the cost is affinity and nothing more.

Managed settings still outrank `--settings`; delivering through them is out of
scope.

**Crush is deliberately left out.** It already sends `x-session-affinity` and
`x-session-id` (a hash of its own session id), and that value wins over any
configured `extra_headers`. A static `$BRANE_NARRATIVE_ID` entry was tried and
never reached the wire. Crush's key changes when a narrative is revived,
because crush starts a new session. Other harnesses have no observed Fireworks
traffic.
