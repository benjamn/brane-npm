import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type Database from "better-sqlite3";
import { micromark } from "micromark";
import { gfmTable, gfmTableHtml } from "micromark-extension-gfm-table";
import { gfmAutolinkLiteral, gfmAutolinkLiteralHtml } from "micromark-extension-gfm-autolink-literal";
import { gfmTaskListItem, gfmTaskListItemHtml } from "micromark-extension-gfm-task-list-item";
import { math } from "./math-syntax.js";
import { NID_PATTERN, NID_REF_PATTERN } from "./shared/markdown-nids.js";
import { isInlinePayload, INLINE_PAYLOAD_MIME } from "./shared/payload-inline.js";
import { readEvents, readEventsBySeqs } from "./db/events.js";
import { exportFileName, type SeqSelectionMode } from "./shared/export-selection.js";
import { getPayloadsDir } from "./db/schema.js";
import { highlightHtml } from "./highlight.js";
import { renderDiagram } from "./diagram/index.js";
import { nidHrefFor } from "./diagram/links.js";
import { mathHtmlExtension, katexStyleFor } from "./math.js";
import { MATH_BLOCK_CSS, prepareMathMarkdown } from "./shared/markdown-math.js";
import { DIAGRAM_EDGE_HIGHLIGHT_CSS } from "./shared/diagram-css.js";
import { speakerColor, speakerBgColor } from "./shared/speaker-color.js";
import {
  formatActivitySpan,
  formatCost,
  systemLine,
  FOLD_COLOR,
  FOLD_LINK_SCHEME,
  isSystemEvent,
  CONVERSATIONAL_EVENT_TYPES_LIST,
} from "./shared/narrative-format.js";

// `SELECT *`, so columns that only exist via migration (cost_*) are optional.
interface NarrativeRow {
  id: string;
  summary: string | null;
  title: string | null;
  agent_type?: string | null;
  role?: string | null;
  fold_path?: string | null;
  created_at?: number;
  cost_amount?: number | null;
  cost_unit?: string | null;
  /** Time of the newest event, from the subquery — mirrors the list endpoint. */
  last_activity?: number | null;
}

interface ExportEvent {
  seq: number;
  time: number;
  type: string;
  content: string | null;
  source: string | null;
  payloads: string[] | null;
}

// Which payloads are images — and the type each embeds as — is the same rule
// the app renders by and the daemon serves by: `src/shared/payload-inline.ts`.
// Kept as one table there because a filter that disagrees with the type map
// drops an image from the export without saying anything.
const isImagePayload = isInlinePayload;


// Shape of an autolink literal, per GFM. Only needed to *avoid* rewriting one:
// micromark turns these into links on its own (see renderMarkdown), and a URL
// whose path happens to contain a narrative id — say
// https://brane.organelle.dev/claude-4c7289d1 — must survive intact.
const AUTOLINK_LITERAL = "(?:https?://|www\\.)[^\\s<]+";

// The two href forms an agent writes a reference as by hand — a bare `nid:seq`
// and the canonical `brane://nid/<nid>/<seq>`. Both are what expo's Markdown
// renderer accepts (components/Markdown.tsx), so both turn up in stored content.
const HAND_WRITTEN_REF = new RegExp(
  `^(?:brane://nid/(${NID_PATTERN})(?:/(\\d+))?|${NID_REF_PATTERN})$`,
);

/** Where a reference points within a colocated directory of `<nid>.html` files.
 *  Self references stay in-page (`#seq-N`) so they resolve even when the file
 *  stands alone; foreign references point at the sibling file. */
function refHref(nid: string, seq: string | undefined, selfNid: string): string {
  if (nid === selfNid) return seq ? `#seq-${seq}` : `${nid}.html`;
  return `${nid}.html${seq ? `#seq-${seq}` : ""}`;
}

