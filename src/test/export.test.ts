import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.js";
import { appendEvent } from "../db/events.js";
import { exportNarrativeHtml } from "../export.js";
import { MATH_BLOCK_CSS } from "../shared/markdown-math.js";
import { speakerColor, speakerBgColor } from "../shared/speaker-color.js";

// nids follow the `[a-z]+-[0-9a-z]{8}` shape the linkifier recognizes.
const HOST = "claude-aaaaaaaa";
const PEER = "goose-bbbbbbbb";
const GHOST = "codex-cccccccc"; // never inserted → not a known narrative

function insertNarrative(db: ReturnType<typeof createTestDb>, id: string): void {
  db.prepare(
    `INSERT INTO narratives (id, brane_id, agent_type, role, created_at, status)
     VALUES (?, 'brane-test', ?, 'worker', 0, 'active')`,
  ).run(id, id.split("-")[0]);
}

/** A narrative with the fields the header card renders — cost columns arrive by
 *  migration, so this doubles as a check that test DBs carry them. */
function insertCardNarrative(db: ReturnType<typeof createTestDb>, id: string): void {
  db.prepare(
    `INSERT INTO narratives (id, brane_id, agent_type, role, created_at, status,
                             fold_path, summary, cost_amount, cost_unit)
     VALUES (?, 'brane-test', ?, 'twin', ?, 'ended', '~/dev/brane', 'Doing a thing', 26.34, 'USD')`,
  ).run(id, id.split("-")[0], Date.now() - 3 * 86_400_000);
}

describe("exportNarrativeHtml — colocated interlinking", () => {
  it("links foreign nid:seq refs to a relative <nid>.html#seq-N", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    insertNarrative(db, PEER);
    appendEvent(db, HOST, "narration", { content: `see ${PEER}:9 for context` });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.match(html, new RegExp(`<a href="${PEER}\\.html#seq-9">${PEER}:9</a>`));
  });

  it("links a bare foreign nid to <nid>.html (no anchor)", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    insertNarrative(db, PEER);
    appendEvent(db, HOST, "narration", { content: `related: ${PEER}` });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.match(html, new RegExp(`<a href="${PEER}\\.html">${PEER}</a>`));
  });

  it("keeps self references in-page (#seq-N), not <self>.html", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "narration", { content: "hello" });
    appendEvent(db, HOST, "narration", { content: `as noted in ${HOST}:1` });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.match(html, new RegExp(`<a href="#seq-1">${HOST}:1</a>`));
    assert.ok(!html.includes(`href="${HOST}.html#seq-1"`), "self ref should not point at its own file");
  });

  it("does not linkify ids that are not known narratives", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "narration", { content: `unknown ${GHOST}:3 stays plain` });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.ok(!html.includes(`${GHOST}.html`), "unknown id should not become a link");
    assert.ok(html.includes(`${GHOST}:3`), "unknown id text should survive verbatim");
  });

  // Agents write references by hand as `[label](nid:seq)`. Passing those to
  // micromark untouched yields `<a href="">` — it reads `nid:` as an unknown
  // URL scheme and blanks the destination.
  it("rewrites a hand-written [label](nid:seq) destination", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    insertNarrative(db, PEER);
    appendEvent(db, HOST, "narration", { content: `your idea at [${PEER}:34](${PEER}:34)` });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.match(html, new RegExp(`<a href="${PEER}\\.html#seq-34">${PEER}:34</a>`));
    assert.ok(!html.includes('href=""'), "no reference should be left without a destination");
  });

  it("rewrites a hand-written self link, keeping its short label", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "narration", { content: "hello" });
    appendEvent(db, HOST, "narration", { content: `elaborated at [:1](${HOST}:1)` });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.match(html, /<a href="#seq-1">:1<\/a>/);
  });

  it("rewrites a hand-written brane://nid destination", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    insertNarrative(db, PEER);
    appendEvent(db, HOST, "narration", { content: `see [there](brane://nid/${PEER}/7)` });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.match(html, new RegExp(`<a href="${PEER}\\.html#seq-7">there</a>`));
  });

  it("leaves ordinary markdown links alone", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    insertNarrative(db, PEER);
    appendEvent(db, HOST, "narration", {
      content: `[docs](https://example.com/${PEER}) and [a path](src/export.ts)`,
    });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.match(html, new RegExp(`<a href="https://example.com/${PEER}">docs</a>`));
    assert.match(html, /<a href="src\/export\.ts">a path<\/a>/);
  });

  it("unlinks a hand-written ref to a narrative that does not exist", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "narration", { content: `dangling [ghost](${GHOST}:2) ref` });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.match(html, /dangling ghost ref/);
    assert.ok(!html.includes('href=""'), "a dead reference should not survive as an empty link");
  });

  it("does not linkify nids inside fenced code blocks", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    insertNarrative(db, PEER);
    appendEvent(db, HOST, "narration", { content: "```\ngrep " + PEER + ":9\n```" });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.ok(!html.includes(`${PEER}.html`), "code-fenced nid should stay plain");
  });
});

