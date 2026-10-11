# The Selection Store

The chat's message selection is a store outside React state
(`MessageSelection`, `src/shared/message-selection.ts`), and the two hooks
that bind it (`expo/lib/selection.ts`) are the only React in it. The screen
holds no selection state at all.

It was `useState<Set<number>>`, and that shape had both a cost and a bug.

**The cost is a cascade, not a copy.** A tap replaced the `Set`, which
re-rendered the `[nid]` screen, which rebuilt `handleTimestampPress`
(dependency: `selectedSeqs`), which rebuilt `renderItem`, which handed every
mounted `MessageBubble` a new callback prop — so `memo` missed on all of
them. Two bubbles changed color; two hundred rows and the screen above them
re-rendered.

**The bug is a stale closure, and it drops taps.** Two taps in the same
React batch — a fast double-tap, a trackpad — and the second computed from
the set the first had already replaced, silently undoing it. Measured in a
headless browser against a real daemon: on `origin/main` two rapid taps left
**one** message selected, on the store both. A store is single-writer and
authoritative; a closure over a snapshot is neither.

| Subscription | Who | Wakes when |
|---|---|---|
| `subscribeSeq(seq)` | each `MessageBubble`, via `useIsSelected` | *its* seq is selected or deselected |
| `subscribe()` | the header (Export's count), the composer (`re`) | any change — one component each, which is the point |
| none | the screen, `renderItem`, Export's press handler (`getSelected()` at press time) | never |

Three details are load-bearing:

**A clear notifies what was cleared, not everyone.** `clear()` wakes exactly
the rows that were selected and returns them; an empty clear is not a change
and wakes nobody. `replace()` wakes the symmetric difference. A broadcast
would put the whole list back on the path this exists to keep it off.

**The snapshot's identity is stable.** `useSyncExternalStore` compares
snapshots by identity, so a getter that allocates re-renders forever. The
ascending array is rebuilt on change and only on change, and an empty
selection is one frozen shared array.

**Buckets are dropped when their last listener unsubscribes.** Rows unmount
as the list scrolls; without that, the per-seq map would grow by every
message ever scrolled past.

Pure and in `shared/` for the usual reason: `src/test/message-selection.test.ts`
checks the notification rules without a browser, and
`src/test/selection-wiring.test.ts` reads `expo/app/[nid].tsx` to hold the
screen to the wiring — both spellings select messages, so only a source lint
can keep the old one from coming back.
