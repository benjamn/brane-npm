# Doctor

`brane doctor` answers "is this install sound?" on the machine it landed on.
It prints a short table of environment checks and then runs the **shipped
test suite** — `dist/test/*.test.js` ships in the tarball on purpose — under
the same `node` that runs the CLI, streaming the reporter and exiting with
its status. The suite needs no daemon, tmux, network, or model download: the
search tests inject a stub embedder and the wiki/fold tests use temp dirs and
in-memory SQLite, so a red result is the install, not the environment.

No test may open the operator's database. `openDatabase()` throws when
`NODE_TEST_CONTEXT` is set (which `node --test` does in every test process),
so a code path that reaches it without a `db` fails its test instead of
opening `~/.brane/brane.db` and running migrations on it — from a checkout or
from `doctor` on an installed machine. Code the suite drives takes a `db`
(`getConfig(key, db)`); tests build theirs with `createTestDb()`.

Two tests read *source* rather than import code (`api-request.test.ts` lints
`expo/lib/api.ts`; `key-routing.test.ts` lints two `.tsx` files). The source
isn't in the tarball, so they `skip` with a reason when it's absent — green by
construction from an install, still enforced from a checkout. A source-reading
test added later must do the same, or `doctor` goes red on every install.

The daemon check asks two questions: is one running (and from which
checkout), and can *this shell* reach it. Outside an agent session the CLI
holds no token and reaches the daemon only over `~/.brane/daemon.sock`, so
the check fails, with the reason, when the daemon is not listening there or
`~/.brane` is not `0700` and its own (`shellReachProblem()`). A `– token
file` line appears when `~/.brane/.daemon_token` is still on disk: older
branes kept this machine's local token there, the daemon empties it at its
first start, and removing the leftover is the operator's to do, with the
`rm` line printed (`leftoverTokenFile()`; see [No local
token](token-rotation.md#no-local-token)).

The `protocols` line reads the library as an agent spawned in the current
directory would see it: this directory's `.brane/protocols` (if any),
`~/.brane/protocols`, and this install's built-ins. It names every protocol
outside `brane` and what it shadows, and turns to a warning listing each
ignored file and why (`protocolsCheck()`; see [Protocols](protocols.md#trust)):
a protocol there instructs agents with no diff to review, so this is the one
place they all show.

`--no-suite` runs only the environment checks; `--suite-only` runs only the
tests (`brane doctor --suite-only` is the one-liner for a bug report).