describe("exportNarrativeHtml — system events", () => {
  it("includes lifecycle events and marks them as system rows", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "started", { content: "Spawned claude (worker)" });
    appendEvent(db, HOST, "restarted", { content: "Restarted lazygit" });
    appendEvent(db, HOST, "narration", { content: "hello" });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.match(html, /class="row system-row" id="seq-1"/);
    // Role notation is normalized on the way out — see the attribution suite.
    assert.ok(html.includes("Spawned <code>claude</code> /worker"), "spawn event should be exported");
    assert.ok(html.includes("Restarted <code>lazygit</code>"), "restart event should be exported");
    assert.match(html, /class="row agent-row" id="seq-3"/, "narration keeps its own style");
  });

  it("keeps a twin's back-pointer to its predecessor, linkified", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    insertNarrative(db, PEER);
    appendEvent(db, HOST, "started", {
      content: `Twinned from ${PEER}:42`,
      re: [`${PEER}:42`],
    });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.match(html, new RegExp(`<a href="${PEER}\\.html#seq-42">${PEER}:42</a>`));
    // The legacy line gains the agent from the narrative row on the way out.
    assert.ok(html.includes("Spawned <code>claude</code> /twin from "), "twin line should carry the agent");
  });

  it("paints the fold a lifecycle line ends with, and only there", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    db.prepare("UPDATE narratives SET fold_path = ? WHERE id = ?").run("~/dev/brane", HOST);
    appendEvent(db, HOST, "started", { content: "Spawned claude (worker)" });
    appendEvent(db, HOST, "narration", { content: "it is in ~/dev/brane" });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.ok(
      html.includes('/worker in <a href="brane://fold/~/dev/brane">~/dev/brane</a>'),
      "a started row carries its fold as the brane://fold link",
    );
    assert.ok(html.includes("it is in ~/dev/brane</p>"), "prose is untouched");
  });

  it("counts only conversational events in the header count", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "started", { content: "Spawned claude (worker)" });
    appendEvent(db, HOST, "narration", { content: "hello" });
    appendEvent(db, HOST, "human_signal", { content: "hi", source: "web" });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.match(html, /2 messages/);
  });
});

describe("exportNarrativeHtml — header card", () => {
  it("renders the narrative card: id, fold, cost, role, activity span, summary", async () => {
    const db = createTestDb();
    insertCardNarrative(db, HOST);
    appendEvent(db, HOST, "narration", { content: "hello" });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.match(html, new RegExp(`<h1>${HOST}</h1>`));
    assert.match(html, /class="fold"><span class="label">in <\/span>~\/dev\/brane/);
    assert.match(html, /class="cost">\$26\.34</);
    assert.match(html, /class="role">\/twin</);
    // Created 3d ago, last event just now → the card's two-ended span.
    assert.match(html, /class="label">from 3d to \d+s ago</);
    assert.match(html, /class="summary">Doing a thing</);
  });

  it("stands in a snapshot glyph for the card's live status, and drops the badge", async () => {
    const db = createTestDb();
    insertCardNarrative(db, HOST);
    appendEvent(db, HOST, "narration", { content: "hello" });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.match(html, /class="snapshot">📸</);
    // Status is live state; a static snapshot must not claim it.
    assert.ok(!/\bDEAD\b|\bLIVE\b|\bIDLE\b/.test(html), "no live status badge in a static export");
  });

  it("anchors the relative span with absolute timestamps in a tooltip", async () => {
    const db = createTestDb();
    insertCardNarrative(db, HOST);
    appendEvent(db, HOST, "narration", { content: "hello" });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.match(html, /<div class="meta-line" title="created [^"]+"/);
  });

  it("omits the meta line entirely when there is nothing to put on it", async () => {
    const db = createTestDb();
    // insertNarrative has no cost and created_at 0 — role survives, so the line
    // still renders; what must not appear is an empty cost/fold artifact.
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "narration", { content: "hello" });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.ok(!html.includes('class="cost"'), "no cost span when cost is absent");
    assert.ok(!html.includes('class="fold"'), "no fold span when fold_path is absent");
  });
});

