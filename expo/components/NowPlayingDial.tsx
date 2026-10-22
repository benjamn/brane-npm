/** The dial: progress ring, play/pause button and scrubber in one control.
 *
 *  The full circle is the track, the lit arc is elapsed. A tap plays or
 *  pauses. A drag scrubs by angle: the playhead goes where an invisible line
 *  from the dial's center to the finger points, so 3 o'clock is a quarter of
 *  the way through however the finger got there. The seek happens on
 *  release; while the finger is down a clock under the dial shows where it
 *  will land. Inside the ring the angle is no use, so a drag let go there
 *  cancels, and while the finger is there the dial shows the playhead where
 *  it already is. A long-press (`LONG_PRESS_MS`, held still) calls `onOpen`, which
 *  is how the list card, the header and the switcher take you back to the
 *  file the track came from.
 *
 *  Nothing on or around the dial is selectable: a long-press on iOS selects
 *  the nearest text even past `user-select: none`, and raises the callout, so
 *  the dial cancels `touchstart` natively (React's is passive). That also
 *  stops the click a touch would synthesize, which the card under the dial
 *  would take as opening its narrative. And no touch on the dial reaches what
 *  holds it: the list's pull-to-refresh listens natively on an ancestor, so a
 *  React `stopPropagation`, which runs only once the event has bubbled to
 *  React's root, came too late, and a drag down on a card's dial pulled the
 *  whole list with it. The dial stops every touch event on itself instead;
 *  its gestures are pointer events, which this leaves alone.
 *
 *  With a `track`, the dial is that file's: idle (an empty ring and ▶) until
 *  the file is the one in the narrative's slot, live after. Without one it is
 *  the narrative's slot itself, and renders nothing while the slot is empty.
 *  Drawn with inline SVG, as the status badge is; the math is in
 *  `@shared/audio-dial`, tested without a DOM. */
import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import {
  arcPath,
  clampFraction,
  elapsedFraction,
  formatClock,
  fractionAt,
  insideRing,
  LONG_PRESS_MS,
} from "@shared/audio-dial";
import { sameTrack, trackTitle, type JukeboxTrack } from "@shared/now-playing";
import { TAP_SLOP_PX } from "@shared/no-pan";
import { playTrack, seekTrack, toggleTrack, useJukeboxEntry } from "@/lib/jukebox";

const GREEN = "#8fd4b4";
/** What React Native's Text renders in on web; a raw DOM element gets the
 *  browser's serif unless told, as the drag clock once was. */
export const UI_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const TOMATO = "#ff785a";

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  /** The scrub position, as a fraction of the track; `null` while the
   *  pointer is inside the ring, where letting go cancels. */
  value: number | null;
  moved: boolean;
  /** The pending long-press, until the finger moves or lifts. */
  hold: ReturnType<typeof setTimeout> | null;
  /** The long-press fired, so the release is neither a tap nor a seek. */
  held: boolean;
}

/** Whatever a long-press left selected, gone: the backstop for a browser that
 *  selects in spite of the dial. */
function clearSelection() {
  try {
    window.getSelection()?.removeAllRanges();
  } catch {
    // Nothing to clear.
  }
}

