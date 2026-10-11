/** Keeping a horizontal pan inside a scrollable element to itself.
 *
 *  The chat pane switches tabs on a horizontal swipe ([nid].tsx) using DOM
 *  touch handlers on the pane container. Anything inside it that scrolls
 *  sideways — a code block, a run of tool rows — would otherwise pan *and*
 *  switch tabs from one gesture.
 *
 *  The fix is directional, not blanket: once a move reads as horizontal, stop
 *  it from reaching the pane, but let vertical moves bubble untouched so a
 *  touch that starts on the scrollable element still scrolls the chat list.
 *  The thresholds are deliberately looser than the pane's own (dx > 6 vs its
 *  dx > 15) so the guard always decides first.
 *
 *  The handlers are shaped to work on both a raw DOM element and a
 *  react-native-web `View`; each hands the event a slightly different way, so
 *  the coordinate lookup falls back through all three shapes. */

import { useMemo, useRef } from "react";

export interface PanGuardHandlers {
  onTouchStart: (e: any) => void;
  onTouchMove: (e: any) => void;
  onTouchEnd: (e: any) => void;
  onTouchCancel: (e: any) => void;
}

function point(e: any): { x: number; y: number } {
  const t = e.nativeEvent?.touches?.[0] ?? e.nativeEvent ?? e;
  return { x: t.pageX ?? t.clientX ?? 0, y: t.pageY ?? t.clientY ?? 0 };
}

export function useHorizontalPanGuard(): PanGuardHandlers {
  const start = useRef<{ x: number; y: number } | null>(null);
  // Whether this gesture has been claimed as a horizontal pan. Stopping the
  // moves is not enough on its own: the pane decides to switch tabs in its
  // `touchend` handler, from the distance between its own start and end
  // points, and it never consulted the moves it missed. A claimed gesture has
  // to be stopped all the way through its end, or the pan lands *and* the tab
  // flips (claude-n1izig04:24).
  const claimed = useRef(false);
  return useMemo(() => {
    const end = (e: any) => {
      if (claimed.current) e.stopPropagation?.();
      start.current = null;
      claimed.current = false;
    };
    return {
      onTouchStart: (e: any) => {
        start.current = point(e);
        claimed.current = false;
      },
      onTouchMove: (e: any) => {
        const from = start.current;
        if (!from) return;
        if (!claimed.current) {
          const { x, y } = point(e);
          const dx = Math.abs(x - from.x);
          const dy = Math.abs(y - from.y);
          if (dx > 6 && dx > dy * 1.2) claimed.current = true;
        }
        if (claimed.current) e.stopPropagation();
      },
      onTouchEnd: end,
      onTouchCancel: end,
    };
  }, []);
}