describe("exportNarrativeHtml — operator attribution", () => {
  it("heads an operator row with operator/channel (nid:seq)", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "human_signal", { content: "hi", source: "web" });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.match(
      html,
      new RegExp(`<div class="source"[^>]*><a href="#seq-1">operator/web \\(${HOST}:1\\)</a></div>`),
    );
    // The channel used to ride on the timestamp line; the header owns it now.
    assert.ok(!html.includes("web · "), "channel should not be duplicated onto the timestamp");
  });

  it("falls back to a bare operator header when the channel is unknown", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "human_signal", { content: "hi" });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.match(
      html,
      new RegExp(`<div class="source"[^>]*><a href="#seq-1">operator \\(${HOST}:1\\)</a></div>`),
    );
  });
});

describe("exportNarrativeHtml — foreign attribution", () => {
  it("links the speaker's nid to its sibling <speaker>.html and keeps (nid:seq) in-page", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    insertNarrative(db, PEER);
    appendEvent(db, HOST, "agent_signal", { content: "hello from next door", source: PEER });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.match(
      html,
      new RegExp(
        `<div class="source"[^>]*><a href="${PEER}\\.html" class="speaker">${PEER}</a> ` +
          `<a href="#seq-1">\\(${HOST}:1\\)</a></div>`,
      ),
    );
  });

  it("writes an unknown speaker as plain text rather than a dead link", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "agent_signal", { content: "hello", source: GHOST });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.match(html, new RegExp(`<div class="source"[^>]*>${GHOST} <a href="#seq-1">\\(${HOST}:1\\)</a></div>`));
    assert.ok(!html.includes(`${GHOST}.html`), "unknown speaker should not become a link");
  });
});

describe("exportNarrativeHtml — system attribution", () => {
  it("heads a system row with system (nid:seq) instead of leaving it anonymous", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "started", { content: "Spawned claude (worker)" });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.match(
      html,
      new RegExp(`<div class="source system-source"><a href="#seq-1">system \\(${HOST}:1\\)</a></div>`),
    );
  });

  it("writes a legacy spawn line in the invocation shape, matching every other surface", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "started", { content: "Spawned claude (worker)" });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.ok(html.includes("Spawned <code>claude</code> /worker"), "role should render as /worker");
    assert.ok(!html.includes("Spawned claude (worker)"), "parenthesised form should not survive");
  });

  it("rewrites any role, not just the ones brane ships", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "started", { content: "Spawned claude (haruspex)" });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.ok(html.includes("Spawned <code>claude</code> /haruspex"));
  });

  it("leaves parenthesised prose alone", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "restarted", {
      content: "Revived claude session (forked — original still live)",
    });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.ok(
      html.includes("(forked — original still live)"),
      "multi-word parenthetical is prose, not a role",
    );
  });

  it("does not rewrite roles in what someone actually said", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "narration", { content: "spawned a helper (worker)" });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.ok(html.includes("(worker)"), "narration content is verbatim");
  });
});

/** A wide equation must survive the trip out of the app.
 *
 *  The export carries no script, so everything about how display math scrolls
 *  — and how it says that it can — has to be in the stylesheet, and has to be
 *  the same stylesheet the app injects. See MATH_BLOCK_CSS.
 */
