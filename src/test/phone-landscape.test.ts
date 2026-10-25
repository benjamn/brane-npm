import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPhoneLandscape, type PhoneLandscapeInput } from "../shared/phone-landscape.js";

// The header hides for a phone held sideways and nothing else. What these pin
// is the "nothing else": desktop layout is the operator's, at every window
// shape, so no single signal — a short window, a wide one, a touch screen —
// may qualify on its own.

const phone = (w: number, h: number, win: [number, number]): PhoneLandscapeInput => ({
  screenWidth: w, screenHeight: h, coarsePointer: true, windowWidth: win[0], windowHeight: win[1],
});

describe("isPhoneLandscape", () => {
  it("is a phone in landscape", () => {
    // iPhone 16 Pro Max, iOS Safari: screen stays in portrait terms.
    assert.equal(isPhoneLandscape(phone(440, 956, [956, 380])), true);
    // Android Chrome swaps screen dimensions on rotation.
    assert.equal(isPhoneLandscape(phone(915, 412, [915, 360])), true);
    // iPhone SE.
    assert.equal(isPhoneLandscape(phone(375, 667, [667, 320])), true);
  });

  it("is not a phone in portrait", () => {
    assert.equal(isPhoneLandscape(phone(440, 956, [440, 830])), false);
    assert.equal(isPhoneLandscape(phone(375, 667, [375, 548])), false);
  });

  it("is never desktop, whatever the window's shape", () => {
    const desktop = (win: [number, number], coarsePointer = false): PhoneLandscapeInput => ({
      screenWidth: 1728, screenHeight: 1117, coarsePointer, windowWidth: win[0], windowHeight: win[1],
    });
    for (const win of [[1728, 1000], [900, 300], [1400, 420], [400, 380], [300, 900]] as [number, number][]) {
      assert.equal(isPhoneLandscape(desktop(win)), false, `window ${win}`);
      // A touchscreen laptop is still a large screen.
      assert.equal(isPhoneLandscape(desktop(win, true)), false, `touch window ${win}`);
    }
  });

  it("is not a tablet in landscape", () => {
    // iPad mini, the smallest iPad.
    assert.equal(isPhoneLandscape(phone(744, 1133, [1133, 700])), false);
  });

  it("needs touch as the primary pointer", () => {
    assert.equal(isPhoneLandscape({ ...phone(440, 956, [956, 380]), coarsePointer: false }), false);
  });

  it("reads an unknown screen as not landscape", () => {
    assert.equal(isPhoneLandscape(phone(0, 0, [956, 380])), false);
  });
});
