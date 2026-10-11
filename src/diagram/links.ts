/** Where brane's own grammars reach inside a diagram.
 *
 *  A ```mermaid fence is the one place in brane where prose goes in and
 *  nothing brane knows about comes out: a node labelled `claude-0qjv4nny` is
 *  dead text, where the same characters in a paragraph are a tappable link.
 *  This closes that, and it is the reason brane renders diagrams itself
 *  rather than renting a renderer — no off-the-shelf one can look up whether
 *  a narrative exists.
 *
 *  **The dialect gains no syntax for it.** A label that happens to be a
 *  narrative reference is linked; everything else is left as text. So the same
 *  fence still renders on GitHub, where the label is simply not a link — which
 *  matters, because GitHub is where these are usually read.
 *
 *  The existence check is the same rule `markdown-nids.ts` applies in prose:
 *  only narratives that actually exist are linked, so an arbitrary string of
 *  the same shape doesn't become a dead link.
 */

import type Database from "better-sqlite3";
import { NID_REF_PATTERN, braneNidUrl } from "../shared/markdown-nids.js";

/** A label that is *entirely* a reference.
 *
 *  Whole-label only: a reference buried in a sentence inside a box would need
 *  the text split into tspans with their own anchors, which is a second
 *  rendering path for a case the corpus does not contain.
 *
 *  **`@` is deliberately not accepted.** A diagram node *cites*; it does not
 *  address. The first draft matched `@?`, which made `A[@claude-x]` render as
 *  a link — but `mentions-scan` walks the rendered markdown, where a fence is
 *  inert, so no mention row was ever written. That breaks the rule the
 *  Mentions design rests on: a handle notifies *iff* the operator sees it as
 *  one. Refusing the `@` here keeps the two in step, and addressing someone
 *  from inside a picture is a capability nobody asked for. */
const WHOLE_REF = new RegExp(`^\\s*${NID_REF_PATTERN}\\s*$`);

/** Where a resolved reference points. Defaults to the app's in-band scheme;
 *  the export supplies its own, because `brane://` opens in no browser. */
export type DiagramHrefTarget = (nid: string, seq?: string) => string;

export function nidHrefFor(
  db: Database.Database,
  target: DiagramHrefTarget = braneNidUrl,
): (label: string) => string | null {
  const exists = db.prepare("SELECT 1 FROM narratives WHERE id = ?");
  const seen = new Map<string, boolean>();
  return (label: string) => {
    const m = WHOLE_REF.exec(label);
    if (!m) return null;
    const [, nid, seq] = m;
    let ok = seen.get(nid);
    if (ok === undefined) {
      ok = exists.get(nid) !== undefined;
      seen.set(nid, ok);
    }
    return ok ? target(nid, seq) : null;
  };
}
