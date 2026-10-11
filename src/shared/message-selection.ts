/**
 * The chat's message selection — which bubbles the operator has tapped.
 *
 * It lives outside React state on purpose. Held as `useState`, the selection
 * made every tap a whole-screen event: a new `Set` re-rendered the `[nid]`
 * screen, which rebuilt `handleTimestampPress`, which rebuilt `renderItem`,
 * which handed every mounted `MessageBubble` a new callback prop and so missed
 * `memo` on all of them. Two bubbles changed color; two hundred rows and the
 * screen above them paid for it.
 *
 * So the store keeps its own listeners, and **per seq**: a toggle notifies the
 * one row whose appearance changed, and a clear notifies exactly the rows that
 * were selected — never a broadcast. The screen holds no selection state at
 * all, which is what takes `renderItem` off the dependency treadmill.
 *
 * Pure, and in `shared/` rather than `expo/lib/` for the usual reason: the
 * notification rules are the whole point and `src/test/message-selection.test.ts`
 * can check them without a browser. The React binding — two
 * `useSyncExternalStore` hooks — is the thin part, and lives in
 * `expo/lib/selection.ts`.
 */

type Listener = () => void;

/** One stable empty array, so an untouched selection's snapshot keeps its
 *  identity and `useSyncExternalStore` never sees a spurious change. */
const NONE: readonly number[] = Object.freeze([]);

export class MessageSelection {
  private selected = new Set<number>();
  /** Ascending, rebuilt only on change — `useSyncExternalStore` compares
   *  snapshots by identity and loops forever on a getter that allocates. */
  private snapshot: readonly number[] = NONE;
  private perSeq = new Map<number, Set<Listener>>();
  private whole = new Set<Listener>();

  /** Is this one selected? The question every bubble asks about itself. */
  has = (seq: number): boolean => this.selected.has(seq);

  get size(): number {
    return this.selected.size;
  }

  /** The selection, ascending — the `re` array for a signal, and the `seqs`
   *  an export is scoped to. Identity is stable between changes. */
  getSelected = (): readonly number[] => this.snapshot;

  /** Watch the selection as a whole: the header's count, the composer's `re`.
   *  One component each, so re-rendering them on a tap is the point. */
  subscribe = (listener: Listener): (() => void) => {
    this.whole.add(listener);
    return () => { this.whole.delete(listener); };
  };

  /** Watch one row. This is the subscription that keeps a tap local. */
  subscribeSeq = (seq: number, listener: Listener): (() => void) => {
    let set = this.perSeq.get(seq);
    if (!set) { set = new Set(); this.perSeq.set(seq, set); }
    set.add(listener);
    return () => {
      const current = this.perSeq.get(seq);
      if (!current) return;
      current.delete(listener);
      // Rows unmount as the list scrolls; an empty bucket left behind would
      // make this map grow with every message ever scrolled past.
      if (current.size === 0) this.perSeq.delete(seq);
    };
  };

  /** Select or deselect one. Returns whether it is now selected — the caller
   *  writes `?scrollToSeq=` from that, and a mutator that says what it did
   *  saves the caller a second read. */
  toggle = (seq: number): boolean => {
    const selecting = !this.selected.has(seq);
    if (selecting) this.selected.add(seq);
    else this.selected.delete(seq);
    this.commit([seq]);
    return selecting;
  };

  /** Drop the whole selection. Returns what was dropped; notifies only those
   *  rows, because they are the only ones whose appearance changed. */
  clear = (): number[] => {
    if (this.selected.size === 0) return [];
    const cleared = [...this.selected];
    this.selected.clear();
    this.commit(cleared);
    return cleared;
  };

  /** Make the selection exactly this — used when a `?scrollToSeq=` arrives
   *  with the route. Notifies the symmetric difference and nothing else. */
  replace = (seqs: Iterable<number>): void => {
    const next = new Set<number>();
    for (const seq of seqs) if (Number.isInteger(seq) && seq > 0) next.add(seq);
    const changed: number[] = [];
    for (const seq of this.selected) if (!next.has(seq)) changed.push(seq);
    for (const seq of next) if (!this.selected.has(seq)) changed.push(seq);
    if (changed.length === 0) return;
    this.selected = next;
    this.commit(changed);
  };

  /** Rebuild the snapshot, then notify — in that order, so a listener that
   *  reads `getSelected()` during its own notification sees the new value
   *  rather than the one it was woken about. */
  private commit(changed: number[]): void {
    this.snapshot = this.selected.size === 0
      ? NONE
      : [...this.selected].sort((a, b) => a - b);
    for (const seq of changed) {
      const listeners = this.perSeq.get(seq);
      if (listeners) for (const listener of [...listeners]) listener();
    }
    for (const listener of [...this.whole]) listener();
  }
}