// Turn `nid` / `nid:seq` references in message markdown into relative links so
// that a directory of exported `<nid>.html` files interlinks. Only references
// to narratives that actually exist (knownIds) are linked, so arbitrary strings
// matching the id shape aren't turned into dead links. Skips code fences and
// bare URLs, matching the live app's linkifier.
//
// Markdown links are not skipped outright: a link an agent wrote by hand as
// `[label](claude-4c7289d1:42)` needs its *destination* rewritten, because
// micromark sanitizes hrefs against a protocol allowlist and reads `nid:` as an
// unknown scheme — leaving `<a href="">`. Links to anything else pass through.
function linkifyNarrativeRefs(md: string, knownIds: Set<string>, selfNid: string): string {
  if (knownIds.size === 0) return md;
  const re = new RegExp(
    `(` +
      "```[\\s\\S]*?```" +
      "|" + AUTOLINK_LITERAL +
    `)` +
    "|\\[([^\\]]*?)\\]\\(([^)]*?)\\)" +
    "|`" + NID_REF_PATTERN + "`" +
    "|" + NID_REF_PATTERN,
    "g",
  );
  return md.replace(re, (match, skip, label, dest, btNid, btSeq, bareNid, bareSeq) => {
    if (skip) return skip;
    if (dest !== undefined) {
      const ref = dest.match(HAND_WRITTEN_REF);
      if (!ref) return match;
      // Groups 1/2 are the `brane://` form, 3/4 the bare one; only one fires.
      const nid = ref[1] ?? ref[3];
      const seq = ref[1] ? ref[2] : ref[4];
      // An unknown nid has nothing to point at, and leaving the link in place
      // would only hand micromark another href to blank. Keep the label as
      // prose instead — same policy the bare-reference branch follows.
      if (!knownIds.has(nid)) return label;
      return `[${label}](${refHref(nid, seq, selfNid)})`;
    }
    const nid = btNid || bareNid;
    const seq = btSeq || bareSeq;
    if (!nid || !knownIds.has(nid)) return match;
    return `[${seq ? `${nid}:${seq}` : nid}](${refHref(nid, seq, selfNid)})`;
  });
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

// micromark HTML-escapes code content on output. Reverse that before feeding
// to Shiki, which wants raw source.
function unescapeMicromarkHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** `trusted` keeps hrefs micromark would otherwise blank as unknown schemes.
 *  It is set only for system rows, whose markdown the daemon wrote itself, so
 *  the `brane://fold/…` link `systemLine` builds survives to be styled; the
 *  default stays strict for anything a person or agent said. */
async function renderMarkdown(
  md: string,
  opts: { trusted?: boolean; diagramHref?: (label: string) => string | null } = {},
): Promise<string> {
  // prepareMathMarkdown runs before the parse, not after: micromark-extension-math
  // reads `$10k–$500k` as math over `10k–` and offers no veto once it has
  // tokenized, so the dollars that aren't delimiters get escaped up front. The
  // app runs the same function on the same string — see shared/markdown-math.ts.
  const html = micromark(prepareMathMarkdown(md), {
    allowDangerousProtocol: opts.trusted === true,
    extensions: [gfmTable(), gfmAutolinkLiteral(), gfmTaskListItem(), math()],
    htmlExtensions: [
      gfmTableHtml(),
      gfmAutolinkLiteralHtml(),
      gfmTaskListItemHtml(),
      mathHtmlExtension(),
    ],
  });
  // Collect every fenced block with a known language, highlight in parallel,
  // then substitute back. Works because fenced code blocks can't nest and
  // micromark emits exactly <pre><code class="language-XXX">…</code></pre>.
  const re = /<pre><code class="language-([\w+-]+)">([\s\S]*?)<\/code><\/pre>/g;
  const jobs: Array<{ match: string; promise: Promise<string | null> }> = [];
  for (const m of html.matchAll(re)) {
    const [match, lang, encoded] = m;
    const raw = unescapeMicromarkHtml(encoded);
    // A mermaid fence draws instead of being highlighted — the *same*
    // `renderDiagram` the app reaches through POST /api/diagram, so an export
    // is a snapshot of the live view rather than a lookalike of it. The SVG is
    // static: no script, which is the export's whole constraint.
    //
    // Nothing else changes, because this loop already substitutes only where
    // the result is non-null. A diagram brane doesn't draw therefore lands as
    // the highlighted code block it would have been anyway.
    if (lang === "mermaid") {
      const drawn = renderDiagram(raw, { hrefFor: opts.diagramHref, edgeHighlight: true });
      jobs.push({
        match,
        promise: Promise.resolve(
          drawn ? `<div class="diagram">${drawn.svg}</div>` : await highlightHtml(raw, lang),
        ),
      });
      continue;
    }
    jobs.push({ match, promise: highlightHtml(raw, lang) });
  }
  if (jobs.length === 0) return html;
  const results = await Promise.all(jobs.map((j) => j.promise));
  let out = html;
  jobs.forEach((job, i) => {
    const replacement = results[i];
    if (replacement) out = out.replace(job.match, replacement);
  });
  return out;
}

async function loadImageDataUri(nid: string, relPath: string): Promise<string | null> {
  try {
    // Payload paths are stored as "nid/filename"; getPayloadsDir returns the
    // per-narrative dir, so we only need the basename portion that follows.
    const parts = relPath.split("/");
    const filename = parts[parts.length - 1];
    const dir = getPayloadsDir(nid);
    const target = resolve(dir, filename);
    if (!target.startsWith(dir)) return null;
    const ext = extname(filename).toLowerCase();
    const mime = INLINE_PAYLOAD_MIME[ext];
    if (!mime) return null;
    const buf = await readFile(target);
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

interface ExportOptions {
  interactive?: boolean;
  /** The 🎨 Recolor salt the requesting device views this narrative with, so
   *  foreign speakers wear the same hues here as in the app. 0 (the default)
   *  is the palette every narrative starts with. */
  palette?: number;
  /** The seqs the operator had selected when they hit Export — the chat's own
   *  selection (`selectedSeqs`), the same set that feeds a signal's `re`.
   *  Present means an excerpt: these events (or, under `seqsMode: "except"`,
   *  every event but these), in seq order, with the gaps between them marked.
   *  Absent (or empty) means the whole conversation, which is what every
   *  export was before this existed. */
  seqs?: number[];
  /** Which side of `seqs` to export. `"only"` (the default) is the excerpt;
   *  `"except"` is its complement — the conversation with those messages left
   *  out. Meaningless without `seqs`, and ignored there: excluding nothing
   *  from everything is the whole conversation either way. */
  seqsMode?: SeqSelectionMode;
}

/** How many *messages* this narrative holds in a seq range — conversational
 *  types only, and only those with something to show, which is exactly what
 *  the document's own count means by "messages". Asked of SQLite rather than
 *  of a materialized event list: an excerpt must not have to build the
 *  conversation in order to say how much of it it left out.
 *
 *  `after` / `before` are exclusive, matching `readEvents`. */
function countMessages(
  db: Database.Database,
  nid: string,
  range: { after?: number; before?: number } = {},
): number {
  const types = CONVERSATIONAL_EVENT_TYPES_LIST.map(() => "?").join(",");
  const conditions = [
    "narrative_id = ?",
    `type IN (${types})`,
    // The has-something-to-show rule the render pass applies, in SQL. `payloads`
    // is a JSON array or NULL; `appendEvent` writes NULL rather than "[]", and
    // the literal is matched anyway so a hand-written row can't slip past.
    "((content IS NOT NULL AND content != '') OR (payloads IS NOT NULL AND payloads NOT IN ('', '[]')))",
  ];
  const params: (string | number)[] = [nid, ...CONVERSATIONAL_EVENT_TYPES_LIST];
  if (range.after !== undefined) { conditions.push("seq > ?"); params.push(range.after); }
  if (range.before !== undefined) { conditions.push("seq < ?"); params.push(range.before); }
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE ${conditions.join(" AND ")}`)
    .get(...params) as { n: number };
  return row.n;
}

export async function exportNarrativeHtml(
  db: Database.Database,
  nid: string,
  opts: ExportOptions = {},
): Promise<string | null> {
  // `n.*` plus the newest-event time, exactly as the daemon's list endpoint
  // builds a card's data (server.ts) — the header below is that same card.
  const narrative = db
    .prepare(
      `SELECT n.*, (
         SELECT time FROM events WHERE narrative_id = n.id ORDER BY seq DESC LIMIT 1
       ) AS last_activity FROM narratives n WHERE n.id = ?`,
    )
    .get(nid) as NarrativeRow | undefined;
  if (!narrative) return null;

  const selectedSeqs = opts.seqs && opts.seqs.length > 0
    ? [...new Set(opts.seqs)].sort((a, b) => a - b)
    : null;
  // Which side of the selection this export is. `except` inverts it: the same
  // taps, read as "everything but these".
  const excluding = selectedSeqs !== null && opts.seqsMode === "except";
  // An excerpt reads *only what it exports*. `seq IN (…)` is an index lookup
  // per selected message, so exporting two messages out of ten thousand costs
  // two rows — where reading the conversation and filtering it afterwards cost
  // ten thousand, every one of them with its JSON columns parsed.
  //
  // The complement has no such shortcut and wants none: it exports nearly the
  // whole conversation, so it reads the whole conversation and drops the
  // handful of rows the operator picked. That is a full export's cost, which
  // is what this is.
  const excluded = excluding ? new Set(selectedSeqs) : null;
  const raw = selectedSeqs
    ? excluded
      ? readEvents(db, nid, { after: 0 }).filter((e: any) => !excluded.has(e.seq))
      : readEventsBySeqs(db, nid, selectedSeqs)
    : readEvents(db, nid, { after: 0 });
  // How many messages the narrative actually holds, for the footer's "3 of 47".
  // A count, asked of SQLite, not a length of something built. Both scopes are
  // excerpts and both disclose the same way — "44 of 47" is as much an excerpt
  // as "3 of 47", and a reader handed the file can tell neither how it was
  // chosen nor that they should care.
  const totalMessages = selectedSeqs ? countMessages(db, nid) : 0;
  // Every event with something to show is exported, including lifecycle types
  // (`started`, `restarted`, `binding_rejected`) — they carry real context, like
  // the `/twin from <nid>:<seq>` back-pointer that opens a twin's narrative. A
  // selected row that turns out to be empty is dropped by this same rule, so an
  // excerpt is a subset of the full document rather than a different one.
  const events: ExportEvent[] = raw
    .filter((e: any) => e.content || (e.payloads && e.payloads.length > 0))
    .map((e: any) => ({
      seq: e.seq,
      time: e.time,
      type: e.type,
      content: e.content ?? null,
      source: e.source ?? null,
      payloads: (e.payloads as string[] | null) ?? null,
    }));

  // Inline image payloads as data URIs; non-image payloads render as file-name chips.
  const imagePaths = new Set<string>();
  for (const e of events) {
    for (const p of e.payloads ?? []) {
      if (isImagePayload(p)) imagePaths.add(p);
    }
  }
  const imageDataUris = new Map<string, string>();
  await Promise.all(
    Array.from(imagePaths).map(async (p) => {
      const uri = await loadImageDataUri(nid, p);
      if (uri) imageDataUris.set(p, uri);
    }),
  );

  // Known narrative ids in this daemon — used to gate which references become
  // links, so exports dropped into one directory interlink without producing
  // dead links for strings that merely resemble an id.
  const knownIds = new Set<string>(
    (db.prepare("SELECT id FROM narratives").all() as { id: string }[]).map((r) => r.id),
  );

  // One resolver for the whole document, so its existence lookups are
  // memoised across every diagram in the conversation.
  //
  // It points at the sibling `<nid>.html` files the way prose references
  // already do, *not* at `brane://nid/…`: that scheme is the app's in-band
  // signal and no browser opens it, so a diagram node in a downloaded export
  // would have been a link that does nothing.
  const diagramHref = nidHrefFor(db, (id, seq) => refHref(id, seq, nid));

  const rendered = await Promise.all(
    events.map(async (e) => ({
      event: e,
      contentHtml: e.content
        ? isSystemEvent(e.type)
          ? await renderMarkdown(
              linkifyNarrativeRefs(
                systemLine({ type: e.type, content: e.content }, { agent: narrative.agent_type, fold: narrative.fold_path }),
                knownIds,
                nid,
              ),
              { trusted: true, diagramHref },
            )
          : await renderMarkdown(linkifyNarrativeRefs(e.content, knownIds, nid), { diagramHref })
        : "",
    })),
  );

  const title = `${nid} — brane conversation`;
  // Every "now" in this document is the moment of export, so the activity span
  // and the "Exported …" stamp below it can't disagree.
  const exportedAt = Date.now();
  const exportDate = formatTimestamp(exportedAt);
  // Lifecycle rows are shown but not counted — "12 messages" should mean twelve
  // things said, not twelve rows on the page.
  const exportedMessageSeqs = events.filter((e) => !isSystemEvent(e.type)).map((e) => e.seq);
  const messageCount = exportedMessageSeqs.length;
  // An excerpt says so where the count goes. "3 of 47 messages" is the whole
  // disclosure: it is the one line that tells a reader handed this file that
  // there was more conversation than the document contains.
  const countLine = selectedSeqs
    ? `${messageCount} of ${totalMessages} messages`
    : `${messageCount} messages`;

  // The header is the narrative card, rendered statically: identity row (id ·
  // fold) over the meta line (cost · /role · activity span), then the summary.
  // Both lines come from the same `formatCost` / `formatActivitySpan` the app's
  // card uses, so the two can't drift. The card's live status dot and
  // LIVE/IDLE/DEAD badge are deliberately absent — a snapshot has no live
  // status — and 📸 stands in their place.
  const cost = formatCost(narrative.cost_amount, narrative.cost_unit);
  const activitySpan =
    typeof narrative.created_at === "number"
      ? formatActivitySpan(narrative.created_at, narrative.last_activity, exportedAt)
      : null;
  const metaBits = [
    cost ? `<span class="cost">${escHtml(cost)}</span>` : "",
    narrative.role ? `<span class="role">/${escHtml(narrative.role)}</span>` : "",
    activitySpan ? `<span class="label">from ${escHtml(activitySpan)}</span>` : "",
  ].filter(Boolean);
  // The span is relative to export time, which a reader opening this months
  // later can't know — so the absolute timestamps ride along as a tooltip.
  const spanTitle = activitySpan && typeof narrative.created_at === "number"
    ? ` title="${escHtml(
        `created ${formatTimestamp(narrative.created_at)}${
          narrative.last_activity ? ` · last activity ${formatTimestamp(narrative.last_activity)}` : ""
        }`,
      )}"`
    : "";
  const metaLine = metaBits.length
    ? `<div class="meta-line"${spanTitle}><span class="snapshot">📸</span>${metaBits.join(" ")}</div>`
    : "";
  const foldLine = narrative.fold_path
    ? ` <span class="fold"><span class="label">in </span>${escHtml(narrative.fold_path)}</span>`
    : "";

  // The agent-written summary describes the whole narrative, so it can
  // paraphrase exactly the messages an `except` export was asked to leave out.
  // A redaction the header then undoes is worse than none; the excerpt keeps it.
  const summaryHtml = narrative.summary && !excluding
    ? `<div class="summary">${escHtml(narrative.summary)}</div>`
    : "";

  const palette = opts.palette ?? 0;
  // What an excerpt skipped between two of its messages — one indexed COUNT per
  // gap, whose cost is the gap rather than the conversation. A full export has
  // no gaps by construction and asks nothing.
  const gapBetween = (lo: number, hi: number) =>
    hi - lo <= 1 ? 0 : countMessages(db, nid, { after: lo, before: hi });

  const messagesHtml = rendered.map(({ event: e, contentHtml }, i) => {
    const fromOp = e.type === "human_signal";
    const foreign = e.type === "agent_signal";
    // A foreign row wears its speaker's hue — the same `speakerColor` /
    // `speakerBgColor` the app's bubbles use, at the same salt, so the export
    // is a snapshot of the conversation as the operator saw it rather than a
    // lookalike in a single flat green. Inline rather than a class because the
    // hue is per speaker and the document carries no script to compute it.
    const speakerStyle = foreign
      ? ` style="background:${speakerBgColor(e.source || "unknown", palette)}"`
      : "";
    const sourceStyle = foreign && e.source
      ? ` style="color:${speakerColor(e.source, palette)}"`
      : "";
    const system = isSystemEvent(e.type);
    const time = formatTimestamp(e.time);

    let bubbleClass = "agent";
    if (system) bubbleClass = "system";
    else if (fromOp) bubbleClass = "operator";
    else if (foreign) bubbleClass = "foreign";

    // Attribution header. Every row gets one, in the same slot. Lifecycle events
    // have no `source` — the daemon wrote them — so they name "system"
    // explicitly rather than going anonymous. Operator rows say "operator"
    // rather than the app's "you": an exported file is read by whoever it was
    // handed to, who is generally not the operator. The channel it arrived
    // over (`web`, `cli`, …) rides along as `operator/web`, since a snapshot
    // is the only place that provenance survives.
    //
    // A foreign row's speaker is a second link: the nid points at the sibling
    // `<speaker>.html`, the same way references in message bodies do, so a
    // directory of exports lets the reader follow a foreign narration back to
    // where it was written. Only the nid navigates — the `(nid:seq)` beside it
    // stays the in-page anchor every other row has — matching the app, where
    // the bubble body is for reading and copying, not for leaving the page. A
    // speaker with no sibling file to point at (not a narrative this daemon
    // knows) is written as plain text rather than a dead link.
    const selfAnchor = (text: string) => `<a href="#seq-${e.seq}">${escHtml(text)}</a>`;
    const sourceHtml = system
      ? selfAnchor(`system (${nid}:${e.seq})`)
      : fromOp
        ? selfAnchor(`${e.source ? `operator/${e.source}` : "operator"} (${nid}:${e.seq})`)
        : e.source
          ? foreign
            ? `${
                knownIds.has(e.source)
                  ? `<a href="${refHref(e.source, undefined, nid)}" class="speaker">${escHtml(e.source)}</a>`
                  : escHtml(e.source)
              } ${selfAnchor(`(${nid}:${e.seq})`)}`
            : selfAnchor(`${e.source}:${e.seq}`)
          : "";
    const source = sourceHtml
      ? `<div class="source${system ? " system-source" : ""}"${sourceStyle}>${sourceHtml}</div>`
      : "";

    const images = (e.payloads ?? [])
      .filter(isImagePayload)
      .map((path) => {
        const dataUri = imageDataUris.get(path);
        if (!dataUri) return "";
        return `<img src="${dataUri}" style="max-width:100%;border-radius:8px;margin-top:6px;" />`;
      })
      .join("\n");

    const files = (e.payloads ?? [])
      .filter((p) => !isImagePayload(p))
      .map((path) => {
        const filename = path.split("/").pop() ?? path;
        return `<div class="file-attachment">${escHtml(filename)}</div>`;
      })
      .join("\n");

    const wrapped = contentHtml ? `<div class="content">${contentHtml}</div>` : "";

    // Interior gaps only. What was dropped before the first selected message or
    // after the last is already stated by the header's "3 of 47" — but a gap
    // *between* two shown messages would otherwise read as adjacency, which is
    // the one thing an excerpt must not imply about a conversation.
    const prev = selectedSeqs && i > 0 ? rendered[i - 1].event : null;
    const skipped = prev ? gapBetween(prev.seq, e.seq) : 0;
    const elision = skipped > 0
      ? `<div class="row elision-row"><div class="elision">⋯ ${skipped} message${skipped === 1 ? "" : "s"} not shown</div></div>\n`
      : "";

    return `${elision}<div class="row ${bubbleClass}-row" id="seq-${e.seq}">
  <div class="bubble ${bubbleClass}"${speakerStyle}>
    ${source}${wrapped}${images}${files}
    <a href="#seq-${e.seq}" class="time">${escHtml(time)}</a>
  </div>
</div>`;
  }).join("\n");

  // KaTeX's stylesheet and the woff2 faces this document actually uses, as one
  // inline block — so the math renders with no network, no CDN, and no script.
  // Null when nothing on the page is math, which is the common case.
  const katexStyle = katexStyleFor(messagesHtml) ?? "";

  const cleanHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)}</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #000; color: #e0e0e0; padding: 16px;
}
/* The narrative card, statically. Type scale, colors, and ordering track
   expo/components/NarrativeMeta.tsx — id 15px/600 mono, everything else 13px
   mono, so the whole block shares one baseline. */
header { padding: 16px 0; border-bottom: 1px solid #2c2c2e; margin-bottom: 16px; }
header .identity { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0; min-width: 0; }
header h1 {
  font-size: 15px; color: #d8d8dd; font-weight: 600;
  font-family: Menlo, monospace;
}
header .fold { margin-left: 8px; font-size: 13px; font-family: Menlo, monospace; color: #5e8a72; }
header .meta-line { margin-top: 4px; font-size: 13px; font-family: Menlo, monospace; }
header .snapshot { margin-right: 8px; }
header .cost { color: #7bb894; }
header .role { color: #d8d8dd; }
header .label { color: #888; }
header .summary { margin-top: 4px; font-size: 13px; color: #999; }
header .exported { margin-top: 8px; font-size: 12px; color: #666; }
.row { display: flex; margin-bottom: 6px; }
.agent-row { justify-content: flex-start; }
.operator-row { justify-content: flex-end; }
.foreign-row { justify-content: center; }
.system-row { justify-content: center; }
.bubble {
  max-width: 85%; border-radius: 16px; padding: 10px 14px;
  word-wrap: break-word; overflow-wrap: break-word;
}
.agent { background: #1c1c1e; border-bottom-left-radius: 4px; }
.operator { background: #1a4a7a; border-bottom-right-radius: 4px; }
.foreign { background: #1a2a1a; border-radius: 12px; }
/* Lifecycle events (spawn/twin/revive/bind rejection) — present but recessive,
   so they read as stage directions rather than as something someone said. */
/* Only the fill and the outline differ from a normal bubble — padding, the
   attribution-header / content / timestamp stack, and the type size are all
   deliberately the same, so a system row reads as a message nobody spoke
   rather than as a different kind of object. */
.system { background: transparent; border: 1px dashed #3a3a3c; border-radius: 12px; }
.system .content { color: #8a8a8e; }
/* The gap marker an excerpt puts between two messages that were not adjacent.
   Centred and unbubbled on purpose: it is the document talking about itself,
   not a row anybody wrote, and it must not be mistakable for one. */
.elision-row { justify-content: center; }
.elision { font-size: 12px; color: #6a6a6e; font-style: italic; padding: 2px 0; }
/* The fold a started line ends with (systemLine in shared/narrative-format),
   in the identity row's green. Its href is a brane:// scheme no browser can
   open, so it is inert here — a label, not a link. */
.system .content a[href^="${FOLD_LINK_SCHEME}"] { color: ${FOLD_COLOR}; text-decoration: none; pointer-events: none; font-family: Menlo, monospace; font-size: 13px; }
/* The daemon isn't a speaker, so its attribution sits in the dim palette
   rather than the green reserved for agents and the operator. */
.source.system-source { color: #8a8a8e; }
.source { color: #4caf50; font-size: 11px; font-family: monospace; margin-bottom: 3px; }
.source a { color: inherit; text-decoration: none; }
/* The foreign speaker's nid leaves the page, so it reads as a link. */
.source a.speaker { text-decoration: underline; }
.content { font-size: 15px; line-height: 1.4; }
.content p { margin: 8px 0; }
.content hr { border: none; height: 1px; background: #444; margin: 12px 0; }
.content h1 { font-size: 26px; line-height: 1.23; font-weight: 700; margin: 16px 0 8px; color: #f0f0f0; }
.content h2 { font-size: 22px; line-height: 1.27; font-weight: 700; margin: 14px 0 6px; color: #f0f0f0; }
.content h3 { font-size: 19px; line-height: 1.32; font-weight: 700; margin: 12px 0 4px; color: #f0f0f0; }
.content h4 { font-size: 17px; line-height: 1.35; font-weight: 600; margin: 10px 0 4px; color: #e8e8e8; }
.content h5 { font-size: 16px; line-height: 1.38; font-weight: 600; margin: 8px 0 2px; color: #e8e8e8; }
.content h6 { font-size: 15px; line-height: 1.4; font-weight: 600; margin: 6px 0 2px; color: #ccc; }
.content code {
  color: #f8c555; background: #1a1a1a; font-family: Menlo, monospace;
  font-size: 13px; padding: 1px 4px; border-radius: 3px;
}
.content pre { background: #1a1a1a; padding: 10px; border-radius: 6px; margin: 4px 0; overflow-x: auto; font-size: 13px; line-height: 1.45; }
.content pre code { padding: 0; background: none; color: inherit; font-family: Menlo, monospace; }
.content pre.shiki { padding: 10px; border-radius: 6px; margin: 4px 0; overflow-x: auto; font-size: 13px; line-height: 1.45; font-family: Menlo, monospace; }
.content pre.shiki code { background: none; padding: 0; color: inherit; font-family: inherit; font-size: inherit; }
/* Display math is the one block that can be wider than the bubble — a long
   equation scrolls rather than forcing the whole page sideways. KaTeX inherits
   the CSS color property, so it picks up the bubble's text color for free.
   The rules themselves are MATH_BLOCK_CSS, shared with the app so the two
   scroll alike, and so an equation dissolves into the same bubble in both. */
${MATH_BLOCK_CSS}
/* A diagram is drawn at its natural size (the SVG carries a fixed width), so a
   wide one scrolls inside the bubble the way a code block does, rather than
   spilling out of it. The app's DiagramView host has the same two rules. */
.content .diagram { overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; margin: 6px 0; max-width: 100%; }
.content .diagram > svg { display: block; }
/* Hover or tap an arrow and it is drawn again on top with its label. The
   rules are DIAGRAM_EDGE_HIGHLIGHT_CSS, shared with the app. */
${DIAGRAM_EDGE_HIGHLIGHT_CSS}
.content a { color: #6cb6ff; text-decoration: underline; }
.content strong { color: #f0f0f0; font-weight: 600; }
.content em { font-style: italic; }
.content table { border-collapse: collapse; margin: 6px 0; width: 100%; font-size: 14px; }
.content th, .content td { border: 1px solid #3a3a3c; padding: 6px 10px; text-align: left; }
.content th { background: #2c2c2e; color: #f0f0f0; font-weight: 600; }
.content tr:nth-child(even) { background: rgba(255,255,255,0.03); }
.content ul, .content ol { margin: 4px 0; padding-left: 24px; }
.content li { margin: 2px 0; }
/* GFM task list items. micromark emits a real disabled checkbox input, which is
   the right markup and the wrong look: a disabled control renders in the
   browser's grey whatever accent-color says, on a page that is otherwise black.
   So appearance:none takes the box back and rebuilds it at the same 13px the
   app draws (expo/components/Markdown.tsx, listCheckbox), and a downloaded
   narrative matches the live one.
   NB: this whole stylesheet is a template literal — no backticks below. */
.content input[type="checkbox"] {
  appearance: none; -webkit-appearance: none;
  width: 13px; height: 13px; margin: 0 6px 0 0; vertical-align: -1px;
  border: 1px solid #8a8a8e; border-radius: 3px; background: transparent;
}
.content input[type="checkbox"]:checked { background: #6cb6ff; border-color: #6cb6ff; }
.content input[type="checkbox"]:checked::after {
  content: "✓"; display: block; text-align: center;
  color: #111; font-size: 10px; line-height: 11px;
}
/* The checkbox stands in for the marker, as it does on GitHub. The item holds
   the input directly when the list is tight and inside its paragraph when the
   list is loose, so both shapes are named. */
.content li:has(> input[type="checkbox"]),
.content li:has(> p:first-child > input[type="checkbox"]:first-child) { list-style: none; }
.time { color: #666; font-size: 11px; margin-top: 4px; text-align: right; text-decoration: none; display: block; }
.file-attachment {
  color: #6cf; font-size: 13px; background: rgba(255,255,255,0.1);
  border-radius: 6px; padding: 6px 10px; margin-top: 6px;
}
footer { padding: 16px 0; border-top: 1px solid #2c2c2e; margin-top: 16px; text-align: center; }
footer .branding { font-size: 12px; color: #555; margin-top: 12px; }
footer .branding a { color: #7fff9f; text-decoration: underline; text-shadow: 0 0 8px rgba(100, 255, 150, 0.6), 0 0 20px rgba(100, 255, 150, 0.3); }
#save-btn {
  position: fixed; top: 12px; right: 12px; z-index: 100;
  background: transparent; border: none; font-size: 28px;
  cursor: pointer; padding: 6px;
  filter: drop-shadow(0 0 8px rgba(100, 180, 255, 0.6)) drop-shadow(0 0 20px rgba(100, 180, 255, 0.3));
  transition: filter 0.2s;
}
#save-btn:hover, #save-btn:active {
  filter: drop-shadow(0 0 12px rgba(100, 180, 255, 0.9)) drop-shadow(0 0 30px rgba(100, 180, 255, 0.5));
}
</style>
${katexStyle}
</head>
<body>
<header>
  <div class="identity"><h1>${escHtml(nid)}</h1>${foldLine}</div>
  ${metaLine}
  ${summaryHtml}
  <div class="exported">Exported ${escHtml(exportDate)} · ${escHtml(countLine)}</div>
</header>
${messagesHtml}
<footer>
  <div class="branding">exported from <a href="https://brane.organelle.dev">brane</a></div>
</footer>
</body>
</html>`;

  if (!opts.interactive) return cleanHtml;

  // Interactive wrapper: add a 💾 button that downloads the clean HTML.
  // The clean version is embedded as base64 so the button is self-contained.
  const cleanBase64 = Buffer.from(cleanHtml, "utf-8").toString("base64");
  return cleanHtml.replace(
    "</header>",
    `<button id="save-btn" onclick="saveHtml()">💾</button>
</header>
<script>
function saveHtml() {
  var raw = atob("${cleanBase64}");
  var bytes = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  var blob = new Blob([new TextDecoder().decode(bytes)], { type: 'text/html' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = ${JSON.stringify(exportFileName(nid, selectedSeqs ? { seqs: exportedMessageSeqs, total: totalMessages } : null))};
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
` + `<` + `/script>`,
  );
}
