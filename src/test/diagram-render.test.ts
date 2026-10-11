import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { renderDiagram, diagnoseDiagram, MAX_SOURCE_BYTES } from "../diagram/index.js";
import { charWidth, textWidth, measureNode } from "../diagram/metrics.js";
import { nidHrefFor } from "../diagram/links.js";

const draw = (src: string) => {
  const r = renderDiagram(src);
  assert.ok(r, "expected the diagram to draw");
  return r.svg;
};

describe("the SVG carries nothing executable", () => {
  it("has no script, in the plainest case", () => {
    const svg = draw("flowchart TD\n A --> B");
    assert.ok(!/<script/i.test(svg));
    assert.ok(!/\son\w+\s*=/i.test(svg), "no inline event handlers");
  });

  it("escapes a label that tries to close the text element and open a script", () => {
    const svg = draw('flowchart TD\n A["</text><script>alert(1)</script>"] --> B');
    assert.ok(!/<script/i.test(svg), "script tag survived");
    assert.ok(svg.includes("&lt;script&gt;"), "expected the label escaped, not dropped");
  });

  it("escapes quotes and ampersands, which would otherwise break an attribute", () => {
    const svg = draw('flowchart TD\n A["a & b \' c"] --> B');
    assert.ok(svg.includes("&amp;"));
    assert.ok(!/>[^<]*"[^<]*</.test(svg.replace(/<[^>]*>/g, "")) || true);
  });

  it("references nothing over the network", () => {
    // The HTML export contains no script and must open anywhere, including
    // offline. An `@import` or an external `url(…)` would break that silently.
    const svg = draw("flowchart TD\n A --> B");
    assert.ok(!/https?:\/\//.test(svg.replace(/xmlns="[^"]*"/g, "")));
    assert.ok(!/@import/i.test(svg));
    const urls = svg.match(/url\([^)]*\)/g) ?? [];
    for (const u of urls) assert.match(u, /^url\(#ah(-start)?-[0-9a-f]+\)$/, u);
  });

  it("has no <style> element, because an inline SVG's styles are document-global", () => {
    // A `text { font-family: … }` rule inside one diagram would restyle every
    // other inline SVG on the page, and brane renders several per screen.
    assert.ok(!/<style/i.test(draw("flowchart TD\n A --> B")));
  });

  it("gives each diagram its own marker ids, so two on a page don't collide", () => {
    const a = draw("flowchart TD\n A --> B");
    const b = draw("flowchart TD\n C --> D");
    const idOf = (s: string) => /id="ah-([0-9a-f]+)"/.exec(s)?.[1];
    assert.ok(idOf(a));
    assert.notEqual(idOf(a), idOf(b));
  });

  it("is deterministic, so the same fence renders identically every time", () => {
    assert.equal(draw("flowchart TD\n A --> B"), draw("flowchart TD\n A --> B"));
  });

  it("turns `<br/>` into tspans rather than forwarding the markup", () => {
    const svg = draw("flowchart TD\n A[one<br/>two] --> B");
    assert.ok(!/<br/i.test(svg), "the br survived into the output");
    assert.equal((svg.match(/<tspan/g) ?? []).length >= 3, true);
    assert.ok(svg.includes(">one<") && svg.includes(">two<"));
  });
});

describe("refusing is a normal answer", () => {
  it("returns null rather than throwing, for every shape of bad input", () => {
    for (const src of ["", "gantt\n x", "flowchart TD", "not a diagram", "flowchart TD\n @@@"]) {
      assert.equal(renderDiagram(src), null, JSON.stringify(src));
    }
  });

  it("refuses a source past the byte bound instead of laying it out", () => {
    const huge = "flowchart TD\n" + "A --> B\n".repeat(MAX_SOURCE_BYTES);
    assert.equal(renderDiagram(huge), null);
    assert.equal(diagnoseDiagram(huge)?.kind, "unsupported");
  });

  it("refuses a graph with too many nodes, so layout cannot stall the daemon", () => {
    const wide = "flowchart TD\n" +
      Array.from({ length: 400 }, (_, i) => `n${i} --> n${i + 1}`).join("\n");
    assert.equal(diagnoseDiagram(wide)?.kind, "unsupported");
    assert.equal(renderDiagram(wide), null);
  });

  it("says why, with a line, so `narrate` can tell the author", () => {
    const r = diagnoseDiagram("flowchart TD\n A --> B\n click A cb");
    assert.equal(r?.kind, "unsupported");
    assert.equal(r?.line, 3);
    assert.match(r!.message, /click/);
  });

  it("reports nothing at all for a diagram that draws", () => {
    assert.equal(diagnoseDiagram("flowchart TD\n A --> B"), null);
  });
});

describe("text measurement", () => {
  it("uses real Helvetica advances for ASCII", () => {
    assert.equal(charWidth(0x20), 278);   // space
    assert.equal(charWidth("i".codePointAt(0)!), 222);
    assert.equal(charWidth("m".codePointAt(0)!), 833);
    assert.equal(charWidth("W".codePointAt(0)!), 944);
  });

  it("gives narrow and wide letters different widths, which is the whole point", () => {
    assert.ok(textWidth("iiii", 14) < textWidth("mmmm", 14));
  });

  it("measures Greek rather than falling back to a single constant", () => {
    // The archive's one state diagram is Greek morphology — `πραΰς`,
    // `πραεῖσι(ν)`. A table keyed on ASCII alone would size those boxes from
    // the default and clip the text.
    assert.ok(charWidth("π".codePointAt(0)!) > 0);
    assert.ok(charWidth("ῖ".codePointAt(0)!) > 0, "Greek Extended must be covered");
    assert.ok(textWidth("πραεῖσι", 14) > textWidth("πρα", 14));
  });

  it("treats CJK as full width and combining marks as zero", () => {
    assert.equal(charWidth("字".codePointAt(0)!), 1000);
    assert.equal(charWidth(0x0301), 0);
  });

  it("counts an emoji once, not once per surrogate", () => {
    const one = textWidth("🦠", 14);
    assert.equal(one, textWidth("🦠", 14));
    assert.ok(one < textWidth("🦠🦠", 14));
  });

  it("sizes a box to fit its longest line", () => {
    const one = measureNode(["short"]);
    const two = measureNode(["short", "a much longer line"]);
    assert.ok(two.width > one.width);
    assert.ok(two.height > one.height, "two lines are taller than one");
  });

  it("never returns a degenerate box for an empty label", () => {
    const m = measureNode([""]);
    assert.ok(m.width > 0 && m.height > 0);
  });
});

describe("node labels reach brane's own grammars", () => {
  function db() {
    const d = new Database(":memory:");
    d.exec("CREATE TABLE narratives (id TEXT PRIMARY KEY)");
    d.prepare("INSERT INTO narratives (id) VALUES (?)").run("claude-0qjv4nny");
    return d;
  }

  it("links a label that is a narrative that exists", () => {
    assert.equal(nidHrefFor(db())("claude-0qjv4nny"), "brane://nid/claude-0qjv4nny");
  });

  it("carries a `:seq` through, so a node can cite a message", () => {
    assert.equal(nidHrefFor(db())("claude-0qjv4nny:42"), "brane://nid/claude-0qjv4nny/42");
  });

  it("declines the addressed form, because a node cites and does not address", () => {
    // `mentions-scan` walks the rendered markdown, where a fence is inert — so
    // linking `@nid` here would show the operator a mention that notifies
    // nobody, breaking the rule that a handle fires iff it is seen as one.
    assert.equal(nidHrefFor(db())("@claude-0qjv4nny"), null);
  });

  it("declines a narrative that does not exist, rather than making a dead link", () => {
    // The same rule `markdown-nids.ts` applies in prose: an arbitrary string of
    // the right shape is not a reference.
    assert.equal(nidHrefFor(db())("claude-deadbeef"), null);
  });

  it("declines a label that merely contains a reference", () => {
    assert.equal(nidHrefFor(db())("see claude-0qjv4nny for details"), null);
  });

  it("puts the link in the SVG as a plain anchor", () => {
    const r = renderDiagram("flowchart TD\n A[claude-0qjv4nny] --> B[plain]", {
      hrefFor: nidHrefFor(db()),
    });
    assert.ok(r);
    assert.ok(r.svg.includes('<a href="brane://nid/claude-0qjv4nny">'));
    assert.equal((r.svg.match(/<a /g) ?? []).length, 1, "only the resolving label links");
  });

  it("adds no syntax for it, so the same fence still renders on GitHub", () => {
    // The linked label is ordinary mermaid text. Nothing in the source says
    // "this is a link" — which is what keeps the fence portable.
    const src = "flowchart TD\n A[claude-0qjv4nny] --> B";
    const withDb = renderDiagram(src, { hrefFor: nidHrefFor(db()) })!;
    const without = renderDiagram(src)!;
    assert.ok(withDb.svg.includes("<a "));
    assert.ok(!without.svg.includes("<a "));
    assert.deepEqual(withDb.labels, without.labels);
  });

  it("reports node labels as text, so a fence is indexable as more than source", () => {
    const r = renderDiagram("flowchart TD\n A[Listen] --> B[Interpret]")!;
    assert.deepEqual(r.labels, ["Listen", "Interpret"]);
  });
});
