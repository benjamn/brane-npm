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
