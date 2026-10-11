import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GlowHues,
  GLOW_HUES_STORAGE_KEY,
  RECENT_LIMIT,
  RECENT_MS,
  gapMidpoints,
  hueDistance,
  parseGlowAssignments,
  MIN_RECOLOR_STEP,
  RECOLOR_CLEARANCE_MIN,
  REJECTED_CLEARANCE,
  REJECTED_LIMIT,
  REJECTED_MS,
  recolorHue,
  takenHues,
  type KeyValueStore,
} from "../shared/glow-hues.js";
import { speakerHue } from "../shared/speaker-color.js";

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

function clock(start = 1_800_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const minGap = (hues: number[]) => {
  let m = 360;
  for (let i = 0; i < hues.length; i++) {
    for (let j = i + 1; j < hues.length; j++) m = Math.min(m, hueDistance(hues[i], hues[j]));
  }
  return m;
};

describe("gapMidpoints", () => {
  it("puts the widest arc first, and its middle is the answer", () => {
    assert.deepEqual(gapMidpoints([0, 90]), [225, 45]);
    assert.deepEqual(gapMidpoints([350, 10]), [180, 0]);
  });

  it("is empty for a free wheel, and opposite a single hue", () => {
    assert.deepEqual(gapMidpoints([]), []);
    assert.deepEqual(gapMidpoints([30]), [210]);
  });
});

describe("GlowHues", () => {
  it("spreads narratives that start glowing one after another", () => {
    const c = clock();
    const g = new GlowHues(memoryStore(), c.now);
    const hues = ["claude-a", "claude-b", "claude-c", "claude-d"].map((nid) => {
      c.advance(1000);
      return g.hueFor(nid);
    });
    // Greedy largest-gap: four hues never closer than a quarter turn.
    assert.ok(minGap(hues) >= 90, `min gap ${minGap(hues)} for ${hues}`);
  });

  it("gives the first narrative on a free wheel its speaker hue", () => {
    const g = new GlowHues(memoryStore());
    assert.equal(g.hueFor("claude-4c7289d1"), speakerHue("claude-4c7289d1"));
  });

  it("keeps a hue once chosen, whatever lights up later", () => {
    const c = clock();
    const g = new GlowHues(memoryStore(), c.now);
    const first = g.hueFor("claude-a");
    for (let i = 0; i < 20; i++) {
      c.advance(60_000);
      g.hueFor(`claude-other${i}`);
      assert.equal(g.hueFor("claude-a"), first);
    }
  });

  it("survives a reload through the store", () => {
    const store = memoryStore();
    const hue = new GlowHues(store).hueFor("claude-a");
    assert.equal(new GlowHues(store).hueFor("claude-a"), hue);
    assert.ok(store.data.has(GLOW_HUES_STORAGE_KEY));
  });

  it("Recolor lands clear of the others, and the new hue sticks", () => {
    const store = memoryStore();
    const c = clock();
    const assignments = { "claude-x": { hue: 0, seen: c.now() }, "claude-y": { hue: 100, seen: c.now() }, "claude-me": { hue: 5, seen: c.now() } };
    store.setItem(GLOW_HUES_STORAGE_KEY, JSON.stringify(assignments));
    const g = new GlowHues(store, c.now);
    const hue = g.recolor("claude-me");
    // Widest gap is 100..360, middle 230, clearance 130: at least 65 from both.
    assert.ok(hueDistance(hue, 0) >= 65 && hueDistance(hue, 100) >= 65, `landed on ${hue}`);
    assert.equal(g.hueFor("claude-me"), hue);
  });

  it("Recolor with one other session is not a toggle", () => {
    // The complaint: 180 -> 0-ish -> 180 -> ... Seeded draws must reach many
    // hues, every one well clear of the other session. Not the far half: from
    // 180 a full step leaves it, so the clearance gives way before the step.
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const c = clock();
    const store = memoryStore();
    store.setItem(GLOW_HUES_STORAGE_KEY, JSON.stringify({ "claude-other": { hue: 0, seen: c.now() }, "claude-me": { hue: 180, seen: c.now() } }));
    const g = new GlowHues(store, c.now, random);
    const seen = new Set<number>();
    let prev = 180;
    for (let i = 0; i < 12; i++) {
      c.advance(1000);
      const next = g.recolor("claude-me");
      assert.ok(hueDistance(next, 0) >= 45, `press ${i}: ${next} too near the other`);
      assert.ok(hueDistance(next, prev) >= MIN_RECOLOR_STEP, `press ${i}: ${prev} -> ${next}`);
      seen.add(next);
      prev = next;
    }
    assert.ok(seen.size >= 8, `only ${[...seen]}`);
  });

  it("Recolor stays clear of the hues it just left, until they expire", () => {
    const c = clock();
    const store = memoryStore();
    const g = new GlowHues(store, c.now, Math.random);
    const left: number[] = [g.hueFor("claude-me")];
    for (let i = 0; i < REJECTED_LIMIT - 1; i++) {
      const next = g.recolor("claude-me");
      // Alone on the wheel, three hues 100° apart can leave nowhere 60° from
      // all of them; the oldest gives way, never the last two.
      for (const h of left.slice(-2)) assert.ok(hueDistance(next, h) >= REJECTED_CLEARANCE, `press ${i}: ${next} near rejected ${h}`);
      left.push(next);
    }
    const stored = JSON.parse(store.data.get(GLOW_HUES_STORAGE_KEY)!)["claude-me"];
    assert.equal(stored.rejected.length, REJECTED_LIMIT - 1);
    c.advance(REJECTED_MS + 1);
    g.recolor("claude-me");
    const after = JSON.parse(store.data.get(GLOW_HUES_STORAGE_KEY)!)["claude-me"];
    assert.equal(after.rejected.length, 1, "expired rejections kept");
  });

  it("a crowded wheel relaxes the rejections before failing to move", () => {
    const taken = Array.from({ length: 12 }, (_, i) => i * 30);
    // Every clear spot is a gap middle (15, 45, ...); reject them all.
    const rejected = taken.map((h) => h + 15);
    const moved = recolorHue(15, taken, { rejected, random: () => 0.5 });
    assert.ok(hueDistance(moved, 15) >= MIN_RECOLOR_STEP, `moved to ${moved}`);
    assert.ok(Math.min(...taken.map((h) => hueDistance(h, moved))) >= 7, `moved to ${moved}`);
  });

  it("Recolor always visibly moves, even when already in the widest gap", () => {
    // One other hue at 0 and this one opposite it: the widest gap *is* here.
    const moved = recolorHue(180, [0]);
    assert.ok(hueDistance(moved, 180) >= 20, `moved to ${moved}`);
    assert.ok(hueDistance(moved, 0) >= 45, `moved to ${moved}`);
    // Alone on the wheel: still a change.
    assert.ok(hueDistance(recolorHue(40, []), 40) >= 20);
  });

  it("repeated Recolors keep landing somewhere distinct", () => {
    const c = clock();
    const g = new GlowHues(memoryStore(), c.now);
    const others = ["claude-a", "claude-b", "claude-c"].map((nid) => g.hueFor(nid));
    let prev = g.hueFor("claude-me");
    for (let i = 0; i < 6; i++) {
      const next = g.recolor("claude-me");
      assert.ok(hueDistance(next, prev) >= MIN_RECOLOR_STEP, `press ${i}: ${prev} -> ${next}`);
      // Four sessions leave 45° of best clearance. The step and the hues just
      // left outrank half of it, never the quarter.
      assert.ok(Math.min(...others.map((h) => hueDistance(h, next))) >= 45 * RECOLOR_CLEARANCE_MIN, `press ${i}: ${next} vs ${others}`);
      prev = next;
    }
  });

  it("every press changes the color, and two presses never come back", () => {
    // The complaint after #536: a 45° minimum let a fifth of presses shade the
    // hue (pink to rose) rather than change it. Over many seeded runs, with
    // zero to three other sessions glowing, each press takes a full step and
    // the second lands clear of where the first started.
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let run = 0; run < 400; run++) {
      const c = clock();
      const g = new GlowHues(memoryStore(), c.now, random);
      const others = Array.from({ length: run % 4 }, (_, i) => g.hueFor(`claude-o${i}`));
      const start = g.hueFor("claude-me");
      c.advance(1000);
      const first = g.recolor("claude-me");
      c.advance(1000);
      const second = g.recolor("claude-me");
      const where = `run ${run}, others ${others}: ${start} -> ${first} -> ${second}`;
      assert.ok(hueDistance(first, start) >= MIN_RECOLOR_STEP, where);
      assert.ok(hueDistance(second, first) >= MIN_RECOLOR_STEP, where);
      assert.ok(hueDistance(second, start) >= REJECTED_CLEARANCE, where);
    }
  });

  it("an unreadable store is an empty one, and a failed write still answers", () => {
    const broken: KeyValueStore = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    const g = new GlowHues(broken);
    assert.equal(g.hueFor("claude-a"), speakerHue("claude-a"));
    assert.equal(typeof g.recolor("claude-a"), "number");
  });
});

