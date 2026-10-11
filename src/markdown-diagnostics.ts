/** What a narration is about to look like, told to the agent writing it.
 *
 *  Every renderer in this codebase fails *quietly* by design: unparseable
 *  LaTeX comes back as its own source rather than as KaTeX's red error markup
 *  (`renderMathHtml`), a `$…$` run that trips the currency guard is escaped
 *  into prose (`prepareMathMarkdown`), an unclosed fence simply swallows the
 *  rest of the message. That is the right behaviour for the *reader*, who
 *  wants a document rather than a diagnostic — and exactly wrong for the
 *  *writer*, who never finds out that the equation they wrote did not set.
 *
 *  This module closes that gap without reopening it for the reader: the
 *  rendering is unchanged, and the reasoning the renderers were already doing
 *  is reported back through `narrate` instead of being discarded.
 *
 *  Two properties make the report trustworthy enough to act on:
 *
 *  **It is the real parse, not a lookalike.** The math run is found by the
 *  same `prepareMathMarkdown` and rendered by the same micromark pass the
 *  export uses, so a warning fires if and only if the operator's view differs
 *  from what was intended. A second scanner written to approximate the first
 *  would eventually disagree with it, and a linter that cries wolf is worse
 *  than no linter.
 *
 *  **Every warning carries its fallback** — the literal text that will appear
 *  in place of the intended rendering. Whether a failure *matters* is a
 *  judgment only the author can make, and it turns almost entirely on that
 *  text: `$E = mc^2$` shown as source still communicates; a matrix shown as
 *  source is line noise. Reporting the parser's complaint without the fallback
 *  would leave that call unmakeable.
 */

import { micromark } from "micromark";
import { gfmTable, gfmTableHtml } from "micromark-extension-gfm-table";
import { gfmAutolinkLiteral, gfmAutolinkLiteralHtml } from "micromark-extension-gfm-autolink-literal";
import { gfmTaskListItem, gfmTaskListItemHtml } from "micromark-extension-gfm-task-list-item";
import { math } from "micromark-extension-math";
import { mathHtmlExtension } from "./math.js";
import { fromMarkdown } from "mdast-util-from-markdown";
import { inspectDiagram } from "./diagram/index.js";
import {
  mathContentRejection,
  prepareMathMarkdown,
  type MathSourceIssue,
} from "./shared/markdown-math.js";

export interface MarkdownDiagnostic {
  kind:
    | "math_parse_error"
    | "math_demoted"
    | "math_unclosed"
    | "fence_unclosed"
    | "diagram_unsupported"
    | "diagram_parse_error"
    | "diagram_label_literal";
  /** What went wrong, phrased for whoever wrote the markdown. */
  message: string;
  /** What the operator will see instead — the basis for deciding if it matters. */
  fallback: string;
  /** 1-based line in the source, where the source is what pins it down. */
  line?: number;
}

/** Does this rejected `$…$` run look like a failed equation rather than prose?
 *
 *  The guard in `mathContentRejection` throws out far more currency and shell
 *  syntax than it does mathematics, and warning on every one of those would
 *  bury the real findings. A backslash command or a sub/superscript that opens
 *  a group is the signal that someone was writing TeX: `$\\theta$`, `$x_{i+1}$`.
 *  Bare `$PATH` and `$5 to $10` stay silent, which is the whole point.
 */
