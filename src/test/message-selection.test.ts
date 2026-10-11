import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MessageSelection } from "../shared/message-selection.js";

/** Records which rows were woken, so a test can assert what a tap *didn't*
 *  touch — which is the entire reason this store exists. */
function watch(sel: MessageSelection, seqs: number[]) {
  const woken: number[] = [];
  const unsubs = seqs.map((seq) => sel.subscribeSeq(seq, () => woken.push(seq)));
  return { woken, unsubscribe: () => unsubs.forEach((u) => u()) };
}

describe("MessageSelection", () => {
  it("toggles one seq on and off", () => {
    const sel = new MessageSelection();
    assert.equal(sel.has(4), false);
    assert.equal(sel.toggle(4), true);
    assert.equal(sel.has(4), true);
    assert.equal(sel.size, 1);
    assert.equal(sel.toggle(4), false);
    assert.equal(sel.has(4), false);
  });

  it("keeps the selection ascending whatever order it was tapped in", () => {
    const sel = new MessageSelection();
    for (const seq of [9, 2, 5]) sel.toggle(seq);
    assert.deepEqual([...sel.getSelected()], [2, 5, 9]);
  });

  it("holds the snapshot's identity steady between changes", () => {
    // useSyncExternalStore compares snapshots by identity; a getter that
    // allocates on every read re-renders forever.
    const sel = new MessageSelection();
    assert.equal(sel.getSelected(), sel.getSelected());
    sel.toggle(3);
    const after = sel.getSelected();
    assert.equal(sel.getSelected(), after);
    sel.toggle(4);
    assert.notEqual(sel.getSelected(), after);
  });

  it("wakes only the row that changed", () => {
    const sel = new MessageSelection();
    const { woken } = watch(sel, [1, 2, 3, 4, 5]);
    sel.toggle(3);
    assert.deepEqual(woken, [3], "a tap is not a broadcast");
    sel.toggle(3);
    assert.deepEqual(woken, [3, 3]);
  });

  it("wakes only the rows a clear actually cleared", () => {
    const sel = new MessageSelection();
    sel.toggle(2);
    sel.toggle(4);
    const { woken } = watch(sel, [1, 2, 3, 4, 5]);
    assert.deepEqual(sel.clear(), [2, 4]);
    assert.deepEqual(woken.sort(), [2, 4]);
    assert.equal(sel.size, 0);
  });

  it("does nothing at all on a clear with nothing selected", () => {
    const sel = new MessageSelection();
    const { woken } = watch(sel, [1, 2, 3]);
    let wholeCalls = 0;
    sel.subscribe(() => { wholeCalls++; });
    assert.deepEqual(sel.clear(), []);
    assert.deepEqual(woken, []);
    assert.equal(wholeCalls, 0, "an empty clear is not a change");
  });

  it("replace wakes the symmetric difference and nothing else", () => {
    const sel = new MessageSelection();
    sel.replace([1, 2, 3]);
    const { woken } = watch(sel, [1, 2, 3, 4]);
    sel.replace([2, 3, 4]);
    assert.deepEqual(woken.sort(), [1, 4], "2 and 3 were selected before and after");
    assert.deepEqual([...sel.getSelected()], [2, 3, 4]);
  });

  it("replace with the same set is not a change", () => {
    const sel = new MessageSelection();
    sel.replace([5, 6]);
    let wholeCalls = 0;
    sel.subscribe(() => { wholeCalls++; });
    sel.replace([6, 5]);
    assert.equal(wholeCalls, 0);
  });

  it("ignores values that are not seqs", () => {
    const sel = new MessageSelection();
    sel.replace([0, -1, 2.5, 7]);
    assert.deepEqual([...sel.getSelected()], [7]);
  });

  it("notifies whole-selection watchers on every change", () => {
    const sel = new MessageSelection();
    const seen: number[][] = [];
    sel.subscribe(() => seen.push([...sel.getSelected()]));
    sel.toggle(1);
    sel.toggle(2);
    sel.clear();
    // Each listener sees the value it was woken about, not the previous one.
    assert.deepEqual(seen, [[1], [1, 2], []]);
  });

  it("forgets a row's bucket once nothing is watching it", () => {
    // Rows unmount as the list scrolls; buckets left behind would grow the map
    // by every message ever scrolled past.
    const sel = new MessageSelection();
    const { unsubscribe } = watch(sel, [42]);
    unsubscribe();
    const { woken } = watch(sel, [42]);
    sel.toggle(42);
    assert.deepEqual(woken, [42], "re-subscribing still works after the bucket was dropped");
  });

  it("survives a listener that unsubscribes while being notified", () => {
    const sel = new MessageSelection();
    let calls = 0;
    const off = sel.subscribeSeq(8, () => { calls++; off(); });
    sel.toggle(8);
    sel.toggle(8);
    assert.equal(calls, 1);
  });
});
