# Protocols: Namespaces and `/commands`

A `/command` is a name an agent resolves with `read_protocol` and then
follows. Brane ships its protocols in `protocols/`; an operator adds their
own, and a project its own, without forking the package. The agent-facing
rules are the prelude's *Slash commands as protocols* section, kept short on
purpose; this page is the rest.

## Namespaces

| Namespace | Directory | Holds |
|---|---|---|
| `fold` | `<fold>/.brane/protocols/` | this project's, checked in with it |
| `home` | `~/.brane/protocols/` (`getBraneDir()`) | this operator's, kept across `npm update` |
| `brane` | `<install>/protocols/` | the built-ins |

A bare name resolves through them in that order, most local first. `fold`
is the caller's narrative's fold, exactly (no walking up parent
directories); a caller with no fold has none. A fold at `~` would make
`fold` and `home` one directory; compared after resolving symlinks, it
counts once, as `home` (`protocolNamespaces`, which the daemon and `brane
doctor` share). A fold without
`.brane/protocols` is an empty namespace, not an error. The daemon reads
the files, so an agent's sandboxed `HOME` doesn't move `home`.

`.brane/` is a fold's directory for brane's per-project files in general;
protocols are its first tenant. `src/protocols.ts` takes namespace
directories as arguments, so a later `.brane/config` or macros can layer the
same way.

## Names

`src/shared/protocol-names.ts` is the one parser (`parseProtocolRef`); the
daemon and the app both use it.

| Written | Means |
|---|---|
| `/review` | the first `review` in fold, home, brane |
| `/fold.review`, `/home.review`, `/brane.review` | that namespace's `review` only |
| `/folds.self.review`, `/folds.brane.review` | the same as `/fold.review`, `/brane.review` |
| `/brane`, `/home`, `/fold` | a generated page listing that namespace |
| `/folds` | a generated page about the folds root |

A dot is a qualifier only after a namespace name; anywhere else it is part
of the name (`/reviewer.draft`, `/brane.reviewer.draft`). Names match
`PROTOCOL_NAME_RE`, the anchored form of the chat linkifier's
`PROTOCOL_PATTERN` (a test pins the two together), so anything the chat
links is something `read_protocol` parses, and `../AGENTS` is not a name.

