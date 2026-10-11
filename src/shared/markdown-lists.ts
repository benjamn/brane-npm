/** Where the app and the HTML export have to agree about lists.
 *
 *  The export never calls into here — micromark decides looseness itself, on
 *  the way to HTML, and emits `<li><p>…</p></li>` for a loose item against a
 *  bare `<li>…</li>` for a tight one. The app has no such luxury: it renders
 *  from mdast, where the flags survive but the decision does not, so it has to
 *  make the same call the HTML side already made. This is that call, written
 *  once and pinned by `src/test/markdown-lists.test.ts` *against micromark's
 *  own output* — the only way to know the two still agree.
 */

/** The mdast shape this needs, and no more. Kept structural so callers can
 *  pass a `List` node from any mdast version without a type dependency. */
interface ListItemLike {
  spread?: boolean | null;
  children?: unknown[];
}
interface ListLike {
  spread?: boolean | null;
  children?: ListItemLike[];
}

/** CommonMark: an item is loose when it holds more than one block, which is
 *  what `spread` records. The flag is authoritative when present; the child
 *  count is the fallback for a tree built by hand rather than by a parser. */
function itemIsLoose(item: ListItemLike | undefined): boolean {
  if (!item) return false;
  if (typeof item.spread === "boolean") return item.spread;
  return (item.children?.length ?? 0) > 1;
}

/** Whether a list renders loose — paragraph margins between items — or tight.
 *
 *  Looseness is a property of the **list**, never of the item: CommonMark says
 *  a list is loose if *any* of its items are separated by a blank line, and
 *  every item then renders loose. So a two-item list whose first item is spread
 *  gives its second item paragraph margins too, and reading `item.spread`
 *  alone — the obvious shortcut — would space the two differently. */
export function listIsLoose(list: ListLike | undefined | null): boolean {
  if (!list) return false;
  if (list.spread) return true;
  return (list.children ?? []).some(itemIsLoose);
}

/** Where a loose list item's top margin has to live.
 *
 *  A list item row is two flex siblings — the marker `<Text>` and a `<View>`
 *  holding the content — top-aligned. So a margin on the *first paragraph*
 *  indents only the content column, and the marker stays parked at the top of
 *  the row: a `1.` floating ~8px above the line it numbers, reading as a
 *  superscript. Tight lists never showed it because their paragraph margins are
 *  zeroed anyway; loose lists show it on every item, because there the spacing
 *  is deliberate.
 *
 *  CSS has no such failure mode — the `::marker` is aligned to the first line
 *  box of the item's principal block, so a `<p>` margin moves the marker with
 *  the text — which is why the export renders these correctly and the app does
 *  not. The fix is to put the margin somewhere it moves *both* halves of the
 *  row: on the row itself.
 *
 *  The pair below has to be read together, since the whole point is that they
 *  add up to what the paragraph margins used to contribute on their own. */

/** The margin override for a paragraph, by where it sits in a list. `null`
 *  leaves the stylesheet's own `paragraph` margins alone. */
export function listParagraphOverride(where: {
  inListItem: boolean;
  /** Is this the item's *first* block? Only that one collides with the marker. */
  firstBlock: boolean;
  loose: boolean;
}): { marginVertical: number } | { marginTop: number } | null {
  if (!where.inListItem) return null;
  // A tight list runs its items together: no paragraph margins at all.
  if (!where.loose) return { marginVertical: 0 };
  // Loose: the first block's top margin has moved to the row. Later blocks in
  // the same item keep theirs — they sit below the marker, not beside it.
  return where.firstBlock ? { marginTop: 0 } : null;
}

/** The row's own top margin — exactly the margin `listParagraphOverride` just
 *  took off the first paragraph, so the text lands where it always did and only
 *  the marker moves. `paragraphMargin` is the stylesheet's `paragraph`
 *  `marginVertical`, passed in rather than duplicated here. */
export function listItemRowMarginTop(loose: boolean, paragraphMargin: number): number {
  return loose ? paragraphMargin : 0;
}
