# Brane Wiki

What brane is, why it's shaped the way it is, and what it asks of the
agents that run inside it. The narratives are the read path and the
source of truth; these pages are an opinionated projection of them
([why-wikis-work](why-wikis-work.md)). When a page disagrees with the
narrative record, the record wins.

Citations like `claude-4c7289d1:42` point into the maintainer's own brane,
where the argument was first made. Outside it they don't resolve; they
record provenance, and in your own brane the same form links your own
narratives.

New here? Read in order:

1. [sedimentary-superintelligence](sedimentary-superintelligence.md) —
   the one-paragraph pitch: an archive smarter than you, inert at rest.
2. [why-wikis-work](why-wikis-work.md) — why a second brain works, where
   it fails, and why this directory exists anyway.
3. [sequestering-the-narrative](sequestering-the-narrative.md) — the
   narrative held apart from scrollback and context window.
4. [owning-your-narratives](owning-your-narratives.md) — what that asks
   of an agent, turn by turn.
5. [premature-ontologies](premature-ontologies.md) — the intellectual
   inheritance: why refusing a typology is the substrate decision.
6. [append-only-event-log](append-only-event-log.md) — the one code-level
   commitment everything above rests on.

## Theses — what brane believes
- [sedimentary-superintelligence](sedimentary-superintelligence.md) — an archive of accumulated dialogue smarter than any user yet inert at rest; intelligence lives in the act of integration, not the sediment.
- [sequestering-the-narrative](sequestering-the-narrative.md) — the narrative held apart from disposable scrollback, volatile context, and other agents' records.
- [owning-your-narratives](owning-your-narratives.md) — the agent practice that follows: narrate for downstream retrieval, not upstream expression.
- [premature-ontologies](premature-ontologies.md) — why committing a typology before its categories have earned their scope keeps failing; the refusal of taxonomy-as-substrate.
- [why-wikis-work](why-wikis-work.md) — where the wiki pattern wins, where it struggles, and why this directory is a disciplined compromise.

## Substrate — how brane keeps its word
- [append-only-event-log](append-only-event-log.md) — the single immutable SQLite table behind every narrative; integrity enforced by schema, not convention.

## Mechanism lives elsewhere

The daemon, transports, agent adapters, security model, and the LIVE
loop's exact tool contract are documented in `AGENTS.md` (an index into `docs/`), `DESIGN.md`,
`SECURITY.md`, and `protocols/` — all shipped alongside this wiki and
maintained with the code. Pages here make arguments; those files
describe machinery.

## Local to the brane fold, not shipped

The brane checkout's `wiki/` holds further pages that are either
brane-internal or still settling: `brane-ontology` and
`why-tailscale`. They are local pages of that fold — readable by
agents working in the checkout, not published with the package and
not visible from other folds. They are not private: the source
repository npm publishes from, `benjamn/brane-npm`, carries them.
