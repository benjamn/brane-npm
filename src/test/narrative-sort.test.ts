import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sortNarratives, type NarrativeOrder } from "../shared/narrative-sort.js";

// Two things are pinned here, and the second is the one that just failed.
//
// The rule: DEAD sinks, LIVE and IDLE interleave. `mcp_connected` must not
// order anything — it flips whenever an agent's own work blocks its bridge, and
// ranking on it moved cards under the operator's thumb for a distinction that
// had already expired.
//
// The reach: the rule has to hold on *every* surface that lists narratives. It
// was fixed in the list screen while the header's switcher kept the older
// three-way rank it had been copied from, so the same narrative sat in two
// different places depending on where you looked at it — a silent regression a
// behavioral test of the shared function alone would never have caught.

type Row = NarrativeOrder & { id: string; mcp_connected?: boolean };

const row = (id: string, status: string, created_at: number, mcp_connected = false): Row =>
  ({ id, status, created_at, mcp_connected });

const ids = (rows: Row[]) => sortNarratives(rows).map((n) => n.id);

describe("sortNarratives", () => {
  test("sinks ended below everything else", () => {
    const rows = [
      row("dead-old", "ended", 100),
      row("live", "active", 200),
      row("dead-new", "ended", 900),
      row("idle", "idle", 300),
    ];
    assert.deepEqual(ids(rows), ["idle", "live", "dead-new", "dead-old"]);
  });

  test("newest first within each group", () => {
    const rows = [row("a", "active", 100), row("c", "active", 300), row("b", "active", 200)];
    assert.deepEqual(ids(rows), ["c", "b", "a"]);
  });

  // The whole point of the change this file guards: a bridge dropping must not
  // reorder anything. Same rows, `mcp_connected` inverted — same order.
  test("mcp_connected does not affect order", () => {
    const rows = [
      row("first", "active", 300, false),
      row("second", "active", 200, true),
      row("third", "active", 100, false),
    ];
    const flipped = rows.map((n) => ({ ...n, mcp_connected: !n.mcp_connected }));
    assert.deepEqual(ids(rows), ["first", "second", "third"]);
    assert.deepEqual(ids(flipped), ["first", "second", "third"]);
  });

  // A connected-but-ended narrative gets the dead badge, so it must sort with
  // the dead. This is the case where the old three-way rank disagreed with the
  // badge outright: it ranked such a row *first*.
  test("ended sinks even while still bridged", () => {
    const rows = [row("bridged-dead", "ended", 900, true), row("live", "active", 100)];
    assert.deepEqual(ids(rows), ["live", "bridged-dead"]);
  });

  test("does not mutate its input", () => {
    const rows = [row("a", "ended", 300), row("b", "active", 100)];
    const before = rows.map((n) => n.id);
    sortNarratives(rows);
    assert.deepEqual(rows.map((n) => n.id), before);
  });

  test("empty and single-element lists are fine", () => {
    assert.deepEqual(sortNarratives([]), []);
    assert.deepEqual(ids([row("only", "ended", 1)]), ["only"]);
  });
});

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");
// Lints source the tarball doesn't ship (`expo/dist/` ships, the `.tsx` does
// not). From an installed package — `brane doctor` — these skip with a reason
// instead of failing on ENOENT.
const skip = existsSync(join(repoRoot, "expo", "app", "index.tsx"))
  ? false
  : "expo source not shipped";

// Every screen that lists narratives, and the local name each one had for its
// own copy of the rule before the extraction.
const LIST_SCREENS = ["expo/app/index.tsx", "expo/app/[nid].tsx"];

describe("narrative-listing screens share one ordering rule", () => {
  for (const file of LIST_SCREENS) {
    test(file, { skip }, () => {
      const src = read(file);
      assert.match(
        src,
        /import \{ sortNarratives \} from "@shared\/narrative-sort"/,
        `${file} must order narratives through @shared/narrative-sort`,
      );
      // A local `rank` over `mcp_connected` is exactly the shape that drifted.
      assert.doesNotMatch(
        src,
        /rank\s*=\s*\([^)]*\)\s*=>[\s\S]{0,80}?mcp_connected/,
        `${file} must not rank narratives on mcp_connected — use sortNarratives`,
      );
      assert.doesNotMatch(
        src,
        /function sortNarratives\b/,
        `${file} must not define its own sortNarratives`,
      );
    });
  }
});
