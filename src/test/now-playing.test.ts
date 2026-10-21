import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Jukebox, sameTrack, trackFolder, trackTitle } from "../shared/now-playing.js";

const a1 = { nid: "claude-aaaaaaaa", path: "music/one.mp3", url: "https://d/one?token=t1" };
const a2 = { nid: "claude-aaaaaaaa", path: "music/two.mp3", url: "https://d/two?token=t1" };
const b1 = { nid: "codex-bbbbbbbb", path: "set.mp3", url: "https://d/set?token=t1" };

/** Counts wakes per narrative, so a test can assert what a change *didn't*
 *  touch: a timeupdate on one card must not repaint the others. */
function watch(box: Jukebox, nids: string[]) {
  const wakes: Record<string, number> = {};
  const unsubs = nids.map((nid) => {
    wakes[nid] = 0;
    return box.subscribe(nid, () => { wakes[nid] += 1; });
  });
  return { wakes, unsubscribe: () => unsubs.forEach((u) => u()) };
}

describe("Jukebox", () => {
  it("starts empty", () => {
    const box = new Jukebox();
    assert.equal(box.get(a1.nid), null);
    assert.equal(box.playing, null);
    assert.deepEqual(box.nids(), []);
  });

  it("loads a track from the start, and a second in the same narrative replaces it", () => {
    const box = new Jukebox();
    box.load(a1);
    box.setTime(a1.nid, 40, 200);
    box.setStatus(a1.nid, "playing");
    box.load(a2);
    const e = box.get(a1.nid);
    assert.deepEqual(e, { track: a2, status: "loading", position: 0, duration: 0 });
    assert.deepEqual(box.nids(), [a1.nid]);
  });

  it("holds one track per narrative, and only one of them plays", () => {
    const box = new Jukebox();
    box.load(a1);
    box.setStatus(a1.nid, "playing");
    box.setTime(a1.nid, 90, 300);
    box.load(b1);
    // Loading b pauses a, which keeps its place.
    assert.equal(box.get(a1.nid)?.status, "paused");
    assert.equal(box.get(a1.nid)?.position, 90);
    assert.equal(box.playing, b1.nid);
    box.setStatus(b1.nid, "playing");
    // Playing a again pauses b.
    box.setStatus(a1.nid, "playing");
    assert.equal(box.get(b1.nid)?.status, "paused");
    assert.equal(box.playing, a1.nid);
    assert.deepEqual(box.nids(), [a1.nid, b1.nid]);
  });

  it("ejects a track, and ignores the engine's trailing events for it", () => {
    const box = new Jukebox();
    box.load(a1);
    box.eject(a1.nid);
    box.setStatus(a1.nid, "paused");
    box.setTime(a1.nid, 3, 100);
    assert.equal(box.get(a1.nid), null);
    assert.deepEqual(box.nids(), []);
  });

  it("wakes only the narrative that changed, once per change, never for a no-op", () => {
    const box = new Jukebox();
    const w = watch(box, [a1.nid, b1.nid]);
    box.load(a1);
    assert.deepEqual(w.wakes, { [a1.nid]: 1, [b1.nid]: 0 });
    box.setTime(a1.nid, 10, 100);
    box.setTime(a1.nid, 10, 100);
    assert.deepEqual(w.wakes, { [a1.nid]: 2, [b1.nid]: 0 });
    box.setStatus(a1.nid, "playing");
    box.setStatus(a1.nid, "playing");
    assert.deepEqual(w.wakes, { [a1.nid]: 3, [b1.nid]: 0 });
    // b starting is the one change that touches a: it pauses it.
    box.load(b1);
    assert.deepEqual(w.wakes, { [a1.nid]: 4, [b1.nid]: 1 });
    box.setTime(b1.nid, 1, 50);
    assert.deepEqual(w.wakes, { [a1.nid]: 4, [b1.nid]: 2 });
    box.eject(b1.nid);
    box.eject(b1.nid);
    assert.deepEqual(w.wakes, { [a1.nid]: 4, [b1.nid]: 3 });
    w.unsubscribe();
    box.setTime(a1.nid, 11, 100);
    assert.deepEqual(w.wakes, { [a1.nid]: 4, [b1.nid]: 3 });
  });

  it("wakes a whole-rack subscriber on any change", () => {
    const box = new Jukebox();
    let n = 0;
    const off = box.subscribeAll(() => { n += 1; });
    box.load(a1);
    box.load(b1); // loads b and pauses a: two wakes
    assert.equal(n, 3);
    off();
    box.eject(a1.nid);
    assert.equal(n, 3);
  });

  it("hands out a new entry object per change and keeps the old one intact", () => {
    const box = new Jukebox();
    box.load(a1);
    const before = box.get(a1.nid)!;
    box.setTime(a1.nid, 5, 50);
    assert.notEqual(box.get(a1.nid), before);
    assert.equal(before.position, 0);
  });

  it("treats a non-finite or negative time as unknown", () => {
    const box = new Jukebox();
    box.load(a1);
    box.setTime(a1.nid, NaN, Infinity);
    assert.deepEqual([box.get(a1.nid)?.position, box.get(a1.nid)?.duration], [0, 0]);
    box.setTime(a1.nid, -2, -1);
    assert.deepEqual([box.get(a1.nid)?.position, box.get(a1.nid)?.duration], [0, 0]);
  });
});

describe("track helpers", () => {
  it("identifies a track by narrative and path, not by URL", () => {
    assert.equal(sameTrack(a1, { ...a1, url: "https://d/one?token=t2" }), true);
    assert.equal(sameTrack(a1, a2), false);
    assert.equal(sameTrack(a1, null), false);
    assert.equal(sameTrack(undefined, a1), false);
  });
  it("splits a path into title and folder", () => {
    assert.equal(trackTitle("music/one.mp3"), "one.mp3");
    assert.equal(trackFolder("music/one.mp3"), "music");
    assert.equal(trackTitle("one.mp3"), "one.mp3");
    assert.equal(trackFolder("one.mp3"), "");
  });
});
