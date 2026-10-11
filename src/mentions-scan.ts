/** Extracting mentions from markdown, daemon-side.
 *
 *  This is the renderer with its output thrown away. It parses with the same
 *  two extensions the app installs (`expo/components/Markdown.tsx`) and walks
 *  the tree with the same spec (`shared/markdown-mentions.ts`), so a handle
 *  fires a notification *iff* the operator would have seen it as a link.
 *
 *  The alternative — a regex over the raw `content` — is the parallel scanner
 *  `docs/rendering-warnings.md` forbids for exactly this reason. Its failure is silent and
 *  unexplainable: a pasted log containing `@claude-4c7289d1` inside a fenced
 *  block shows as inert code in the UI while waking an agent, with nothing
 *  visible to say why.
 *
 *  Lives here rather than in `shared/` because it imports `mdast-util-*`, and
 *  metro resolves a shared module's dependencies from its own directory — see
 *  `docs/math.md` on the `katex` alias. The daemon is the only caller.
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";
import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import { linkifyRefs } from "./shared/markdown-refs.js";
import { collectMentionSpec } from "./shared/markdown-mentions.js";

/** The narrative ids mentioned in `md`, in first-appearance order.
 *
 *  `isKnown` is what keeps a handle that names no narrative inert — the same
 *  refusal `narrativeIdLinks` makes, so invented ids never become ledger rows.
 *  Repeats collapse: the set is the dedup within one event, the table's UNIQUE
 *  constraint is the dedup across re-scans. */
export function extractMentions(md: string, isKnown: (nid: string) => boolean): string[] {
  if (!md.includes("@")) return [];
  const found = new Set<string>();
  const tree = fromMarkdown(md, {
    extensions: [gfmAutolinkLiteral()],
    mdastExtensions: [gfmAutolinkLiteralFromMarkdown()],
  });
  linkifyRefs(tree, collectMentionSpec(isKnown, found));
  return [...found];
}
