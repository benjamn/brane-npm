import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.js";
import { appendEvent } from "../db/events.js";
import { exportNarrativeHtml } from "../export.js";
import { diagnoseMarkdown } from "../markdown-diagnostics.js";
import { renderDiagram } from "../diagram/index.js";
import { DIAGRAM_EDGE_HIGHLIGHT_CSS } from "../shared/diagram-css.js";

const HOST = "claude-aaaaaaaa";
const PEER = "goose-bbbbbbbb";

function insertNarrative(db: ReturnType<typeof createTestDb>, id: string): void {
  db.prepare(
    `INSERT INTO narratives (id, brane_id, agent_type, role, created_at, status)
     VALUES (?, 'brane-test', ?, 'worker', 0, 'active')`,
  ).run(id, id.split("-")[0]);
}

const fence = (body: string) => "```mermaid\n" + body + "\n```";

// One renderer, two targets. The export calls the same `renderDiagram` the app
// reaches through POST /api/diagram, so a downloaded conversation is a snapshot
// of what the operator saw rather than a lookalike of it. What makes that
// possible here is that the SVG is static — the export carries no script, and
// never can.

describe("the HTML export draws mermaid fences", () => {
  it("emits an inline SVG where the fence was", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "narration", {
      content: "Here is the loop:\n\n" + fence("flowchart TD\n  A[Listen] --> B[Interpret]"),
    });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.match(html, /<div class="diagram"><svg/);
    assert.ok(html.includes(">Listen<"), "the label is in the document as text");
    assert.ok(!/language-mermaid/.test(html), "it should no longer be a code block");
  });

  it("scrolls a wide diagram inside its bubble instead of spilling out", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "narration", {
      content: fence("flowchart LR\n  A --> B --> C --> D --> E --> F --> G --> H"),
    });

    const html = (await exportNarrativeHtml(db, HOST))!;
    // The SVG carries a fixed width, so without a scroller around it a wide
    // diagram draws past the bubble's edge — the export shows all of it at
    // once, where the app clips and scrolls.
    const rule = /\.content \.diagram\s*\{([^}]*)\}/.exec(html);
    assert.ok(rule, "the stylesheet has a rule for the diagram wrapper");
    assert.match(rule[1], /overflow-x:\s*auto/);
  });

  it("keeps the export scriptless, which is its whole constraint", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "narration", {
      content: fence("flowchart TD\n  A --> B --> C\n  A --> C"),
    });

    const html = (await exportNarrativeHtml(db, HOST))!;
    // Just the diagram. The document around it legitimately carries links.
    const start = html.indexOf('<div class="diagram">');
    const body = html.slice(start, html.indexOf("</svg>", start) + 6);
    assert.ok(body.includes("<svg"), "found the diagram");
    assert.ok(!/<script/i.test(body));
    assert.ok(!/@import/i.test(body));
    assert.ok(!/\son\w+\s*=/i.test(body), "no inline event handlers");
    assert.ok(!/https?:\/\//.test(body.replace(/xmlns="[^"]*"/g, "")),
      "a diagram must reference nothing over the network");
  });

  it("picks out an arrow and its label on hover or tap, with CSS alone", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "narration", {
      content: fence("flowchart TD\n  A -->|first| B\n  A -->|second| C\n  B --> C"),
    });

    const html = (await exportNarrativeHtml(db, HOST))!;
    const start = html.indexOf('<div class="diagram">');
    const svg = html.slice(start, html.indexOf("</svg>", start) + 6);
    const groups = svg.match(/<g class="brane-diagram-edge-hl"[^>]*>/g) ?? [];
    // One per edge for its line, and one more per labelled edge for its label,
    // painted above every line so no later stroke covers an earlier label.
    assert.equal(groups.length, 5, "a line group per edge, a label group per label");
    for (const g of groups) {
      // Hidden by attribute, so a page without the rule shows nothing extra;
      // focusable, so a tap can hold it open without a script.
      assert.match(g, /opacity="0"/);
      assert.match(g, /tabindex="0"/);
    }
    assert.ok(groups.some((g) => /aria-label="first"/.test(g)));
    // Above every edge label, which is what makes it disambiguate; below every
    // node, so the boxes cover the highlighted line's ends.
    const first = svg.indexOf('<g class="brane-diagram-edge-hl"');
    const last = svg.lastIndexOf('<g class="brane-diagram-edge-hl"');
    assert.ok(first > svg.indexOf(">second</text>"), "the highlight layer is painted after the edge labels");
    assert.ok(last < svg.indexOf(">A<") && last < svg.indexOf(">C<"),
      "and before the nodes");
    assert.ok(html.includes(DIAGRAM_EDGE_HIGHLIGHT_CSS), "the shared rule is in the document verbatim");
    assert.match(DIAGRAM_EDGE_HIGHLIGHT_CSS, /\.brane-diagram-edge-hl:focus\s*\{\s*opacity:\s*1/);
  });

  it("stops a highlighted line short of each arrowhead, and nowhere else", () => {
    const ends = (d: string) => {
      const n = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      return { start: [n[0], n[1]], end: [n[n.length - 2], n[n.length - 1]] };
    };
    const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const paths = (src: string) => {
      const svg = renderDiagram(src, { edgeHighlight: true })!.svg;
      const base = /<path d="([^"]+)" fill="none" stroke="var\(--brane-diagram-line/.exec(svg)![1];
      const hl = /<path d="([^"]+)" fill="none" stroke="var\(--brane-diagram-highlight/.exec(svg)![1];
      return { base: ends(base), hl: ends(hl), svg };
    };

    // A 3px line run under the point blunts it, so it stops one head length
    // back, and the highlight's head is anchored at its base to make up the
    // difference: the tip lands where the base line's does.
    const one = paths("flowchart TD\n  A --> B");
    assert.ok(Math.abs(dist(one.base.end, one.hl.end) - 10) < 0.01, "pulled back one head length");
    assert.deepEqual(one.hl.start, one.base.start, "the tail, which has no head, is untouched");
    assert.match(one.svg, /<marker id="ah-hl-[0-9a-f]+"[^>]*refX="0"/);

    const both = paths("flowchart TD\n  A <--> B");
    assert.ok(Math.abs(dist(both.base.start, both.hl.start) - 10) < 0.01, "both heads, both ends");
    assert.ok(Math.abs(dist(both.base.end, both.hl.end) - 10) < 0.01);

    // No head, nothing to blunt: the line runs into the box, which covers it.
    const open = paths("flowchart TD\n  A --- B");
    assert.deepEqual(open.hl.end, open.base.end);
    assert.deepEqual(open.hl.start, open.base.start);
  });

  it("draws no highlight layer for a caller that did not ask, having no rule to reveal it", () => {
    const drawn = renderDiagram("flowchart TD\n  A -->|x| B");
    assert.ok(drawn);
    assert.ok(!drawn.svg.includes("brane-diagram-edge-hl"));
    assert.ok(!drawn.svg.includes("tabindex"));
  });

  it("falls back to the highlighted code block for a diagram it cannot draw", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "narration", {
      content: fence("gantt\n  title A schedule\n  section S\n  task :a1, 2026-01-01, 30d"),
    });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.ok(!/<div class="diagram">/.test(html), "nothing should have been drawn");
    // The fence loop only substitutes non-null results, so an undrawn diagram
    // lands exactly as the code block it was before this feature existed.
    assert.ok(/gantt/.test(html), "the source is still there for the reader");
  });

  it("leaves other languages alone", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "narration", {
      content: "```js\nconst a = 1;\n```",
    });
    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.ok(!/<div class="diagram">/.test(html));
  });

  it("links a node labelled with a narrative that exists, and only that one", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    insertNarrative(db, PEER);
    appendEvent(db, HOST, "narration", {
      content: fence(`flowchart TD\n  A[${PEER}] --> B[codex-cccccccc]`),
    });

    const html = (await exportNarrativeHtml(db, HOST))!;
    const svg = html.slice(html.indexOf('<div class="diagram">'));
    // A sibling `<nid>.html`, the same target prose references already use —
    // *not* `brane://nid/…`, which is the app's in-band scheme and opens in no
    // browser, so it would have been a link that does nothing in a download.
    assert.ok(svg.includes(`<a href="${PEER}.html">`), "the real narrative links");
    assert.ok(!svg.includes("brane://nid/"), "no in-app scheme in a downloaded file");
    assert.equal((svg.match(/<a href="[a-z]+-[0-9a-z]{8}\.html/g) ?? []).length, 1,
      "the narrative that does not exist stays plain text");
  });

  it("draws several fences in one conversation, each with its own marker ids", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "narration", { content: fence("flowchart TD\n  A --> B") });
    appendEvent(db, HOST, "narration", { content: fence("flowchart LR\n  C --> D") });

    const html = (await exportNarrativeHtml(db, HOST))!;
    const ids = [...html.matchAll(/id="ah-([0-9a-f]+)"/g)].map((m) => m[1]);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1], "two diagrams on a page must not share a marker");
  });
});

