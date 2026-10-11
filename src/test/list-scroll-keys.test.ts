import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ARROW_STEP_PX,
  PAGE_FRACTION,
  isListScrollKey,
  listScrollTarget,
} from "../shared/list-scroll-keys.js";

// The narrative list scrolls itself for the browser's scroll keys when nothing
// in it has focus. These tests pin the arithmetic. The routing (route focus,
// modals, editables) is pinned in key-routing.test.ts.

const bare = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
const list = { clientHeight: 800, scrollHeight: 5000 }; // max scrollTop 4200

describe("isListScrollKey", () => {
  it("takes the six unmodified scroll keys", () => {
    for (const key of ["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"]) {
      assert.equal(isListScrollKey({ key, ...bare }), true, key);
    }
  });

  it("leaves other keys alone", () => {
    for (const key of ["ArrowLeft", "ArrowRight", " ", "a", "Enter", "Escape", "Tab"]) {
      assert.equal(isListScrollKey({ key, ...bare }), false, JSON.stringify(key));
    }
  });

  it("leaves modified scroll keys to the browser and OS", () => {
    for (const mod of ["metaKey", "ctrlKey", "altKey", "shiftKey"] as const) {
      assert.equal(isListScrollKey({ key: "ArrowDown", ...bare, [mod]: true }), false, mod);
    }
  });
});

describe("listScrollTarget", () => {
  it("steps an arrow's worth", () => {
    assert.equal(listScrollTarget("ArrowDown", 1000, list), 1000 + ARROW_STEP_PX);
    assert.equal(listScrollTarget("ArrowUp", 1000, list), 1000 - ARROW_STEP_PX);
  });

  it("pages by most of the visible height, so a line of the old page stays", () => {
    const page = 800 * PAGE_FRACTION;
    assert.ok(page < 800);
    assert.equal(listScrollTarget("PageDown", 1000, list), 1000 + page);
    assert.equal(listScrollTarget("PageUp", 1000, list), 1000 - page);
  });

  it("jumps to the ends", () => {
    assert.equal(listScrollTarget("Home", 1234, list), 0);
    assert.equal(listScrollTarget("End", 1234, list), 4200);
  });

  it("clamps to the scrollable range", () => {
    assert.equal(listScrollTarget("ArrowUp", 10, list), 0);
    assert.equal(listScrollTarget("PageUp", 0, list), 0);
    assert.equal(listScrollTarget("PageDown", 4000, list), 4200);
    assert.equal(listScrollTarget("ArrowDown", 4200, list), 4200);
  });

  it("stays at 0 when the content fits", () => {
    const short = { clientHeight: 800, scrollHeight: 300 };
    for (const key of ["PageDown", "End", "ArrowDown", "PageUp", "Home"]) {
      assert.equal(listScrollTarget(key, 0, short), 0, key);
    }
  });

  it("stacks presses from the pending target, not the mid-glide position", () => {
    // A smooth PageDown from 0 is heading for one page down and has covered a
    // third of it when the second press lands. Starting from the target lands
    // two full pages down, which is what two presses mean.
    const page = 800 * PAGE_FRACTION;
    const first = listScrollTarget("PageDown", 0, list)!;
    assert.equal(listScrollTarget("PageDown", first, list), 2 * page);
  });

  it("returns null for keys that don't scroll", () => {
    assert.equal(listScrollTarget("ArrowLeft", 100, list), null);
    assert.equal(listScrollTarget("x", 100, list), null);
  });
});
