import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { micromark } from "micromark";
import { math } from "../math-syntax.js";
import { MATH_BLOCK_CSS, prepareMathMarkdown, isMathContent, renderMathHtml } from "../shared/markdown-math.js";
import { mathHtmlExtension, katexStyleFor } from "../math.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

// Rendering LaTeX is the easy half. The hard half is deciding which dollars are
// delimiters — narratives are full of prices, shell variables and awk fields —
// and making the app and the HTML export agree about it, since they render the
// same markdown through the same functions and any disagreement shows up as an
// export that no longer matches what the operator saw.

function render(md: string): string {
  return micromark(prepareMathMarkdown(md), {
    extensions: [math()],
    htmlExtensions: [mathHtmlExtension()],
  });
}

/** "display" | "inline" | "none" — how a source's math came out. */
function mode(md: string): string {
  const html = render(md);
  if (!html.includes("katex")) return "none";
  return html.includes("math-display") ? "display" : "inline";
}

describe("dollar-sign guard", () => {
  it("renders real inline math", () => {
    for (const md of ["$B = Tc^2$", "$\\Lambda$", "$g_{\\mu\\nu}$", "$R$", "$\\sqrt{-g}$"]) {
      assert.equal(mode(md), "inline", md);
    }
  });

  it("leaves currency alone — including the range that Pandoc's digit rule catches", () => {
    // `$10k–$500k` is the motivating case: a naive parser reads "10k–" as math.
    for (const md of ["Between $10k and $500k.", "It costs $5 and $10 more.", "$3/M in, $15/M out"]) {
      assert.equal(mode(md), "none", md);
    }
  });

  it("leaves shell and awk alone even outside a code span", () => {
    for (const md of ["${curcontext%:*:*}:organelle-command-$state", "awk '{print $1, $9}' and $2"]) {
      assert.equal(mode(md), "none", md);
    }
  });

  it("ends a code span at its paragraph, so a stray backtick run guards nothing past it", () => {
    const html = render("mentions ```lua in prose.\n\nDinner was $5 and $10.\n");
    assert.doesNotMatch(html, /class="math/);
    assert.match(html, /\$5 and \$10/);
  });

  it("keeps the real math in a line that also has prices", () => {
    // Escaping only the *opening* delimiter is what makes this work: the closer
    // of a rejected run gets its own hearing as the next candidate's opener.
    const html = render("$5 and $10 and $x$ here");
    assert.equal((html.match(/class="katex"/g) ?? []).length, 1);
    assert.ok(html.includes("$5 and $10 and"), "the prices survive as prose");
  });

  it("never escapes inside code, where a backslash would be literal", () => {
    for (const md of ["Use `$HOME` and `$PATH` here.", "```sh\necho $HOME $PATH\n```", "    echo $HOME"]) {
      assert.ok(!prepareMathMarkdown(md).includes("\\$"), md);
      assert.equal(mode(md), "none", md);
    }
  });

  it("respects a dollar the author already escaped", () => {
    assert.equal(prepareMathMarkdown("Costs \\$5 and \\$10."), "Costs \\$5 and \\$10.");
  });

  it("scores the individual rules", () => {
    assert.equal(isMathContent("x + y", ""), true);
    assert.equal(isMathContent("", ""), false, "empty");
    assert.equal(isMathContent(" x", ""), false, "leading space");
    assert.equal(isMathContent("x ", ""), false, "trailing space");
    assert.equal(isMathContent("10k–", "5"), false, "digit after the closer");
    assert.equal(isMathContent("{nid}", ""), false, "shell expansion");
    assert.equal(isMathContent('line[1] \\"', ""), false, "raw double quote");
  });
});

describe("display math", () => {
  it("promotes a one-line $$…$$ paragraph to a display block", () => {
    // The form agents actually write. micromark-extension-math only knows `$$`
    // as a fence, so without the promotion this renders inline.
    assert.equal(mode("$$B = m\\ddot U$$"), "display");
    assert.equal(mode("Swap it:\n\n$$B = m\\ddot U = m = T.$$\n\nDone."), "display");
  });

  it("still accepts the fenced form", () => {
    assert.equal(mode("$$\nB = Tc^2\n$$"), "display");
  });

  it("leaves $$…$$ inline when it shares its line with prose", () => {
    assert.equal(mode("the value $$x$$ inline"), "inline");
  });
});

describe("TeX delimiters", () => {
  // `\(…\)` and `\[…\]` are the OpenAI house style, and they dominate any
  // absorbed archive — 1576 and 351 occurrences against 578 single-dollar runs
  // in the corpus this was built against. Markdown would eat both halves as
  // escaped brackets and leave the LaTeX sitting in the prose.
  it("renders \\(…\\) as inline math", () => {
    assert.equal(mode("The claim \\(B = Tc^2\\) holds."), "inline");
  });

  it("renders \\[…\\] alone on a line as display math", () => {
    assert.equal(mode("Swap it:\n\n\\[B = m\\ddot U\\]\n\nDone."), "display");
    assert.equal(mode("\\[\n\\dot\\sigma = -A(t)\\sigma\n\\]"), "display");
  });

  it("keeps \\[…\\] inline when it shares its line with prose", () => {
    assert.equal(mode("the value \\[x^2\\] inline"), "inline");
  });

  it("leaves TeX delimiters inside code alone", () => {
    assert.equal(mode("Write `\\(x\\)` for inline."), "none");
    assert.equal(mode("```\n\\(x\\)\n```"), "none");
  });

  it("ignores an unmatched opener", () => {
    assert.equal(mode("An open \\( with no close."), "none");
  });

  it("renders a ```math fence as display math, but leaves ```latex as source", () => {
    // GitHub's convention: ```math is an equation, ```latex is a listing.
    assert.equal(mode("```math\nB = m\\ddot U\n```"), "display");
    assert.equal(mode("```latex\n\\frac{a}{b}\n```"), "none");
  });

  it("normalizes to the dollar forms, so one syntax reaches both renderers", () => {
    assert.equal(prepareMathMarkdown("The claim \\(B = Tc^2\\) holds."), "The claim $B = Tc^2$ holds.");
    assert.equal(prepareMathMarkdown("\\[B = m\\ddot U\\]"), "$$\nB = m\\ddot U\n$$");
  });
});

describe("math nested inside other blocks", () => {
  // Every one of these came from a real absorbed conversation, and every one of
  // them lost equations before it was fixed. The failure mode is always the
  // same: a rewrite that is correct in isolation and blind to the block it sits
  // in. They are worth pinning because none of them errors — the equation just
  // stops being there.

  it("keeps a blockquoted display equation", () => {
    // `$$` swallows the rest of its line as an info string, so emitting the
    // fence without the `> ` fed the equation into it and micromark dropped it.
    const md = "> \\[\n> \\mathbb{E}\\,T = O(n)\n> \\]";
    assert.equal(mode(md), "display");
    assert.ok(render(md).includes("O(n)"), "the equation survives");
  });

  it("keeps a display equation indented inside a list item", () => {
    // Opening the fence at the item's indent and closing it at column 0 ends
    // the list and leaves the fence hanging.
    const md = "3. **Form**: written as:\n\n   \\[ i\\hbar \\partial_t \\Psi = \\hat{H}\\Psi \\]\n\n   Here.";
    const html = render(md);
    assert.ok(html.includes("math-display"), "renders as display");
    assert.ok(html.includes("hbar"), "the equation survives");
  });

  it("renders math in a deeply indented list item", () => {
    // Four spaces of list indent are indent, not an indented code block.
    assert.equal(mode("   - outer\n     - inner \\( A \\to A\\alpha \\) here"), "inline");
  });

  it("tolerates the padding spaces TeX delimiters usually carry", () => {
    // `\( i \)` is idiomatic; `$ i $` is what the dollar guard throws out.
    assert.equal(prepareMathMarkdown("Here, \\( i \\) is the unit."), "Here, $i$ is the unit.");
  });

  it("leaves a whole indented code block alone, not just its first line", () => {
    // Only the first line of an indented block follows a blank one, so a
    // per-line test lets every later line back in — which is how ASCII art
    // drawn in dollar signs got backslashes inserted through it.
    const md = "Art:\n\n    ooo$$$$ooo\n    oo$$$$$$oo\n    o$$ $$ $$o\n";
    assert.equal(prepareMathMarkdown(md), md);
  });
});

describe("renderMathHtml", () => {
  it("emits MathML alongside the visible layout, for screen readers", () => {
    const html = renderMathHtml("x^2", false);
    assert.ok(html.includes("katex-mathml"));
    assert.ok(html.includes("<math"));
  });

  it("falls back to the literal source rather than KaTeX's error markup", () => {
    const html = renderMathHtml("\\bogusmacro{", false);
    assert.ok(!html.includes("katex"), "no half-rendered error node");
    assert.equal(html, "$\\bogusmacro{$");
  });

  it("escapes the fallback, since it lands in an HTML document", () => {
    // `<script>` on its own is perfectly good LaTeX — two relations around a
    // word — so reaching the fallback needs input KaTeX also can't parse.
    assert.equal(renderMathHtml("<script>\\nosuchmacro", false), "$&lt;script&gt;\\nosuchmacro$");
  });

  it("reads a markdown-escaped asterisk as an asterisk", () => {
    // `\*` isn't TeX; it's a model escaping `*` so markdown won't read emphasis,
    // then leaving the escape inside the math. Half the unparseable equations in
    // the absorbed archive are this.
    const html = renderMathHtml("t^\\*", false);
    assert.ok(html.includes("katex"), "renders rather than falling back");
  });

  it("escapes markup on the success path too, which is KaTeX's job", () => {
    const html = renderMathHtml("<script>", false);
    assert.ok(html.includes("katex"), "this one really does render");
    assert.ok(!html.includes("<script>"), "no raw tag reaches the document");
  });
});

describe("katexStyleFor", () => {
  it("returns null for a document with no math, so it costs nothing", () => {
    assert.equal(katexStyleFor("<p>no math here</p>"), null);
  });

  it("inlines every font it keeps, and reaches for no network", () => {
    const style = katexStyleFor(render("$$\\frac{d^2U}{dt^2} = \\sqrt{-g}$$"))!;
    assert.ok(style, "math document gets a stylesheet");
    assert.equal(
      (style.match(/url\((?!data:)/g) ?? []).length,
      0,
      "no url() survives that isn't a data: URI",
    );
    assert.ok(style.includes("data:font/woff2;base64,"));
  });

  it("carries only the families the document reaches for", () => {
    const style = katexStyleFor(render("$x$"))!;
    const faces = (style.match(/@font-face/g) ?? []).length;
    assert.ok(faces > 0, "at least the base family");
    assert.ok(faces < 20, `subset, not all twenty faces (got ${faces})`);
    // Fraktur is only reachable via \mathfrak, which this document never uses.
    assert.ok(!style.includes("KaTeX_Fraktur-Regular.woff2"));
  });
});

/** What a display block does when the equation is wider than the bubble.
 *
 *  KaTeX won't wrap display math and TeX has no line-breaking for it, so the
 *  only honest answer is a scroller. Getting one is less obvious than setting
 *  `overflow-x`, and the failure mode when it's wrong is the dangerous kind:
 *  the equation is trimmed at both ends and still looks whole.
 */
describe("MATH_BLOCK_CSS — wide equations scroll rather than truncate", () => {
  const katexCss = readFileSync(
    join(dirname(createRequire(import.meta.url).resolve("katex/package.json")), "dist", "katex.min.css"),
    "utf8",
  );

  it("sizes the inner block to its content, which is what gives it somewhere to scroll", () => {
    // Without this the block is exactly the container's width and its content
    // overflows *centered* — spilling both ways, with the left spill outside
    // scrollWidth and therefore unreachable.
    assert.match(
      MATH_BLOCK_CSS,
      /\.math-display\s*>\s*\.katex-display\s*>\s*\.katex\s*\{[^}]*min-width:\s*max-content/,
    );
  });

  it("outranks the KaTeX rule it is correcting", () => {
    // Three classes to KaTeX's two, so it wins on specificity no matter which
    // stylesheet the document loads last — the app appends ours, the export
    // emits KaTeX's after it.
    assert.match(katexCss, /\.katex-display>\.katex\{[^}]*white-space:nowrap/, "the rule being corrected still exists");
    const ours = (MATH_BLOCK_CSS.match(/\.math-display\s*>\s*\.katex-display\s*>\s*\.katex/) ?? [])[0]!;
    assert.ok(ours, "our override is present");
    assert.equal((ours.match(/\./g) ?? []).length, 3);
  });

  it("fades the equation itself, rather than washing anything over it", () => {
    // A mask makes the block's own paint transparent, so a faded edge shows
    // the bubble it sits on — which is why nothing here needs to be told what
    // color that bubble is.
    const block = MATH_BLOCK_CSS.match(/\.math-display\s*\{[^}]*\}/)![0];
    assert.match(block, /mask-image:\s*linear-gradient/);
    assert.ok(!/--math-bg/.test(MATH_BLOCK_CSS), "no background color to be told about");
  });

  it("fades an edge only while there is something past it", () => {
    // The fade widths ride a scroll timeline over the block itself, which is
    // how a stylesheet gets to know something it would otherwise have to
    // measure: no scrollable overflow means an inactive timeline, so the
    // registered initial widths stand and neither edge fades. The ranges put
    // one animation at each end of the travel, so the far edge is crisp once
    // you have actually reached it.
    const block = MATH_BLOCK_CSS.match(/\.math-display\s*\{[^}]*\}/)![0];
    assert.match(block, /animation-timeline:\s*scroll\(self x\), scroll\(self x\)/);
    assert.match(block, /animation-range:\s*0 32px, calc\(100% - 32px\) 100%/);
    for (const prop of ["--math-fade-start", "--math-fade-end"]) {
      assert.match(
        MATH_BLOCK_CSS,
        new RegExp(`@property ${prop} \\{[^}]*initial-value: 0px`),
        `${prop} rests at no fade`,
      );
    }
    // The end-side animation runs backwards — full fade until you arrive.
    assert.match(MATH_BLOCK_CSS, /@keyframes brane-math-fade-end \{ from \{ --math-fade-end: 28px; \} to \{ --math-fade-end: 0px; \} \}/);
  });
});