const TEX_ISH = /\\[a-zA-Z]|[\^_]\s*[{(]/;

/** Cheap enough to run on every narration: a source with no math token at all
 *  never reaches micromark, and the scan that finds fence and delimiter
 *  problems is the same single pass `prepareMathMarkdown` already makes. */
const HAS_MATH_TOKEN = /(?:^|[^\\])\$/;

/** How many warnings one narration can produce. A message that trips more than
 *  this is broken in a way the first few already explain. */
const MAX_DIAGNOSTICS = 10;

export function diagnoseMarkdown(md: string): MarkdownDiagnostic[] {
  const out: MarkdownDiagnostic[] = [];
  const issues: MathSourceIssue[] = [];
  const prepared = prepareMathMarkdown(md, (issue) => issues.push(issue));

  for (const issue of issues) {
    const line = lineOf(md, issue.index);
    switch (issue.kind) {
      case "dollar_escaped": {
        const reason = mathContentRejection(issue.content, issue.after);
        if (!reason || !TEX_ISH.test(issue.content)) break;
        out.push({
          kind: "math_demoted",
          message: `\`$${clamp(issue.content, 60)}$\` looks like math, but ${reason} — so it is not treated as math and renders as literal text.`,
          fallback: `$${clamp(issue.content, 120)}$`,
          line,
        });
        break;
      }
      case "tex_unmatched":
        out.push({
          kind: "math_unclosed",
          message: `${capitalize(issue.reason)} — the LaTeX renders as literal text.`,
          fallback: excerptAt(md, issue.index),
          line,
        });
        break;
      case "display_unclosed":
        out.push({
          kind: "math_unclosed",
          message: "`$$` is never closed — everything after it is swallowed into one display-math block.",
          fallback: excerptAt(md, issue.index),
          line,
        });
        break;
      case "fence_unclosed":
        out.push({
          kind: "fence_unclosed",
          message: "A code fence is never closed — everything after it renders as one code block.",
          fallback: excerptAt(md, issue.index),
          line,
        });
        break;
    }
  }

  if (HAS_MATH_TOKEN.test(prepared)) {
    // Rendered and thrown away: the HTML is the export's business, and all we
    // want from this pass is which runs KaTeX refused.
    micromark(prepared, {
      extensions: [gfmTable(), gfmAutolinkLiteral(), gfmTaskListItem(), math()],
      htmlExtensions: [
        gfmTableHtml(),
        gfmAutolinkLiteralHtml(),
        gfmTaskListItemHtml(),
        mathHtmlExtension((message, fallback) => {
          out.push({
            kind: "math_parse_error",
            message,
            fallback: clamp(fallback, 160),
            // Best-effort: the LaTeX reaching KaTeX has been normalized, so it
            // is not always findable in the source the author typed. A line
            // that might be wrong would be worse than none, so it is omitted
            // rather than guessed.
            line: lineOfValue(md, fallback),
          });
        }),
      ],
    });
  }

  for (const d of diagnoseDiagramFences(md)) out.push(d);

  return out.slice(0, MAX_DIAGNOSTICS);
}

/** ```mermaid fences that will not draw.
 *
 *  Same contract as the math warnings: it is the *real* decision, taken by the
 *  same `diagnoseDiagram` the renderers call, so a warning fires iff the
 *  operator sees source where a diagram was meant.
 *
 *  Which is why the fences come from **a markdown parse and not a regex**. The
 *  first draft scanned for the fence with a pattern, three lines under a
 *  comment forbidding exactly that, and it disagreed with the renderers in
 *  both directions inside a week: a mermaid fence quoted *inside* a longer
 *  ```` fence — which is how an agent documents this feature — warned about a
 *  diagram that was never going to draw, while a fence inside a blockquote
 *  renders and was never diagnosed. `fromMarkdown` sees what micromark sees,
 *  because it is micromark.
 *
 *  `fallback` is the source, because that is literally what appears — the
 *  highlighted code block a mermaid fence renders as today. Judging whether it
 *  matters is the author's call and turns on reading it: a four-line flowchart
 *  shown as source still communicates; a thirty-line one does not.
 */
function diagnoseDiagramFences(md: string): MarkdownDiagnostic[] {
  const out: MarkdownDiagnostic[] = [];
  // Cheap gate so an ordinary narration never pays for a parse. Deliberately
  // just the word: anything narrower has to model where a fence may start, and
  // a `>`-prefixed one inside a blockquote is exactly what the first attempt
  // at that missed — which is the bug this function was being rewritten for.
  if (!/mermaid/i.test(md)) return out;

  let tree: { children?: unknown[] };
  try {
    tree = fromMarkdown(md);
  } catch {
    return out;
  }

  const walk = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (node.type === "code" && typeof node.lang === "string" &&
        node.lang.toLowerCase() === "mermaid") {
      const body = typeof node.value === "string" ? node.value : "";
      if (body.trim()) {
        const { refusal, literal } = inspectDiagram(body);
        // mdast gives the fence's own line; the body starts on the next one.
        const bodyLine = (node.position?.start?.line ?? 0) + 1;
        // The diagram draws, but some label shows its markup as text. The
        // fallback is the statement's source line, since that is where the
        // characters the operator sees come from.
        const bodyLines = body.split("\n");
        for (const note of literal) {
          out.push({
            kind: "diagram_label_literal",
            message: `In this \`mermaid\` diagram, ${note.message}.`,
            fallback: clamp((bodyLines[note.line - 1] ?? "").trim(), 160),
            line: bodyLine + note.line - 1,
          });
        }
        if (refusal) {
          out.push({
            kind: refusal.kind === "unsupported" ? "diagram_unsupported" : "diagram_parse_error",
            message: `This \`mermaid\` diagram will not draw: ${refusal.message}. It renders as its own source.`,
            fallback: clamp(body.trim(), 280),
            line: refusal.line === undefined ? bodyLine : bodyLine + refusal.line - 1,
          });
        }
      }
      return;
    }
    for (const child of (node.children ?? [])) walk(child);
  };
  walk(tree);
  return out;
}

/** The line a failed run sits on, found by its own source, or undefined. */
function lineOfValue(md: string, fallback: string): number | undefined {
  // Delimiters and all first: the same LaTeX may appear earlier as a code
  // listing, and a listing is not the run that failed.
  let at = md.indexOf(fallback);
  if (at === -1) {
    const value = fallback.replace(/^\$\$?|\$\$?$/g, "");
    at = value ? md.indexOf(value) : -1;
  }
  return at === -1 ? undefined : lineOf(md, at);
}

function lineOf(md: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < md.length; i++) if (md[i] === "\n") line++;
  return line;
}

/** The rest of the line starting at `index`, capped — enough to recognize the
 *  spot without pasting a paragraph back at the author. */
function excerptAt(md: string, index: number, max = 80): string {
  const end = md.indexOf("\n", index);
  return clamp(md.slice(index, end === -1 ? md.length : end), max);
}

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
