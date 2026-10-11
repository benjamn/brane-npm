import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TAP_FOCUS_GRACE_MS, dragAllowed, isTextEntry, layoutHeight, mustBlur, scrollBoxOf, type ScrollBox } from "../shared/no-pan.js";

const box = (scrollTop: number, clientHeight = 100, scrollHeight = 300, overflowY = "auto", reversed = false): ScrollBox =>
  scrollBoxOf({ overflowY, reversed, scrollTop, clientHeight, scrollHeight });
const plain: ScrollBox = { scrolls: false, roomAbove: 0, roomBelow: 0 };

describe("no-pan", () => {
  it("takes over taps on text fields only", () => {
    assert.equal(isTextEntry({ tagName: "INPUT", type: "search" }), true);
    assert.equal(isTextEntry({ tagName: "input" }), true, "no type is text");
    assert.equal(isTextEntry({ tagName: "TEXTAREA" }), true);
    assert.equal(isTextEntry({ tagName: "DIV", isContentEditable: true }), true);
    assert.equal(isTextEntry({ tagName: "INPUT", type: "checkbox" }), false);
    assert.equal(isTextEntry({ tagName: "INPUT", type: "submit" }), false);
    assert.equal(isTextEntry({ tagName: "INPUT", type: "text", disabled: true }), false);
    assert.equal(isTextEntry({ tagName: "TEXTAREA", readOnly: true }), false);
    assert.equal(isTextEntry({ tagName: "BUTTON" }), false);
  });

  it("refuses a vertical drag nothing under the finger can scroll — the header, a bar", () => {
    assert.equal(dragAllowed(0, 30, [plain, plain]), false);
    assert.equal(dragAllowed(0, -30, [plain]), false);
  });

  it("lets a scroller take the drag while it can move that way", () => {
    assert.equal(dragAllowed(0, 30, [plain, box(50)]), true, "finger down, content can go toward its top");
    assert.equal(dragAllowed(0, -30, [plain, box(50)]), true);
  });

  it("refuses the drag a scroller at its end would hand on to the page", () => {
    assert.equal(dragAllowed(0, 30, [box(0)]), false, "at the top, pulling down");
    assert.equal(dragAllowed(0, -30, [box(200)]), false, "at the bottom, pushing up");
    assert.equal(dragAllowed(0, -30, [box(200), box(10)]), true, "an outer scroller can still take it");
  });

  it("ignores boxes that are not scrollers, or have nothing to scroll", () => {
    assert.equal(dragAllowed(0, -30, [box(0, 100, 300, "hidden")]), false);
    assert.equal(dragAllowed(0, -30, [box(0, 100, 100)]), false);
  });

  it("reads a column-reverse scroller (the chat) the right way round", () => {
    // At its bottom a reversed scroller's scrollTop is 0 and history is above.
    assert.equal(dragAllowed(0, 30, [box(0, 100, 300, "auto", true)]), true, "at the bottom, pulling down into history");
    assert.equal(dragAllowed(0, -30, [box(0, 100, 300, "auto", true)]), false, "nothing below the bottom");
    assert.equal(dragAllowed(0, 30, [box(-200, 100, 300, "auto", true)]), false, "at the top of history");
    assert.equal(dragAllowed(0, -30, [box(-200, 100, 300, "auto", true)]), true);
  });

  it("never guards a horizontal drag", () => {
    assert.equal(dragAllowed(40, 10, [plain]), true);
  });

  it("sizes the layout to the visible area, and freezes it while zoomed", () => {
    assert.equal(layoutHeight(412.6, 1, null), 413);
    assert.equal(layoutHeight(200, 2, 766), 766);
    assert.equal(layoutHeight(200, 2, null), null);
  });

  it("never leaves a text field focused with the keyboard down on a touch screen", () => {
    const base = { touch: true, textEntryFocused: true, keyboardUp: false, msSinceTapFocus: 60_000 };
    assert.equal(mustBlur(base), true, "swiped away, autofocused, or focused from code");
    assert.equal(mustBlur({ ...base, keyboardUp: true }), false, "typing");
    assert.equal(mustBlur({ ...base, msSinceTapFocus: 200 }), false, "our tap, keyboard still rising");
    assert.equal(mustBlur({ ...base, msSinceTapFocus: TAP_FOCUS_GRACE_MS + 1 }), true, "our tap, but the keyboard never came");
    assert.equal(mustBlur({ ...base, textEntryFocused: false }), false, "nothing to blur");
    assert.equal(mustBlur({ ...base, touch: false }), false, "a desktop has no soft keyboard to wait for");
  });
});
