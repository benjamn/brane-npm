/** Mention linkification — `@claude-4c7289d1`.
 *
 *  A mention *addresses* a narrative; a bare `claude-4c7289d1` merely *cites*
 *  one (`markdown-nids.ts`). The `@` is the whole difference, and it has to be,
 *  because narratives quote each other's ids constantly: if a bare id notified,
 *  every design discussion would page half the brane.
 *
 *  This file holds only the spec. The tree walk lives in `markdown-refs.ts`,
 *  and the *daemon-side* walk that turns a narration into ledger rows lives in
 *  `../mentions-scan.ts` — deliberately not here, because metro resolves a
 *  shared module's imports from its own directory and this one must stay free
 *  of bare npm imports (see `docs/math.md` on the `katex` alias).
 *
 *  One spec, two consumers. The renderer and the scanner agree by construction:
 *  a handle in a fenced block is inert in both, and there is no second pattern
 *  that could drift out of step with what the operator actually sees.
 */

import { NID_REF_PATTERN, braneNidUrl } from "./markdown-nids.js";
import { refLinks, type RefSpec } from "./markdown-refs.js";

/** `@` plus a narrative reference — the `:seq` suffix included, because the
 *  common way to write one is to type `@` and paste a citation, and citations
 *  carry their seq. Matching only the id would link `@claude-4c7289d1` and
 *  leave a bare `:42` stranded beside it. The seq says *where to look*; the
 *  mention is recorded against the id alone. */
export const MENTION_PATTERN = `@${NID_REF_PATTERN}`;

/** Vetoes a candidate by the character before the `@`.
 *
 *  A mention has to start a word. Without this, `ben@claude-4c7289d1` is a
 *  mention — and so is the tail of any path or handle that happens to end in
 *  one. GFM's autolink extension already claims `@` for e-mail, but only when
 *  the domain has a dot, so `ben@claude-4c7289d1` reaches us as plain text and
 *  this is the only thing standing in front of it.
 *
 *  `before` is `""` at the start of a text node, which is a legal position.
 */
export function mentionBoundary(before: string): boolean {
  return before === "" || !/[\w./@-]/.test(before);
}

/** Resolves a mentioned reference to an href, or null to leave it as prose. */
export type MentionHrefResolver = (nid: string, seq?: string) => string | null;

function mentionSpec(hrefFor: MentionHrefResolver): RefSpec {
  return {
    pattern: MENTION_PATTERN,
    boundary: (before) => mentionBoundary(before),
    resolve: (match: RegExpExecArray) => {
      const href = hrefFor(match[1], match[2]);
      // `text` keeps the `@`, so the label reads as an address rather than a
      // citation without needing a second href scheme to tell them apart.
      return href === null ? null : { text: match[0], href };
    },
  };
}

/** `mentionSpec` packaged as an mdast-util-from-markdown extension.
 *
 *  **Install this before `narrativeIdLinks`.** Each extension's links are
 *  opaque to the next, so if the citation spec runs first it consumes the nid
 *  and leaves the `@` stranded — which is exactly what brane did before
 *  mentions existed, and why `nidSpec` now carries a matching boundary. */
export function mentionLinks(
  knownIds: Set<string>,
  hrefFor: (nid: string, seq?: string) => string = braneNidUrl,
): { transforms: Array<(tree: any) => void> } {
  if (knownIds.size === 0) return { transforms: [] };
  return refLinks(mentionSpec((nid, seq) => (knownIds.has(nid) ? hrefFor(nid, seq) : null)));
}

/** The same spec, wired to collect rather than to link.
 *
 *  `resolve` always returns null, so the tree is never rewritten — but it is
 *  still *called*, including from the code-span path, so what this collects is
 *  precisely what `mentionLinks` would have linked. That equivalence is the
 *  point: the scanner is the renderer with its output thrown away. */
export function collectMentionSpec(isKnown: (nid: string) => boolean, into: Set<string>): RefSpec {
  return {
    pattern: MENTION_PATTERN,
    boundary: (before) => mentionBoundary(before),
    resolve: (match: RegExpExecArray) => {
      if (isKnown(match[1])) into.add(match[1]);
      return null;
    },
  };
}