describe("an author is told when their diagram will not draw", () => {
  it("warns, with the source as the fallback", () => {
    const out = diagnoseMarkdown("Look:\n\n" + fence("gantt\n  title X") + "\n\nafter");
    const d = out.find((w) => w.kind === "diagram_unsupported");
    assert.ok(d, "expected a diagram warning");
    assert.match(d.message, /gantt/);
    assert.ok(d.fallback.includes("gantt"), "the fallback is what the reader will see");
  });

  it("distinguishes a syntax error from an unsupported type", () => {
    const bad = diagnoseMarkdown(fence("flowchart TD\n  A --> @@@"));
    assert.equal(bad[0]?.kind, "diagram_parse_error");
  });

  it("points at the line inside the document, not inside the fence", () => {
    const md = "line one\nline two\n\n" + fence("flowchart TD\n  A --> B\n  click A cb");
    const d = diagnoseMarkdown(md).find((w) => w.kind === "diagram_unsupported");
    assert.ok(d);
    // The fence opens on line 4, so its body starts on line 5 and `click` is
    // the third body line: line 7.
    assert.equal(d.line, 7);
  });

  it("says nothing at all about a diagram that draws", () => {
    const out = diagnoseMarkdown(fence("flowchart TD\n  A --> B"));
    assert.deepEqual(out.filter((w) => w.kind.startsWith("diagram_")), []);
  });

  it("says nothing about a fence in another language", () => {
    const out = diagnoseMarkdown("```js\nnot a diagram\n```");
    assert.deepEqual(out.filter((w) => w.kind.startsWith("diagram_")), []);
  });

  it("leaves an unclosed fence to the warning that already covers it", () => {
    // `fence_unclosed` already says everything after it became one code block.
    // A second warning saying the diagram did not draw would be noise about a
    // consequence of the first.
    const out = diagnoseMarkdown("```mermaid\nflowchart TD\n A --> B");
    assert.ok(out.some((w) => w.kind === "fence_unclosed"));
    assert.deepEqual(out.filter((w) => w.kind.startsWith("diagram_")), []);
  });
});
