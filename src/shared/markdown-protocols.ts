/** Protocol-command linkification: turns `/ramify` in prose into a link that
 *  opens the protocol document, the same way `markdown-nids.ts` turns
 *  `claude-4c7289d1` into a link to that narrative.
 *
 *  Only commands naming a protocol that actually exists are linked, so the
 *  slashes that pepper ordinary agent chatter — paths, dates, `and/or` — stay
 *  prose. That known-set check does most of the work; the boundary rule below
 *  handles the rest.
 */

import { refLinks } from "./markdown-refs.js";

/** A slash command: `/` then a name of the shape protocol files carry
 *  (`ramify`, `LIVE_loop`, `reviewer.draft`). */
export const PROTOCOL_PATTERN = "/([A-Za-z][A-Za-z0-9_.-]*)";

export function braneProtocolUrl(name: string): string {
  return `brane://protocol/${name}`;
}

/** Trailing characters a sentence lends to a command it ends: `read /ramify.`
 *  matches `/ramify.`, which is not a protocol. Shave them one at a time
 *  rather than up front, because `reviewer.draft` needs its dot. */
const TRAILING = ".,:;!?-";

/** Rejects a candidate by what sits next to it. A command stands alone: it
 *  follows the start of a run or a space/bracket, never a path segment
 *  (`src/memory`, `~/memory`, `and/or`), and nothing path-like follows it
 *  (`/memory/index.ts`). Lookbehind would express the first half, but Safari
 *  only learned it in 16.4 and this ships to phones. */
function boundary(before: string, after: string): boolean {
  if (before && /[A-Za-z0-9_./\\~-]/.test(before)) return false;
  if (after === "/") return false;
  return true;
}

/** Rewrites `/protocol` commands into links, as an mdast-util-from-markdown
 *  extension. `hrefFor` defaults to the `brane://protocol/<name>` URL the app's
 *  markdown renderer matches on. */
export function protocolLinks(
  knownProtocols: Set<string>,
  hrefFor: (name: string) => string = braneProtocolUrl,
): { transforms: Array<(tree: any) => void> } {
  if (knownProtocols.size === 0) return { transforms: [] };
  return refLinks({
    pattern: PROTOCOL_PATTERN,
    boundary,
    resolve: (match: RegExpExecArray) => {
      let name = match[1];
      while (name && !knownProtocols.has(name) && TRAILING.includes(name[name.length - 1])) {
        name = name.slice(0, -1);
      }
      if (!name || !knownProtocols.has(name)) return null;
      return { text: `/${name}`, href: hrefFor(name) };
    },
  });
}
