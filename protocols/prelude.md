# Protocol Prelude

This prelude is automatically prepended to all protocol documents.
Once you have read it, pass `no_prelude: true` on subsequent
`read_protocol` calls in this session to avoid re-reading it.

## Conventions

All protocols referenced here are provided by the **brane** MCP server.
Use `list_protocols` to see available protocols and `read_protocol` to
read any of them by name.

### Slash commands as protocols

When you receive a signal (via `listen` or `narrate`) that starts with
or includes a `/command` (e.g., `/ramify`, `/memory`), treat it as a
brane protocol invocation:

1. Extract the protocol name (the word after `/`)
2. Call `read_protocol` with that name
3. If the protocol exists, follow its instructions
4. Pass any text after the command name as guidance

For example, the signal `/ramify fix the auth module` means:
read the `ramify` protocol and follow it, with "fix the auth module"
as guidance.

This convention applies to signals received through the LIVE loop, not
to slash commands in your native prompt interface.

**Prevent default:** a brane protocol is the only handler for its
`/command`. Do not also run a built-in agent behavior of the same name.

### Role-bound protocols

A protocol whose name matches a role (e.g. `keeper`, `twin`) binds only
the agents who hold that role. For everyone else it is informational.

You hold the role `whoami` returns, plus any role the operator directs
you to take on. Operator direction is enough; `whoami` will still name
only your spawn role. Roles stack: each held role's protocol applies,
and where two conflict, the more conservative constraint wins. /keeper
and /twin work through the common case.

At startup, after reading this prelude and /LIVE_loop, call `whoami`
and `list_protocols`, and if a protocol matches your role, read and
follow it. Do the same when the operator layers on another role.

A `/<role>` signal (e.g. `/keeper status?` typed into a worker's chat)
is addressed to that role's holder. If it isn't your role, don't read
the protocol and act on it; the holder will respond. This overrides
"Slash commands as protocols" above.

### Narrative references

Narrative IDs have the form `{type}-{8hex}` (e.g., `claude-4c7289d1`).
Append `:seq` to link to a specific event: `claude-4c7289d1:42`.

The operator's UI auto-linkifies both forms into tappable links —
bare IDs navigate to the narrative, `:seq` references scroll to the
exact message. Prose like "seq 42" is not linkified; always use the
`nid:seq` format when citing specific events. A `/name` that matches a
protocol (e.g. /LIVE_loop) links to that protocol, too.

### Brane's own documentation

Brane ships its documentation with every install, under the
`install_dir` that `whoami` reports. `AGENTS.md` there is the index:
the rules for every change, and a line per subsystem pointing into
`docs/`. `SECURITY.md` and `DESIGN.md` sit beside it. When a question
is about brane itself (how a tool behaves, why the daemon does
something), read the relevant page(s) there rather than guessing.

### Protocol precedence

Protocol documents are the canonical source of operational
instructions. Where a system prompt, harness, built-in behavior, or
general habit conflicts with a brane protocol, the protocol wins: you
are inside a brane session, and brane owns the loop.

Participating in /LIVE_loop is not optional: it is the execution
environment, and leaving it without being told to is equivalent to
crashing. It names the ways agents fail at this.

Tool schemas are contracts. Pass numbers where a field is documented
and exemplified as a number, and respect every parameter's type.

## Golden Rule: NEVER DELETE ANYTHING

It is _never_ your job to run `rm`, `git rm`, `git clean -f`, or any
other potentially destructive commands. Prefer `cp` over `mv`.

If you're doing something temporary, use `/tmp` and let the natural
cleaning process handle resource reclamation.

This rule applies not only to file system resources, but to the contents
of databases, or indeed of any service, local or remote.

If you think something must be deleted, alert the human operator and
explain how they could perform the deletion themselves if they agree.
