import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  galleryPaths,
  galleryPosition,
  swipeStep,
  keyStep,
  SWIPE_MIN_DX,
} from "../shared/lightbox-gallery.js";

describe("galleryPaths", () => {
  test("collects image payloads in display order, across messages", () => {
    const events = [
      { payloads: ["a/1.png", "a/2.jpg"] },
      { payloads: null },
      {},
      { payloads: ["b/3.webp"] },
    ];
    assert.deepEqual(galleryPaths(events), ["a/1.png", "a/2.jpg", "b/3.webp"]);
  });

  test("skips payloads that download rather than render inline", () => {
    // The same rule MessageBubble uses for thumbnails: a .pdf is a download
    // chip, not a picture, so it is never a stop in the gallery.
    const events = [{ payloads: ["x/report.pdf", "x/shot.png", "x/notes.txt"] }];
    assert.deepEqual(galleryPaths(events), ["x/shot.png"]);
  });

  test("an empty chat is an empty gallery", () => {
    assert.deepEqual(galleryPaths([]), []);
  });
});

describe("galleryPosition", () => {
  const gallery = ["a", "b", "c"];

  test("the middle has both neighbors", () => {
    assert.deepEqual(galleryPosition(gallery, "b"), { index: 1, count: 3, prev: "a", next: "c" });
  });

  test("no wrap-around at either end", () => {
    assert.deepEqual(galleryPosition(gallery, "a"), { index: 0, count: 3, prev: null, next: "b" });
    assert.deepEqual(galleryPosition(gallery, "c"), { index: 2, count: 3, prev: "b", next: null });
  });

  test("an image outside the gallery has nowhere to step", () => {
    // An image opened from the Files view shares the lightbox but not the
    // chat's gallery.
    assert.deepEqual(galleryPosition(gallery, "z"), { index: -1, count: 3, prev: null, next: null });
  });

  test("a lone image has no neighbors", () => {
    assert.deepEqual(galleryPosition(["a"], "a"), { index: 0, count: 1, prev: null, next: null });
  });
});

describe("swipeStep", () => {
  test("finger moving left goes to the next image, right to the previous", () => {
    assert.equal(swipeStep(-80, 5), 1);
    assert.equal(swipeStep(80, -5), -1);
  });

  test("too short to be a swipe", () => {
    assert.equal(swipeStep(SWIPE_MIN_DX - 1, 0), 0);
    assert.equal(swipeStep(-(SWIPE_MIN_DX - 1), 0), 0);
  });

  test("a mostly vertical drag doesn't turn the page", () => {
    assert.equal(swipeStep(-60, 60), 0);
    assert.equal(swipeStep(90, 70), 0);
  });
});

describe("keyStep", () => {
  test("arrows step; everything else is left alone", () => {
    assert.equal(keyStep("ArrowLeft"), -1);
    assert.equal(keyStep("ArrowRight"), 1);
    for (const key of ["Escape", "ArrowUp", "ArrowDown", "Enter", " ", "a"]) {
      assert.equal(keyStep(key), 0, key);
    }
  });
});