describe("exportNarrativeHtml — display math", () => {
  const WIDE = "$$\\sum_{n=0}^{\\infty} \\frac{1}{16^n}\\left(\\frac{4}{8n+1} - \\frac{2}{8n+4}\\right)$$";

  it("carries the app's own scroll rules rather than a second copy of them", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "narration", { content: WIDE });

    const html = (await exportNarrativeHtml(db, HOST))!;
    assert.ok(html.includes(MATH_BLOCK_CSS), "the shared block is in the document verbatim");
  });

  it("keeps the hint scriptless, since the export has no other option", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "narration", { content: WIDE });

    const html = (await exportNarrativeHtml(db, HOST))!;
    const style = html.slice(0, html.indexOf("</style>"));
    // Everything about when an edge fades is decided by a scroll timeline the
    // browser drives itself. An export that had to measure its own overflow
    // would need a script, and then it would no longer be a file that opens
    // anywhere.
    assert.match(style, /animation-timeline: scroll\(self x\)/);
    assert.match(style, /mask-image: linear-gradient/);
  });
});

describe("exportNarrativeHtml — foreign speaker colors", () => {
  // The export is a snapshot of what the app shows, and what the app shows for
  // a foreign row is its speaker's hue from `shared/speaker-color` — at the
  // 🎨 Recolor salt the device is viewing with. These pin that the export
  // calls the same functions with the same salt, rather than a lookalike.
  async function foreignRow(palette?: number): Promise<{ bubble: string; source: string }> {
    const db = createTestDb();
    insertNarrative(db, HOST);
    insertNarrative(db, PEER);
    appendEvent(db, HOST, "agent_signal", { content: "hello from a peer", source: PEER });
    const html = (await exportNarrativeHtml(db, HOST, palette === undefined ? {} : { palette }))!;
    const bubble = html.match(/<div class="bubble foreign"[^>]*>/)?.[0] ?? "";
    const source = html.match(/<div class="source"[^>]*>/)?.[0] ?? "";
    return { bubble, source };
  }

  it("colors a foreign row with its speaker's default-palette hue", async () => {
    const { bubble, source } = await foreignRow();
    assert.ok(bubble.includes(`style="background:${speakerBgColor(PEER)}"`), bubble);
    assert.ok(source.includes(`style="color:${speakerColor(PEER)}"`), source);
  });

  it("applies the palette salt the request carries", async () => {
    const { bubble, source } = await foreignRow(3);
    assert.ok(bubble.includes(`style="background:${speakerBgColor(PEER, 3)}"`), bubble);
    assert.ok(source.includes(`style="color:${speakerColor(PEER, 3)}"`), source);
    // And it is a different color than the default, or the salt did nothing.
    assert.notEqual(speakerBgColor(PEER, 3), speakerBgColor(PEER));
  });

  it("leaves non-foreign rows uncolored", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "narration", { content: "mine" });
    appendEvent(db, HOST, "human_signal", { content: "yours", source: "web" });
    const html = (await exportNarrativeHtml(db, HOST, { palette: 3 }))!;
    assert.ok(!/<div class="bubble (agent|operator)" style=/.test(html), html);
    assert.ok(!/<div class="source" style=/.test(html), html);
  });
});

