/** Narrative-reference linkification, shared by the live app (expo) and the
 *  HTML exporter so both linkify exactly the same things.
 *
 *  A narrative reference is `{type}-{8hex}`, optionally suffixed with `:seq`
 *  (`claude-4c7289d1`, `claude-4c7289d1:42`). Only references to narratives
 *  that actually exist are linked, so arbitrary strings of the same shape
 *  don't become dead links.
 *
 *  The tree walk itself lives in `markdown-refs.ts`; what's here is the
 *  narrative-id spec it runs.
 */

import { linkifyRefs, refLinks } from "./markdown-refs.js";

export const NID_PATTERN = "[a-z]+-[0-9a-z]{8}";
export const NID_REF_PATTERN = `(${NID_PATTERN})(?::(\\d+))?`;

export function braneNidUrl(nid: string, seq?: string): string {
  return seq ? `brane://nid/${nid}/${seq}` : `brane://nid/${nid}`;
}

/** Resolves a reference to the href the surrounding document should use.
 *  Returning null declines to link. */
export type NidHrefResolver = (nid: string, seq?: string) => string | null;

function nidSpec(hrefFor: NidHrefResolver) {
  return {
    pattern: NID_REF_PATTERN,
    // A citation stops where a mention begins (`markdown-mentions.ts`). Without
    // this veto the citation spec consumes the id and leaves the `@` stranded
    // beside a link, so a mention could never render as one.
    boundary: (before: string) => before !== "@",
    resolve: (match: RegExpExecArray) => {
      const href = hrefFor(match[1], match[2]);
      return href === null ? null : { text: match[0], href };
    },
  };
}

/** Rewrites narrative references into links, in place. */
export function linkifyNarrativeIds(tree: any, hrefFor: NidHrefResolver): void {
  linkifyRefs(tree, nidSpec(hrefFor));
}

/** `linkifyNarrativeIds` packaged as an mdast-util-from-markdown extension. */
export function narrativeIdLinks(
  knownIds: Set<string>,
  hrefFor: NidHrefResolver = braneNidUrl,
): { transforms: Array<(tree: any) => void> } {
  if (knownIds.size === 0) return { transforms: [] };
  return refLinks(nidSpec((nid, seq) => (knownIds.has(nid) ? hrefFor(nid, seq) : null)));
}
