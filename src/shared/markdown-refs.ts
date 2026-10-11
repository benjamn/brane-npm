/** Inline-reference linkification over an mdast tree — the machinery behind
 *  both the narrative-id linkifier (`markdown-nids.ts`) and the protocol-command
 *  one (`markdown-protocols.ts`).
 *
 *  A tree transform rather than a rewrite of the markdown source: code spans,
 *  fenced blocks, existing links and autolinked URLs are excluded
 *  *structurally* — the parser has already decided what they are, so this only
 *  ever sees prose. Source-level regexes can't make that distinction, and get
 *  it wrong on things like `https://brane.organelle.dev/claude-4c7289d1`.
 */

/** The span a reference resolved to: `text` is the source it consumed (a prefix
 *  of the regex match, so a spec can shave trailing punctuation off), `href` is
 *  where the link points. */
export type RefHit = { text: string; href: string };

export type RefSpec = {
  /** Matches one candidate reference in prose. No flags — the walker applies
   *  its own. */
  pattern: string;
  /** Turns a candidate into a link, or returns null to leave it as prose. This
   *  is where "only link things that actually exist" lives. */
  resolve: (match: RegExpExecArray) => RefHit | null;
  /** Vetoes a candidate by its immediate neighbors, each `""` at a text edge.
   *  Regex lookbehind would do this, but Safari only learned it in 16.4 and
   *  this code ships to phones. */
  boundary?: (before: string, after: string) => boolean;
};

/** Node types whose subtree is off-limits: their text is either already a
 *  link, a URL/label slot, or verbatim code. Nothing inside them is prose. */
const OPAQUE = new Set([
  "link", "linkReference", "definition",
  "image", "imageReference",
  "code", "html",
]);

type Point = { line: number; column: number };
export type MdNode = {
  type: string;
  key?: string;
  value?: string;
  position?: { start?: Point };
  children?: MdNode[];
  [k: string]: unknown;
};

// The renderer keys nodes off source position, and does so before extensions
// run — so nodes synthesized here have to bring their own keys. Derive them
// from the node being replaced (its own key when it has one, else its source
// position) so they stay stable across re-renders of the same content and
// don't depend on which other extensions are installed.
function keyOf(node: MdNode): string {
  if (typeof node.key === "string" && node.key) return node.key;
  const start = node.position?.start;
  return start ? `${node.type}-${start.line}:${start.column}` : node.type;
}

function makeLink(label: string, href: string, key: string): MdNode {
  return {
    type: "link",
    url: href,
    title: null,
    key,
    children: [{ type: "text", value: label, key: `${key}-label` }],
  };
}

/** Splits a text node's value on references, returning the replacement node
 *  list — or null if it holds no linkable reference. */
function splitText(node: MdNode, spec: RefSpec): MdNode[] | null {
  const value = typeof node.value === "string" ? node.value : "";
  const base = keyOf(node);
  const re = new RegExp(spec.pattern, "g");
  const out: MdNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (spec.boundary && !spec.boundary(value.slice(Math.max(0, start - 1), start), value.slice(end, end + 1))) {
      continue;
    }
    const hit = spec.resolve(match);
    if (hit === null) continue;
    const consumed = match[0].startsWith(hit.text) ? hit.text.length : match[0].length;
    if (start > last) {
      out.push({ type: "text", value: value.slice(last, start), key: `${base}-t${out.length}` });
    }
    out.push(makeLink(hit.text, hit.href, `${base}-ref${out.length}`));
    last = start + consumed;
    re.lastIndex = last;
  }
  if (out.length === 0) return null;
  if (last < value.length) {
    out.push({ type: "text", value: value.slice(last), key: `${base}-t${out.length}` });
  }
  return out;
}

/** A code span that is *entirely* one reference becomes a link; anything else
 *  stays code. Agents habitually write `` `claude-4c7289d1:42` `` and
 *  `` `/ramify` ``. */
function codeSpanToLink(node: MdNode, spec: RefSpec): MdNode | null {
  const value = typeof node.value === "string" ? node.value : "";
  const match = new RegExp(`^(?:${spec.pattern})$`).exec(value);
  if (!match) return null;
  const hit = spec.resolve(match);
  if (hit === null || hit.text !== value) return null;
  return makeLink(hit.text, hit.href, `${keyOf(node)}-ref`);
}

function walk(parent: MdNode, spec: RefSpec): void {
  if (!Array.isArray(parent.children)) return;
  const out: MdNode[] = [];
  let changed = false;
  for (const child of parent.children) {
    if (OPAQUE.has(child.type)) {
      out.push(child);
    } else if (child.type === "inlineCode") {
      const link = codeSpanToLink(child, spec);
      if (link) changed = true;
      out.push(link ?? child);
    } else if (child.type === "text") {
      const split = splitText(child, spec);
      if (split) changed = true;
      out.push(...(split ?? [child]));
    } else {
      walk(child, spec);
      out.push(child);
    }
  }
  if (changed) parent.children = out;
}

/** Rewrites references into links, in place. */
export function linkifyRefs(tree: any, spec: RefSpec): void {
  walk(tree, spec);
}

/** `linkifyRefs` packaged as an mdast-util-from-markdown extension. Several can
 *  be installed at once: each runs after the last, and links a predecessor
 *  created are opaque to it. */
export function refLinks(spec: RefSpec): { transforms: Array<(tree: any) => void> } {
  return { transforms: [(tree: any) => linkifyRefs(tree, spec)] };
}
