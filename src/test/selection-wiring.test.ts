import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The chat's message selection lives in a store (shared/message-selection), not
// in the screen's React state, and the difference is invisible to every test
// that can run in node: both spellings select messages. What the store buys is
// two things a rendered test would have to catch — a tap that wakes only the
// bubble it changed, and two taps in the same frame that both land. The
// `useState` spelling failed the second outright: `handleTimestampPress` closed
// over `selectedSeqs`, so the second tap computed from the set the first had
// already replaced and silently undid it (observed in a headless browser: two
// rapid taps left one message selected).
//
// So this reads the source, the way key-routing.test.ts does, and holds the
// screen to the wiring.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCREEN = join("expo", "app", "[nid].tsx");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");
// Lints source the tarball doesn't ship, so an installed package skips rather
// than failing on ENOENT (`brane doctor` runs this suite).
const skip = !existsSync(join(repoRoot, SCREEN)) ? "expo source not shipped" : false;

describe("the chat's message selection is a store, not screen state", () => {
  test("the screen holds no selection state", { skip }, () => {
    const src = read(SCREEN);
    assert.ok(
      !/useState<Set<number>>/.test(src),
      "a Set in useState is the shape this replaced: it re-renders the screen, which rebuilds renderItem, which re-renders every bubble",
    );
    assert.match(src, /useMessageSelection\(/, "the screen creates the selection store");
  });

  test("the toggle closes over the store, not over the selection", { skip }, () => {
    const src = read(SCREEN);
    const press = src.match(/const handleTimestampPress = useCallback\([\s\S]*?\}, \[([^\]]*)\]\);/);
    assert.ok(press, "handleTimestampPress must be a useCallback with a dependency list");
    const deps = press![1].split(",").map((d) => d.trim()).filter(Boolean);
    assert.deepEqual(
      deps.filter((d) => d !== "router" && d !== "selection"),
      [],
      "any dependency that changes with the selection rebuilds every bubble's callback prop",
    );
  });

  test("renderItem hands the bubble the store, not a boolean", { skip }, () => {
    const src = read(SCREEN);
    assert.match(src, /selection=\{selection\}/, "the bubble subscribes for itself");
    assert.ok(
      !/selected=\{[^}]*\.has\(/.test(src),
      "a computed `selected` prop puts the whole list back on the selection's re-render path",
    );
  });

  test("the bubble subscribes to its own seq", { skip }, () => {
    const src = read(SCREEN);
    assert.match(src, /useIsSelected\(selection, item\.seq\)/);
  });

  test("a send consumes the selection through handleDeselect, URL included", { skip }, () => {
    // `?scrollToSeq=` is what makes a selection survive a reload, so a send
    // that clears only the store leaves the param behind: a reload, Isolate or
    // Meld re-selects the message just answered, and the next signal silently
    // carries the old `re` again. `handleDeselect` clears both.
    const src = read(SCREEN);
    const send = src.match(/const handleSend = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/);
    assert.ok(send, "handleSend must be a useCallback with a dependency list");
    assert.match(send![0], /onDeselect\(\)/, "the send hands the clear to the screen's handleDeselect");
    assert.ok(!/selection\.clear\(\)/.test(send![0]), "clearing the store alone strands ?scrollToSeq=");
    assert.match(src, /<InputBar[\s\S]*?onDeselect=\{handleDeselect\}/, "the composer is given handleDeselect");
    const deselect = src.match(/const handleDeselect = useCallback\([\s\S]*?\}, \[[^\]]*\]\);/);
    assert.ok(deselect && /scrollToSeq: undefined/.test(deselect[0]), "handleDeselect clears the param");
  });
});
