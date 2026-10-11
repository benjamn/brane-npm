import { useCallback, useMemo, useSyncExternalStore } from "react";
import { MessageSelection } from "@shared/message-selection";

export { MessageSelection };

/** One selection per narrative screen. A `useMemo` rather than a ref because
 *  the store is created once and never replaced; keying on `nid` gives a
 *  different narrative a different selection, which is what navigating between
 *  two conversations should mean. */
export function useMessageSelection(nid: string | undefined): MessageSelection {
  return useMemo(() => new MessageSelection(), [nid]);
}

/** Whether this one row is selected. The subscription that keeps a tap local:
 *  the bubble asks about itself, so nothing above it has to re-render. */
export function useIsSelected(selection: MessageSelection, seq: number): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => selection.subscribeSeq(seq, onChange),
    [selection, seq],
  );
  const get = useCallback(() => selection.has(seq), [selection, seq]);
  return useSyncExternalStore(subscribe, get, get);
}

/** The whole selection, ascending — for the header's count and the composer's
 *  `re`. Each is a single component, so waking it is the point rather than the
 *  cost; the screen itself deliberately does not call this. */
export function useSelectedSeqs(selection: MessageSelection): readonly number[] {
  return useSyncExternalStore(
    selection.subscribe,
    selection.getSelected,
    selection.getSelected,
  );
}
