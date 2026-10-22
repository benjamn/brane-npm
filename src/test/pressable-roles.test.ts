import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// React Native Web renders a `Pressable` with no role as a focusable <div>
// with no name: a screen reader lands on it and hears nothing, or hears the
// emoji inside it ("butterfly" for the send button). So every Pressable in
// the app says what it is — a `role` (or the older `accessibilityRole`),
// with an `aria-label` / `accessibilityLabel` when its content is a glyph —
// or opts out of the tab order with `tabIndex={-1}`, which is what a modal's
// tap-to-close backdrop and its card do: they are surfaces, not controls.
// (`focusable={false}` is not an opt-out: RNW's Pressable sets its own
// tabIndex, 0 unless disabled, and only an explicit `tabIndex` wins —
// docs/accessibility.md.) A raw <div onClick> is held to the same rule: the
// list's narrative cards were written that way and were the one control a
// keyboard could not reach at all.
//
// This reads *source*, which the npm tarball does not carry, so it skips when
// the source is absent rather than failing `brane doctor` on every install.

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCAN = ["expo/app", "expo/components"];
const OPENER = /<(Pressable|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback)\b/g;
const DOM_OPENER = /<(div|span)\b/g;
const CLICKS = /\bonClick=/;
const NAMED = /\b(role|accessibilityRole)=/;
const OPTED_OUT = /\btabIndex=\{-1\}/;

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.tsx$/.test(name)) yield p;
  }
}

/** The opening tag starting at `start`: up to the first `>` outside braces. */
function openingTag(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

describe("every Pressable says what it is", () => {
  it("has a role, or tabIndex={-1} to stay out of the tab order; so does a <div onClick>", (t) => {
    if (!SCAN.every((d) => existsSync(join(root, d)))) return t.skip("source is not present (an installed package)");
    const offenders: string[] = [];
    let seen = 0;
    for (const dir of SCAN) {
      for (const file of files(join(root, dir))) {
        const source = readFileSync(file, "utf8");
        for (const m of source.matchAll(OPENER)) {
          seen++;
          const tag = openingTag(source, m.index!);
          if (NAMED.test(tag) || OPTED_OUT.test(tag)) continue;
          const line = source.slice(0, m.index!).split("\n").length;
          offenders.push(`${relative(root, file)}:${line}`);
        }
        for (const m of source.matchAll(DOM_OPENER)) {
          const tag = openingTag(source, m.index!);
          if (!CLICKS.test(tag) || NAMED.test(tag)) continue;
          const line = source.slice(0, m.index!).split("\n").length;
          offenders.push(`${relative(root, file)}:${line} (<${m[1]} onClick>)`);
        }
      }
    }
    assert.ok(seen > 50, `expected to scan the app's Pressables, saw ${seen}`);
    assert.deepEqual(offenders, [], `Controls with no role (and, for a Pressable, no tabIndex={-1}):\n  ${offenders.join("\n  ")}`);
  });
});
