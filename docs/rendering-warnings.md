# Rendering Warnings

Every renderer here fails quietly, on purpose. Unparseable LaTeX comes back as its own source rather than KaTeX's red error markup; a `$…$` run that trips the currency guard is escaped into prose; an unclosed fence swallows the rest of the message. That is right for the **reader**, who wants a document and not a diagnostic — and exactly wrong for the **writer**, who otherwise never learns the equation did not set.

`narrate` closes that gap without reopening it for the reader: rendering is unchanged, and the reasoning the renderers were already doing is reported back instead of discarded. `diagnoseMarkdown()` runs on `say`, and the result grows a `warnings` array **only when non-empty** — a narration that renders as written gets the byte-identical receipt it always did.

| kind | fires on | what the operator sees instead |
|---|---|---|
| `math_parse_error` | KaTeX refused the LaTeX | the literal source with its delimiters |
| `math_demoted` | a `$…$` run the guard rejected, whose content is TeX-ish (`\cmd`, `^{`, `_{`) | the source verbatim, dollars and all |
| `math_unclosed` | `\(` or `\[` with no partner, or a `$$` that opens a line and never closes | literal text — or, for `$$`, everything after it as one math block. A mid-sentence `$$` or a `$$$` is literal and stays quiet |
| `fence_unclosed` | a code fence that never closes | everything after it as one code block |

Two properties make the warnings worth acting on:

**It is the real parse, not a lookalike.** The runs come from the same `prepareMathMarkdown` and the same micromark pass the export uses — `mathHtmlExtension(onError)` and `prepareMathMarkdown(md, onIssue)` grew optional collectors rather than gaining a second scanner beside them. So a warning fires *iff* the operator's view differs from intent. A parallel scanner would eventually disagree with the renderer, and a linter that cries wolf is worse than none.

**Every warning carries its `fallback`** — the literal text that will appear. Whether a failure *matters* is a judgment only the author can make and it turns almost entirely on that text: `$E = mc^2$` shown as source still communicates, a `pmatrix` shown as source is line noise. `protocols/markdown.md` tells agents to make exactly that call. `fence_unclosed` is the one that is never benign.

**Advisory by default, refusing only on request.** A warning never blocks a narration. The protocol tells agents to apply the fix *forward* — write the next one better — rather than to correct the last one, because a live loop that pauses to re-render a blemish has traded the thing narration is for.

`strict: true` is the opt-in exception, shaped after `wait: false` on `listen`: the narration is refused rather than posted, the call comes back as a tool error carrying the same diagnostics, and **nothing is written** — which is why `diagnoseMarkdown` runs before the summary update and before payloads are copied into managed storage. A refusal that had already copied files would leave orphans, and the golden rule forbids cleaning them up. Agents are told to reach for it deliberately (a derivation, a table the message builds on), never by habit: every refusal is a round trip the operator waits through.