describe("exportNarrativeHtml — selected messages", () => {
  /** Five messages, seqs 1–5, so a selection has something to leave out. */
  function conversation() {
    const db = createTestDb();
    insertNarrative(db, HOST);
    for (const n of [1, 2, 3, 4, 5]) {
      appendEvent(db, HOST, n % 2 === 0 ? "human_signal" : "narration", {
        content: `message ${n}`,
        ...(n % 2 === 0 ? { source: "web" } : {}),
      });
    }
    return db;
  }

  it("names the 💾 download after its count and contents", async () => {
    const full = (await exportNarrativeHtml(conversation(), HOST, { interactive: true }))!;
    const only = (await exportNarrativeHtml(conversation(), HOST, { interactive: true, seqs: [2] }))!;
    const except = (await exportNarrativeHtml(conversation(), HOST, { interactive: true, seqs: [2], seqsMode: "except" }))!;
    assert.match(full, /a\.download = "claude-aaaaaaaa\.html";/);
    assert.match(only, /a\.download = "claude-aaaaaaaa\.1-of-5\.[0-9a-f]{6}\.html";/);
    assert.match(except, /a\.download = "claude-aaaaaaaa\.4-of-5\.[0-9a-f]{6}\.html";/, "neither name says which side was taken");
  });

  it("a half-selection's excerpt and redaction download under different names", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    for (const n of [1, 2, 3, 4]) appendEvent(db, HOST, "narration", { content: `message ${n}` });
    const name = (html: string) => /a\.download = "([^"]+)";/.exec(html)![1];
    const only = name((await exportNarrativeHtml(db, HOST, { interactive: true, seqs: [1, 4] }))!);
    const except = name((await exportNarrativeHtml(db, HOST, { interactive: true, seqs: [1, 4], seqsMode: "except" }))!);
    assert.match(only, /\.2-of-4\./);
    assert.match(except, /\.2-of-4\./);
    assert.notEqual(only, except);
  });

  it("leaves the summary out of an `except` export, which it may paraphrase", async () => {
    const db = createTestDb();
    insertCardNarrative(db, HOST);
    appendEvent(db, HOST, "narration", { content: "the secret plan" });
    appendEvent(db, HOST, "narration", { content: "the public part" });
    const except = (await exportNarrativeHtml(db, HOST, { seqs: [1], seqsMode: "except" }))!;
    assert.ok(!except.includes('class="summary"'), "a redacted export carries no summary");
    // Nor does the copy the 💾 button saves, which is embedded as base64.
    const wrapped = (await exportNarrativeHtml(db, HOST, { interactive: true, seqs: [1], seqsMode: "except" }))!;
    const saved = Buffer.from(/atob\("([^"]+)"\)/.exec(wrapped)![1], "base64").toString("utf8");
    assert.ok(saved.includes("the public part"), "decoded the saved copy");
    assert.ok(!saved.includes('class="summary"'), "the saved copy carries no summary either");
    const only = (await exportNarrativeHtml(db, HOST, { seqs: [2] }))!;
    assert.match(only, /class="summary">Doing a thing</, "an excerpt keeps it");
    const full = (await exportNarrativeHtml(db, HOST))!;
    assert.match(full, /class="summary">Doing a thing</);
  });

  it("exports only the selected seqs", async () => {
    const html = (await exportNarrativeHtml(conversation(), HOST, { seqs: [2, 4] }))!;
    assert.ok(html.includes('id="seq-2"'), "selected seq 2 should be present");
    assert.ok(html.includes('id="seq-4"'), "selected seq 4 should be present");
    for (const absent of [1, 3, 5]) {
      assert.ok(!html.includes(`id="seq-${absent}"`), `seq ${absent} should not be exported`);
    }
  });

  it("keeps #seq-N anchors, so a citation into an excerpt still resolves", async () => {
    const html = (await exportNarrativeHtml(conversation(), HOST, { seqs: [4] }))!;
    assert.match(html, /<div class="row [a-z]+-row" id="seq-4">/);
    assert.match(html, /<a href="#seq-4"/);
  });

  it("says how many of how many in the header", async () => {
    const html = (await exportNarrativeHtml(conversation(), HOST, { seqs: [2, 4] }))!;
    assert.match(html, /Exported [^<]* · 2 of 5 messages</);
  });

  it("marks the gap between messages that were not adjacent", async () => {
    const html = (await exportNarrativeHtml(conversation(), HOST, { seqs: [1, 4] }))!;
    assert.match(html, /<div class="elision">⋯ 2 messages not shown<\/div>/);
  });

  it("singularizes a one-message gap", async () => {
    const html = (await exportNarrativeHtml(conversation(), HOST, { seqs: [1, 3] }))!;
    assert.match(html, /⋯ 1 message not shown/);
  });

  it("marks no gap between adjacent selections, or before the first", async () => {
    const html = (await exportNarrativeHtml(conversation(), HOST, { seqs: [3, 4] }))!;
    assert.ok(!html.includes("not shown"), "adjacent picks are adjacent; nothing was skipped between them");
  });

  it("is byte-identical to a full export when nothing is selected", async () => {
    const db = conversation();
    // `Exported <now>` is the one field that moves between two calls, so the
    // comparison strips it rather than racing the clock.
    const strip = (h: string) => h.replace(/Exported [^<]*</, "Exported <");
    const full = strip((await exportNarrativeHtml(db, HOST))!);
    assert.equal(strip((await exportNarrativeHtml(db, HOST, { seqs: [] }))!), full);
    assert.equal(strip((await exportNarrativeHtml(db, HOST, { seqs: undefined }))!), full);
  });

  it("exports everything but the selection under seqsMode: except", async () => {
    const html = (await exportNarrativeHtml(conversation(), HOST, {
      seqs: [2, 4],
      seqsMode: "except",
    }))!;
    for (const kept of [1, 3, 5]) {
      assert.ok(html.includes(`id="seq-${kept}"`), `seq ${kept} should be exported`);
    }
    for (const dropped of [2, 4]) {
      assert.ok(!html.includes(`id="seq-${dropped}"`), `seq ${dropped} was excluded`);
    }
  });

  it("discloses a complement the same way it discloses an excerpt", async () => {
    // "3 of 5" whichever side of the selection it is: a reader handed the file
    // can tell that messages are missing, which is the whole of what the line
    // promises. It does not say which ones, because an excerpt never has.
    const html = (await exportNarrativeHtml(conversation(), HOST, {
      seqs: [2, 4],
      seqsMode: "except",
    }))!;
    assert.match(html, /Exported [^<]* · 3 of 5 messages</);
  });

  it("marks each excluded run as the gap it is", async () => {
    // seqs 2 and 4 removed from 1–5 leaves three messages with a one-message
    // hole between each pair — the same elision row an excerpt gets, for the
    // same reason: two bubbles stacked together would claim adjacency.
    const html = (await exportNarrativeHtml(conversation(), HOST, {
      seqs: [2, 4],
      seqsMode: "except",
    }))!;
    assert.equal(html.match(/⋯ 1 message not shown/g)?.length, 2);
  });

  it("marks no gap where the excluded messages were at the ends", async () => {
    const html = (await exportNarrativeHtml(conversation(), HOST, {
      seqs: [1, 5],
      seqsMode: "except",
    }))!;
    assert.ok(!html.includes("not shown"), "2, 3, 4 are adjacent; the header states the rest");
  });

  it("exports the whole conversation when the complement excludes nothing", async () => {
    // No selection means no scope to invert — `except` nothing is everything,
    // and says so as a full export rather than as "5 of 5".
    const db = conversation();
    const strip = (h: string) => h.replace(/Exported [^<]*</, "Exported <");
    const full = strip((await exportNarrativeHtml(db, HOST))!);
    assert.equal(strip((await exportNarrativeHtml(db, HOST, { seqs: [], seqsMode: "except" }))!), full);
  });

  it("exports an empty document when the selection is everything", async () => {
    // Honest rather than guarded: the operator asked for the complement of the
    // whole conversation, and the header says it is 0 of 5.
    const html = (await exportNarrativeHtml(conversation(), HOST, {
      seqs: [1, 2, 3, 4, 5],
      seqsMode: "except",
    }))!;
    assert.match(html, /· 0 of 5 messages</);
    assert.ok(!/id="seq-\d+"/.test(html), "nothing was left to export");
  });

  it("ignores seqsMode: only, which is what an excerpt already was", async () => {
    const db = conversation();
    const strip = (h: string) => h.replace(/Exported [^<]*</, "Exported <");
    assert.equal(
      strip((await exportNarrativeHtml(db, HOST, { seqs: [2, 4], seqsMode: "only" }))!),
      strip((await exportNarrativeHtml(db, HOST, { seqs: [2, 4] }))!),
    );
  });

  it("exports a selected lifecycle row as itself", async () => {
    const db = createTestDb();
    insertNarrative(db, HOST);
    appendEvent(db, HOST, "started", { content: "Spawned `claude` /worker" });
    appendEvent(db, HOST, "narration", { content: "hello" });

    const html = (await exportNarrativeHtml(db, HOST, { seqs: [1] }))!;
    assert.match(html, /<div class="bubble system"/);
    // Lifecycle rows are shown but never counted, here as in a full export.
    assert.match(html, /· 0 of 1 messages</);
  });
});
