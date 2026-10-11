import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diagnoseMarkdown } from "../markdown-diagnostics.js";
import { prepareMathMarkdown, renderMathHtml } from "../shared/markdown-math.js";

// Every renderer here fails silently on purpose — that is what keeps a stray
// `$5` from turning into red error markup in the operator's face. These tests
// pin the other side of that bargain: the author of a narration finds out, and
// finds out precisely enough to decide whether it is worth correcting.

function kinds(md: string): string[] {
  return diagnoseMarkdown(md).map((d) => d.kind);
}

describe("diagnoseMarkdown — silence on anything that renders as written", () => {
  it("says nothing about prose with no math in it", () => {
    assert.deepEqual(kinds("Just a paragraph, with a `code span` and a [link](x)."), []);
  });

  it("says nothing about math that parses", () => {
    assert.deepEqual(kinds("Euler: $e^{i\\pi} + 1 = 0$, and $$\\int_0^1 x\\,dx$$"), []);
  });

  /** The guard rejects far more currency and shell syntax than mathematics, so
   *  warning on every rejection would bury the real findings under noise. */
  it("says nothing about the dollars that were never math", () => {
    for (const md of ["Costs $5 and $10.", "Set $PATH and ${HOME}.", "awk '{print $1, $9}'"]) {
      assert.deepEqual(kinds(md), [], md);
    }
  });

  it("says nothing about a closed fence, of either flavour", () => {
    assert.deepEqual(kinds("```js\nconst x = 1;\n```\n"), []);
    assert.deepEqual(kinds("~~~\nplain\n~~~"), []);
    assert.deepEqual(kinds("```js\nconst x = 1;\n```"), []);
  });
});

describe("diagnoseMarkdown — what it reports", () => {
  it("reports LaTeX KaTeX refused, in KaTeX's own words", () => {
    const [d] = diagnoseMarkdown("Broken: $\\bogusmacro{x}$ here");
    assert.equal(d.kind, "math_parse_error");
    assert.match(d.message, /Undefined control sequence/);
    // KaTeX's prefix and its combining-underline position marker are stripped:
    // one reads as boilerplate, the other as mojibake outside a browser.
    assert.ok(!d.message.startsWith("KaTeX parse error"), d.message);
    assert.ok(!/̲/.test(d.message), "no combining underline");
  });

  it("reports a run that looks like math but was demoted, and why", () => {
    const [d] = diagnoseMarkdown("Spaced: $ \\theta $ there");
    assert.equal(d.kind, "math_demoted");
    assert.match(d.message, /a space sits just inside the delimiters/);
  });

  it("reports TeX delimiters with no partner", () => {
    assert.deepEqual(kinds("Unclosed: \\(x + y and the sentence goes on"), ["math_unclosed"]);
    assert.deepEqual(kinds("Runaway:\n$$ x + y and no closer"), ["math_unclosed"]);
  });

  it("reports an unclosed fence, whose damage is not local", () => {
    const [d] = diagnoseMarkdown("```js\nconst x = 1;\nand the rest of the message");
    assert.equal(d.kind, "fence_unclosed");
    assert.match(d.message, /everything after it renders as one code block/);
  });

  it("stays quiet on `$$` that cannot swallow anything", () => {
    // Found by sweeping the corpus: a price tier, and a mid-sentence pair.
    assert.deepEqual(kinds("- **$$$**: battery emulators, only if serious.\n\nStill prose."), []);
    assert.deepEqual(kinds("costs $$ unless volume)\n\nnext para"), []);
    // ...but at a line start it is a flow fence, list marker or not.
    assert.deepEqual(kinds("- $$ x = 1 and\n\nnext para"), ["math_unclosed"]);
  });

  it("does not let a stray backtick run in prose hide a real fence", () => {
    const md = "The file has its own ```lua block.\n\n````md\n# doc\n\n```lua\nx\n```\n\nend\n````\n\nafter";
    assert.deepEqual(kinds(md), []);
  });

  it("points at the failed run, not an earlier listing of the same LaTeX", () => {
    const [d] = diagnoseMarkdown("```latex\n\\frac{a}{b}\n```\n\nbroken: $\\frac{a}{$ here");
    assert.equal(d.kind, "math_parse_error");
    assert.equal(d.line, 5);
  });

  it("points at the line, so a long narration can be found in", () => {
    const [d] = diagnoseMarkdown("one\ntwo\n\nthree $ \\theta $ four\n");
    assert.equal(d.line, 4);
  });

  it("caps what one narration can produce", () => {
    const md = Array.from({ length: 30 }, () => "$ \\theta $").join("\n\n");
    assert.ok(diagnoseMarkdown(md).length <= 10);
  });
});

/** The warning is only worth acting on if it describes the operator's actual
 *  view. Both halves of that come from the real pipeline rather than a second
 *  scanner written to approximate it — this is the test that they agree. */
describe("diagnoseMarkdown — the fallback is what will really be shown", () => {
  it("hands back the literal source a failed render falls back to", () => {
    const [d] = diagnoseMarkdown("Broken: $\\bogusmacro{x}$ here");
    assert.equal(d.fallback, "$\\bogusmacro{x}$");
    // …which is exactly what the renderer emits for it, HTML-escaped.
    assert.equal(renderMathHtml("\\bogusmacro{x}", false), "$\\bogusmacro{x}$");
  });

  it("hands back the demoted run as the prose it becomes", () => {
    const [d] = diagnoseMarkdown("Spaced: $ \\theta $ there");
    assert.equal(d.fallback, "$ \\theta $");
    // The opener is escaped, and `\$` renders as a plain `$`.
    assert.ok(prepareMathMarkdown("Spaced: $ \\theta $ there").includes("\\$ \\theta"));
  });
});

/** Collecting must not change what anyone sees. The export and the app call
 *  these same two functions, and a diagnostic pass that perturbed either would
 *  be a rendering bug wearing a linter's clothes. */
describe("collecting is free of side effects", () => {
  it("leaves prepareMathMarkdown's output identical with and without a collector", () => {
    const sources = [
      "Costs $5 and $10.",
      "Euler: $e^{i\\pi}+1=0$",
      "\\[B = m\\ddot U\\]",
      "```js\nunclosed",
      "$$ runaway",
      "Spaced: $ \\theta $",
    ];
    for (const md of sources) {
      assert.equal(prepareMathMarkdown(md, () => {}), prepareMathMarkdown(md), md);
    }
  });

  it("leaves renderMathHtml's output identical with and without an onError", () => {
    for (const [value, display] of [["x^2", false], ["\\bogusmacro{", false], ["\\int_0^1", true]] as const) {
      assert.equal(renderMathHtml(value, display, () => {}), renderMathHtml(value, display));
    }
  });
});
