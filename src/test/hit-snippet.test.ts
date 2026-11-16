import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildHitSnippet, type MatchRange } from "../shared/hit-snippet.js";

/** Ranges for every occurrence of each word, as the daemon would send them. */
function rangesOf(text: string, ...words: string[]): MatchRange[] {
  const out: Array<[number, number]> = [];
  for (const w of words) {
    for (let i = text.indexOf(w); i >= 0; i = text.indexOf(w, i + 1)) out.push([i, i + w.length]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

const render = (segs: ReturnType<typeof buildHitSnippet>) =>
  segs.map((s) => (s.match ? `[${s.text}]` : s.text)).join("");

describe("buildHitSnippet", () => {
  it("shows the opening, unmarked, when nothing matched literally", () => {
    const segs = buildHitSnippet("A semantic hit\n\nwith two paragraphs.", undefined);
    assert.equal(render(segs), "A semantic hit with two paragraphs.");
  });

  it("marks matches in a short hit without windowing", () => {
    const text = "Restart the daemon after the build.";
    assert.equal(
      render(buildHitSnippet(text, rangesOf(text, "Restart", "daemon"))),
      "[Restart] the [daemon] after the build.",
    );
  });

  it("windows a long hit onto its match, with … at each cut", () => {
    const filler = "lorem ipsum dolor sit amet ".repeat(20);
    const text = `${filler}the tailscale cert renewal failed here ${filler}`;
    const out = render(buildHitSnippet(text, rangesOf(text, "tailscale"), { window: 120, lead: 30 }));
    assert.ok(out.startsWith("…"), out);
    assert.ok(out.endsWith("…"), out);
    assert.ok(out.includes("[tailscale] cert renewal"), out);
    // The match sits near the front, after a little context, not at the far end.
    assert.ok(out.indexOf("[tailscale]") < 40, out);
  });

  it("prefers the run holding the most distinct terms over the first match", () => {
    const filler = "nothing to see in this stretch of text ".repeat(12);
    const text = `daemon once. ${filler}Here the daemon restart and the cert renewal. ${filler}`;
    const out = render(
      buildHitSnippet(text, rangesOf(text, "daemon", "restart", "cert"), { window: 100, lead: 20 }),
    );
    assert.ok(out.includes("[daemon] [restart] and the [cert]"), out);
    assert.ok(!out.includes("once"), out);
  });

  it("fills the window from before when the match is near the end", () => {
    const text = `${"word ".repeat(80)}final match`;
    const out = render(buildHitSnippet(text, rangesOf(text, "match"), { window: 60, lead: 10 }));
    assert.ok(out.startsWith("…"));
    assert.ok(out.endsWith("[match]"), out);
    assert.ok(out.length > 55, out);
  });

  it("keeps marks aligned after whitespace is collapsed", () => {
    const text = "first\n\n\n   second    daemon\tthird";
    assert.equal(render(buildHitSnippet(text, rangesOf(text, "daemon"))), "first second [daemon] third");
  });

  it("marks a phrase spanning a line break as one run", () => {
    const text = "run tailscale\ncert now";
    assert.equal(
      render(buildHitSnippet(text, [[4, 18]])),
      "run [tailscale cert] now",
    );
  });

  it("drops the leading heading for wiki hits, and matches inside it", () => {
    const text = "## Daemon restarts\n\nThe daemon restarts on upgrade.";
    assert.equal(
      render(buildHitSnippet(text, rangesOf(text, "Daemon", "daemon"), { stripHeading: true })),
      "The [daemon] restarts on upgrade.",
    );
  });

  it("ignores ranges that no longer fit the text", () => {
    const text = "short text";
    assert.equal(render(buildHitSnippet(text, [[6, 10], [8, 40], [3, 3]])), "short [text]");
  });

  it("never splits a surrogate pair at a cut", () => {
    const text = `${"🔬".repeat(100)} daemon ${"🔬".repeat(100)}`;
    for (const seg of buildHitSnippet(text, rangesOf(text, "daemon"), { window: 41, lead: 7 })) {
      assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(seg.text), JSON.stringify(seg.text));
    }
  });
});
