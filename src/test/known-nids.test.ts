import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";
import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import { narrativeIdLinks } from "../shared/markdown-nids.js";
import { collectKnownNids } from "../shared/known-nids.js";

// The bug these are written against, reproduced from a real report:
//
//   A twin's first message read "/twin from claude-l4qmxmpb:40" and did not
//   linkify. Neither did the `crush-ci2eu0eb:N` references in its own bubble
//   headers. `/review` in the very next message linkified fine.
//
// Nothing was wrong with the parser. The operator was on a slow network, the
// one fetch that filled `knownNarrativeIds` failed, its rejection was
// swallowed, the effect could not re-fire, and an empty set makes every
// reference on the screen silently stop being a link.
//
// A parser test could never have caught that — the parser was right. What was
// needed is a test of *where the ids come from*, which is why that decision now
// lives in a module of its own.

const VIEWING = "crush-ci2eu0eb";
const PREDECESSOR = "claude-l4qmxmpb";
const ALL = [{ id: VIEWING }, { id: PREDECESSOR }, { id: "goose-aa11bb22" }];

/** The screen's markdown pipeline, over whatever ids it managed to collect. */
function linksFor(md: string, known: Set<string>): string[] {
  const tree = fromMarkdown(md, {
    extensions: [gfmAutolinkLiteral()],
    mdastExtensions: [gfmAutolinkLiteralFromMarkdown(), narrativeIdLinks(known)],
  });
  const out: string[] = [];
  const walk = (n: any) => {
    if (n.type === "link") {
      out.push(n.url);
      return;
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return out;
}

describe("linkification survives the fetch that feeds it", () => {
  it("still links when the list sweep never arrives — the reported bug", () => {
    // Exactly the failure: `listed` is the request that died on a slow link.
    const known = collectKnownNids({ viewing: VIEWING, pushed: ALL, listed: null });

    assert.deepEqual(linksFor("/twin from claude-l4qmxmpb:40", known), [
      "brane://nid/claude-l4qmxmpb/40",
    ]);
    assert.deepEqual(linksFor("see crush-ci2eu0eb:2", known), ["brane://nid/crush-ci2eu0eb/2"]);
  });

  it("links the narrative you are looking at even with no network at all", () => {
    // The floor. The route param needs no request, so a reference to the
    // narrative on screen can never be a dead link.
    const known = collectKnownNids({ viewing: VIEWING, pushed: null, listed: null });
    assert.deepEqual(linksFor("see crush-ci2eu0eb:2", known), ["brane://nid/crush-ci2eu0eb/2"]);
  });

  it("degrades rather than switching off", () => {
    // The property the whole module exists for: losing a source costs you the
    // ids only that source had, never the ones you already held.
    const full = collectKnownNids({ viewing: VIEWING, pushed: ALL, listed: ALL });
    const degraded = collectKnownNids({ viewing: VIEWING, pushed: null, listed: null });
    assert.ok(degraded.size > 0, "a screen with no completed fetch must still link something");
    for (const id of degraded) {
      assert.ok(full.has(id), `${id} appeared only when sources were missing`);
    }
  });

  it("does not link a well-shaped id nobody has heard of", () => {
    // The degradation must not become permissiveness: the existence check is
    // what stops arbitrary strings of that shape becoming dead links.
    const known = collectKnownNids({ viewing: VIEWING, pushed: ALL, listed: ALL });
    assert.deepEqual(linksFor("claude-deadbeef never existed", known), []);
  });
});

describe("collectKnownNids", () => {
  it("unions its sources rather than preferring one", () => {
    // Each covers the other's gap: the `state` frame is a snapshot from connect
    // and misses later spawns; the list sweep is a moment behind.
    const known = collectKnownNids({
      pushed: [{ id: "claude-11111111" }],
      listed: [{ id: "claude-22222222" }],
      viewing: "claude-33333333",
    });
    assert.deepEqual(
      [...known].sort(),
      ["claude-11111111", "claude-22222222", "claude-33333333"],
    );
  });

  it("survives every source being absent, null, or empty", () => {
    assert.equal(collectKnownNids({}).size, 0);
    assert.equal(collectKnownNids({ viewing: null, pushed: null, listed: null }).size, 0);
    assert.equal(collectKnownNids({ viewing: "", pushed: [], listed: [] }).size, 0);
  });

  it("ignores entries without a usable id", () => {
    const known = collectKnownNids({
      listed: [{ id: "" }, { id: undefined as any }, null as any, { id: "claude-44444444" }],
    });
    assert.deepEqual([...known], ["claude-44444444"]);
  });

  it("dedups across sources", () => {
    const known = collectKnownNids({
      viewing: VIEWING,
      pushed: [{ id: VIEWING }],
      listed: [{ id: VIEWING }],
    });
    assert.equal(known.size, 1);
  });
});