describe("takenHues", () => {
  it("counts only recent glows, most recent first, capped", () => {
    const now = 10 * RECENT_MS;
    const assignments: Record<string, { hue: number; seen: number }> = {
      stale: { hue: 1, seen: now - RECENT_MS - 1 },
      me: { hue: 2, seen: now },
    };
    for (let i = 0; i < RECENT_LIMIT + 5; i++) assignments[`n${i}`] = { hue: 10 + i, seen: now - i };
    const taken = takenHues(assignments, "me", now);
    assert.equal(taken.length, RECENT_LIMIT);
    assert.ok(!taken.includes(1), "stale hue counted");
    assert.ok(!taken.includes(2), "own hue counted");
    assert.equal(taken[0], 10);
  });
});

describe("parseGlowAssignments", () => {
  it("drops anything malformed", () => {
    assert.deepEqual(parseGlowAssignments(null), {});
    assert.deepEqual(parseGlowAssignments("not json"), {});
    assert.deepEqual(parseGlowAssignments("[1,2]"), {});
    assert.deepEqual(
      parseGlowAssignments(JSON.stringify({ a: { hue: 400, seen: 5 }, b: { hue: "x", seen: 1 }, c: null })),
      { a: { hue: 40, seen: 5 } },
    );
    assert.deepEqual(
      parseGlowAssignments(JSON.stringify({ a: { hue: 1, seen: 5, rejected: [{ hue: 370, at: 2 }, { hue: "x" }, null] } })),
      { a: { hue: 1, seen: 5, rejected: [{ hue: 10, at: 2 }] } },
    );
  });
});