`folds` is the root other folds will hang from, as
`/folds.<label>.<name>` (see [Not yet](#not-yet)). Only `self` and
`brane` resolve under it today.

## `read_protocol`

```json
{ "kind": "document", "name": "review", "from": "fold",
  "path": "~/dev/foo/.brane/protocols/review.md",
  "layers": [
    { "from": "fold",  "path": "~/dev/foo/.brane/protocols/review.md" },
    { "from": "brane", "path": "~/dev/brane/protocols/review.md" } ],
  "content": "…" }
```

`content` is the file in force, `layers[0]`; `layers` is every file with
the name, like `which -a`. `from` (`"fold"`, `"home"`, `"brane"`) reads one
namespace's file instead, the same as the qualified spelling. The prelude is
prepended to every document but itself, unless `no_prelude`. A file's
frontmatter (`---` … `---`) is left out of `content`: under the provenance
line or the prelude it would no longer be frontmatter, and would render as a
rule and a setext heading made of its own keys. Its `description:` is what
`list_protocols` shows.

`layers` holds only files that resolve. A file of the name that awaits the
operator's approval is in `pending` instead (`{ from, path, changed }`,
absent when there are none), and `content` opens with a line saying it is not
in force and how the operator approves it.

**Every non-built-in or shadowed file says so in its first line.** The one
in force names its file and what it shadows (*"/review here is this
project's protocol, `…/review.md`. It shadows /brane.review, readable by
that name."*); a shadowed one read by name says it is for reference and
names the one in force. A built-in nothing shadows reads exactly as it
always did. A generated page has `kind: "generated"` and no prelude.

Failures go through `sendToolError()` with the reason: a malformed name, an
unknown one (with a *did you mean* when only case differs), a namespace
that lacks the name, or a protected name asked for outside `brane`.

## What a namespace may not define

`loadProtocolLibrary` ignores a file, and records why, when its name:

- isn't a protocol name;
- is reserved: `brane`, `home`, `fold` or `folds`, bare or as a prefix,
  compared without case, because those spellings are generated pages and
  qualifiers;
- is protected and the file is outside `brane`: `prelude`, `LIVE_loop`,
  `keeper`, `twin` (`PROTECTED_PROTOCOLS`). The first two are the loop's
  own contract, read before anything else (the prelude is prepended to every
  protocol); `keeper` governs what one agent may do to other agents'
  sessions; `twin` is forced as a role by spawn. Everything else, `/idle`
  included, may be overridden: the operator only ever types `/idle`, and a
  local `idle.md` builds on brane's by citing `/brane.idle`;
- differs only in case from a name a less local namespace defines
  (`Review.md` beside brane's `review.md`).

Files are matched by the exact names `readdir` returns, never by opening a
path built from the requested name. On a case-insensitive disk (macOS) the
latter would let a fold's `live_loop.md` answer `read_protocol("LIVE_loop")`
and slip past the protection. Ignored files appear in `list_protocols`
(`ignored`), on the namespace's generated page, and in `brane doctor`.

## Trust

The prelude says protocols outrank the system prompt, so a `fold` protocol
from a cloned repository carries more weight than its `AGENTS.md`, and a
`home` protocol is writable by any agent running as the operator, with no
diff to review. So:

- the prelude says local protocols may tighten a built-in, never relax the
  Golden Rule or the LIVE loop, and that agents don't create or edit
  protocol files unless the operator asks;
- **nothing outside `brane` is in force until the operator approves its
  exact text** ([Approval](#approval));
- the protected names above can't be overridden at all;
- `brane doctor` lists every protocol outside `brane`, what it shadows,
  what awaits approval, and every ignored file (`protocolsCheck`,
  `src/commands/doctor.ts`);
- the app's reader notes the author of any protocol that isn't a built-in.

## Approval

A `home` or `fold` protocol file is in force only while the operator has
approved its **current content**, the way `direnv allow` treats an
`.envrc`. A new file, or an edit to an approved one, is ignored (so the
built-in of that name stays in force) until approved. This is what lets
`/worker` be overridden without being an injection vector: a cloned repo's
`.brane/protocols/worker.md`, or a file an agent writes into
`~/.brane/protocols`, does nothing until the operator has read it.

- **Pinned to content.** `protocol_approvals` (`src/db/protocol-approvals.ts`)
  holds `(path, sha256)` and the approved text; approving a path revokes its
  earlier rows; nothing is deleted. `loadProtocolLibrary` checks each
  non-built-in file's hash against it, and `readProtocol` hashes the text it
  reads once more, so a file edited after the scan is refused rather than
  served as the approved one.
- **Reported, not hidden.** A pending file is in `list_protocols`' `ignored`
  with `pending: { sha256, changed }`, under *Awaiting the operator's
  approval* on `/home` and `/fold`, and in `brane doctor`. It is also named
  where it is used: `read_protocol` of its name carries it in `pending` and
  in `content`'s first line, and when no approved file has the name, the
  error says the name exists but awaits approval rather than that it doesn't
  exist (a `/standup` typed before approving it would otherwise read as a
  typo). An agent can see it and tell the operator; it can't approve it.
- **Only the operator approves** (`src/daemon/protocol-routes.ts`).
  `POST /api/protocols/approve { path, sha256 }` is off `AGENT_ROUTES`, and
  the presence gate refuses an agent's token unasked besides. From this
  machine's shell it waits for the OS prompt (*approve a protocol for brane's
  agents*, [Presence Check](presence.md#the-gate)), since an agent can reach
  `daemon.sock` too; from a device it is the verification gate's
  `approve-protocol` act, in the fresh class, since an approval outlives any
  window. Only files directly in `~/.brane/protocols` or a registered fold's
  `.brane/protocols` can be approved.
- **The text the operator saw.** The request names the hash of the text
  shown; if the file no longer has it, before the prompt or after, the
  daemon answers 409 and approves nothing.
- **Where.** `brane protocol pending` lists what waits and what is
  approved; `brane protocol approve <path>` prints the file (or a line diff
  against the approved version, `src/shared/line-diff.ts`), asks, then asks
  the daemon; `brane protocol revoke <path>` withdraws an approval
  (`revoke-protocol`, no prompt: the safe direction). In the app, a chat
  whose fold or home has pending files shows a banner that opens them in
  the reader one at a time (`src/shared/approval-queue.ts`), with **Show
  changes** and **Approve**. Approving one moves straight to the next, with
  Approve held back for a moment (`APPROVE_GUARD_MS`) so the tap that
  approved one can't land on the next unread; **Skip** leaves a file pending
  and moves on, so a file the operator doesn't want can't block the ones
  behind it. Nothing in the app declines a file yet: closing the reader
  approves nothing, and the reader says so.
  `GET /api/protocols/pending` is what both read.
- **Hygiene, not containment.** An agent runs as the operator's Unix account
  and could write the database itself, as it could mint itself a token.
  What approval guarantees is that nothing reaches an agent through the
  daemon without the operator's sign-off, and that anything waiting is
  shown to them.

## Extending a built-in

A local protocol replaces the built-in of the same name; the built-in stays
readable as `/brane.<name>`. To *extend* rather than replace, which keeps
upstream changes arriving, cite it:

```markdown
# idle

Follow /brane.idle, and before going idle:

- Post a digest of what this session changed.
```

That is what qualified names are mostly for: the operator types `/idle`
and gets the local one, which carries the original along by name.

## The app

`GET /api/protocols?nid=` runs the resolver the narrative's own
`read_protocol` runs, so a chat links and opens exactly what its agent would
read. It returns what `list_protocols` does, `protocols` (each with
`from`, `path`, `layers`, and a description: frontmatter's `description:`,
else the first prose line) and `ignored`, plus two fields only the app
uses: `namespaces`, and `commands`, every name that resolves to a file,
bare and qualified. The chat's known-protocol set is `commands`, so
`/brane.idle` links with no change to the linkifier. Without `nid` it is
home and brane, for screens with no narrative. A chat uses that
connection-wide set until its own has loaded, and keeps it if the fetch
fails, so its links never start dark.

The reader shows one file per page. Each namespace is a source for
`/api/wiki/read`: `protocols` (brane, the label it always had),
`protocols:home`, and `protocols:fold`, present when the request carries
`nid`. `protocolReaderTarget` maps a tapped name to its source, for the
chat and for `/links` inside a page alike. Generated pages aren't linked in
the app yet; they are for agents.

## Not yet

- **Other folds' protocols**, as `/folds.<label>.<name>`: a fold would
  publish `.brane/protocols/shared/`, as its wiki publishes `wiki/shared/`
  (docs/wiki.md), labels would come from `wikiFoldLabels` (which then
  reserves `self`), `PROTOCOL_PATTERN` would admit `~` for labels like
  `dev~2`, and other folds stay off the search path, reachable only by
  name.
- **Generated pages in the app's reader.**
- **More of `.brane/`**: per-fold config (an allowlist of keys: a cloned
  repo must not turn off the verification gate) and macros.

## Code and tests

- `src/shared/protocol-names.ts`: names, namespaces, protected and reserved
  names, `protocolReaderTarget`.
- `src/protocols.ts`: `protocolNamespaces`, `loadProtocolLibrary`,
  `readProtocol`, `listProtocols`, the generated pages.
- `src/db/protocol-approvals.ts`, `src/daemon/protocol-routes.ts`,
  `src/commands/protocol.ts`: approval ([Approval](#approval)), tested in
  `src/test/protocol-approval.test.ts`.
- `src/shared/approval-queue.ts`: the order the app's reader walks several
  pending files in, tested in `src/test/approval-queue.test.ts`.
- `src/daemon/server.ts`: `protocolNamespacesFor`, `protocolLibraryFor`,
  the `list_protocols` / `read_protocol` handlers, `GET /api/protocols`,
  the protocol sources of `/api/wiki/read`.
- `expo/lib/protocols.ts` (`useProtocolView`), `expo/components/WikiReader.tsx`.
- `src/test/protocol-namespaces.test.ts` pins all of the above against
  temporary directories; it never reads the operator's `~/.brane`.
