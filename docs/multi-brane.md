# Multi-Brane

A single daemon can host multiple branes. The **home brane** is auto-generated on first run (`brane-<hex>`). Foreign branes are created by `brane absorb` when importing conversation history from other providers.

- **Narratives** have a `brane_id` column linking them to their brane
- **Folds** have a `brane_id` column — `brane spawn` inherits the fold's brane_id
- **Absorb** creates a deterministic foreign brane_id from `sha256(provider:identity_id)`, ensuring re-imports target the same brane
- **`brane list`** groups narratives by brane with per-brane limits
- **`GET /api/branes`** returns all branes with narrative counts for the web UI
- **BraneSwitcher** in the Expo app replaces the old DaemonSwitcher — shows branes in a flat list, filters narratives by selected brane

Brane_id resolution chain for new narratives: fold's `brane_id` → `config default.brane` → home brane (`getBraneId`).

Existing folds are backfilled to the home brane on upgrade (idempotent, runs on every `openDatabase()`).

## Archived branes

A brane has no row of its own: it is the `brane_id` its narratives share. Archiving one writes a row in `branes` (`brane_id`, `archived`, `archived_at`), lazily and never deleted; unarchiving clears the flag (`src/db/branes.ts`, `PATCH /api/branes/archive`). The switcher offers it on each brane row's ⋯ and lists archived branes, with **Unarchive**, behind **Show N archived**, under the daemon that holds them.

What an archived brane hides:

- **The brane itself** from `GET /api/branes`, unless `archived=1`. `list_branes` still returns it, flagged `archived`, so an agent can reach it on purpose.
- **Its ended narratives** from every listing that names no brane: the app's All branes and its cost total, `brane list`, `brane memory log`. Naming the brane (`brane_ids`, or selecting it in the switcher) still shows all of it.

What it never hides is a **running** narrative: one whose status is not `ended`, or whose agent is on the bridge. Archiving a single narrative is refused while it runs (`src/daemon/archive-gate.ts`) so that a rogue agent can't drop out of sight, and an agent may spawn into an archived brane, so the brane must not become a hiding place either.

Two branes can't be archived: the **home brane**, where every spawn without a brane lands, and **the last brane not already archived**, which would leave All branes with nothing. The daemon refuses both with the reason; the switcher doesn't offer them. Archiving is an operator act, closed to agents' tokens.