export default function NowPlayingDial({
  nid,
  track,
  size = 28,
  style,
  onOpen,
}: {
  nid: string;
  track?: JukeboxTrack;
  size?: number;
  style?: React.CSSProperties;
  /** A long-press: open the track's file. Without it a hold is a tap. */
  onOpen?: (track: JukeboxTrack) => void;
}) {
  const entry = useJukeboxEntry(nid);
  const live = track ? (entry && sameTrack(entry.track, track) ? entry : null) : entry;
  /** The drag in progress, if any, and where it would land: `to` is `null`
   *  while the pointer is inside the ring and letting go would cancel. */
  const [scrub, setScrub] = useState<{ to: number | null } | null>(null);
  const drag = useRef<Drag | null>(null);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!el) return;
    const start = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const keep = (e: TouchEvent) => e.stopPropagation();
    el.addEventListener("touchstart", start, { passive: false });
    for (const type of ["touchmove", "touchend", "touchcancel"] as const) el.addEventListener(type, keep);
    return () => {
      el.removeEventListener("touchstart", start);
      for (const type of ["touchmove", "touchend", "touchcancel"] as const) el.removeEventListener(type, keep);
    };
  }, [el]);
  // A long-press that navigates unmounts the dial with its timer pending.
  useEffect(() => () => {
    if (drag.current?.hold) clearTimeout(drag.current.hold);
  }, []);
  if (Platform.OS !== "web" || (!live && !track)) return null;

  const duration = live?.duration ?? 0;
  const fraction = scrub?.to ?? (live ? elapsedFraction(live.position, duration) : 0);
  const active = live?.status === "playing" || live?.status === "loading";
  const color = live?.status === "error" ? TOMATO : GREEN;

  const c = size / 2;
  const stroke = Math.max(2, size / 12);
  const r = c - stroke / 2 - 1;
  const glyph = size * 0.2;

  /** The dial's center on screen, and the ring's inner edge as a radius. */
  const center = (el: HTMLElement) => {
    const box = el.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2, inner: ((r - stroke / 2) * box.width) / size };
  };

  /** Every way a gesture ends, the release, a cancel, or a release that
   *  never arrived, leaves nothing behind: no pending long-press and no clock
   *  under the dial. Before this, only a drag's own release cleared the clock,
   *  so one stranded drag kept it up through any number of taps. */
  const finish = (g: Drag) => {
    if (g.hold) clearTimeout(g.hold);
    g.hold = null;
    if (drag.current === g) drag.current = null;
    setScrub(null);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.stopPropagation();
    if (drag.current) finish(drag.current);
    const g: Drag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      value: null,
      moved: false,
      hold: null,
      held: false,
    };
    const target = live?.track ?? track;
    if (onOpen && target) {
      g.hold = setTimeout(() => {
        g.hold = null;
        g.held = true;
        clearSelection();
        onOpen(target);
      }, LONG_PRESS_MS);
    }
    drag.current = g;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g || g.pointerId !== e.pointerId) return;
    // A move with no button down is a release the dial never heard: let go
    // outside the window, or after capture was lost. The mouse's pointerId
    // never changes, so without this, hovering would go on scrubbing. It is
    // a cancel, not a seek: where the button came up is unknown.
    if (e.buttons === 0) {
      finish(g);
      return;
    }
    if (g.held) return;
    if (!g.moved) {
      if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) <= TAP_SLOP_PX) return;
      g.moved = true;
      if (g.hold) clearTimeout(g.hold);
      g.hold = null;
    }
    // Only a loaded track with a known length can be scrubbed; an idle dial
    // still swallows the drag so the list under it doesn't move.
    if (live && duration > 0) {
      const { x, y, inner } = center(e.currentTarget);
      g.value = insideRing(x, y, e.clientX, e.clientY, inner) ? null : clampFraction(fractionAt(x, y, e.clientX, e.clientY));
      setScrub({ to: g.value });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g || g.pointerId !== e.pointerId) return;
    finish(g);
    e.stopPropagation();
    if (g.held) {
      clearSelection();
      return;
    }
    if (g.moved) {
      if (live && duration > 0 && g.value !== null) seekTrack(nid, g.value * duration);
      return;
    }
    if (live) toggleTrack(nid);
    else if (track) playTrack(track);
  };

  /** A cancel, and a lost capture: capture can go without a release (a
   *  re-sorted list moves the card's node, which releases it), and the
   *  `pointerup` then lands elsewhere. After an ordinary release the gesture
   *  is already finished and this finds nothing to end. */
  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (g?.pointerId === e.pointerId) finish(g);
  };

  const label = live
    ? `${active ? "Pause" : "Play"} ${live.track.path}, ${formatClock(live.position)} of ${formatClock(duration)}`
    : `Play ${track?.path ?? ""}`;

  return (
    <div
      ref={setEl}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(fraction * duration)}
      title={
        live
          ? `${trackTitle(live.track.path)}: ${active ? "pause" : "play"} · drag round to scrub${onOpen ? " · hold to open" : ""}`
          : "Play"
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      // A click on the dial is never a click on what holds it (a list card
      // opens its narrative on click); touches are stopped natively, above.
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: "relative",
        width: size,
        height: size,
        flexShrink: 0,
        cursor: "pointer",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        ...style,
      }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden style={{ display: "block" }}>
        <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeOpacity={0.22} strokeWidth={stroke} />
        {fraction > 0 && (
          <path d={arcPath(c, c, r, fraction)} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" />
        )}
        {active && scrub === null ? (
          <g fill={color}>
            <rect x={c - glyph * 0.85} y={c - glyph * 0.9} width={glyph * 0.55} height={glyph * 1.8} rx={glyph * 0.12} />
            <rect x={c + glyph * 0.3} y={c - glyph * 0.9} width={glyph * 0.55} height={glyph * 1.8} rx={glyph * 0.12} />
          </g>
        ) : (
          <polygon
            points={`${c - glyph * 0.7},${c - glyph} ${c - glyph * 0.7},${c + glyph} ${c + glyph * 1.1},${c}`}
            fill={color}
            fillOpacity={live ? (live.status === "loading" ? 0.55 : 1) : 0.75}
          />
        )}
      </svg>
      {scrub !== null && live && duration > 0 && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: "50%",
            transform: "translate(-50%, 4px)",
            padding: "2px 6px",
            borderRadius: 4,
            backgroundColor: "rgba(26, 26, 30, 0.92)",
            border: `1px solid rgba(143, 212, 180, 0.4)`,
            color: "#ddd",
            fontFamily: UI_FONT,
            fontSize: 11,
            lineHeight: "14px",
            whiteSpace: "nowrap",
            fontVariantNumeric: "tabular-nums",
            pointerEvents: "none",
            zIndex: 2,
          }}
        >
          {formatClock(fraction * duration)} / {formatClock(duration)}
        </div>
      )}
    </div>
  );
}
