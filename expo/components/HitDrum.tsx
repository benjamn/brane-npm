import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactElement } from "react";
import {
  BUMP_VELOCITY,
  clampIndex,
  compactCount,
  releaseVelocity,
  rubberBand,
  springAtRest,
  springStep,
  throwTarget,
} from "@shared/hit-drum";

/** One detent's height, which is also how far a finger travels per hit: the
 *  drum tracks the finger exactly. */
const PITCH = 18;
/** Tall enough that a neighbour peeks above and below the current hit. */
const SLOT_H = 44;
/** Each detent turns the cylinder this far; the radius follows so that
 *  neighbouring faces sit PITCH apart where they cross the middle. */
const STEP_DEG = 26;
const RADIUS = PITCH / (2 * Math.tan((STEP_DEG * Math.PI) / 360));
const TAP_SLOP_PX = 4;
/** Faces beyond this angle are turned away from the viewer. */
const HIDE_DEG = 84;
/** Wheel/trackpad travel per hit, and the pause that counts as done. */
const WHEEL_PX = 40;
const WHEEL_SETTLE_MS = 140;
const FONT = "ui-monospace, Menlo, monospace";
const PEEK_MASK = "linear-gradient(to bottom, transparent 0, #000 34%, #000 66%, transparent 100%)";

export interface HitDrumHandle {
  /** Roll one hit forward or back, as Enter / ⇧Enter do. */
  step: (dir: 1 | -1) => void;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Find-in-file's hit counter, as a cylinder you can roll.
 *
 *  Each face reads `3/17`, right-aligned in a column sized for the widest
 *  label, so the `/17`s stand in one vertical line as faces roll past. Swipe
 *  up for later hits, flick to skim several, tap the upper or lower half for
 *  one step; the wheel rolls it on desktop. The position is a real number
 *  in hit units and every change of it goes to `onSeek`, which is how the
 *  page scrolls *with* the drum instead of jumping when it lands. It never
 *  takes focus, so the keyboard stays however it was.
 *
 *  `label` replaces the faces with one static reading (`L40`, `0/0`) when
 *  there is nothing to roll through; a tap then asks for a re-center. */
export const HitDrum = forwardRef<HitDrumHandle, {
  count: number;
  current: number;
  capped: boolean;
  /** Static text instead of rolling faces. */
  label?: string;
  miss: boolean;
  onSeek: (pos: number, settled: boolean) => void;
  /** Tap or step while static. */
  onStaticStep: (dir: 1 | -1) => void;
}>(function HitDrum({ count, current, capped, label, miss, onSeek, onStaticStep }, ref) {
  const rollable = label === undefined && count > 0;
  const [pos, setPos] = useState(current < 0 ? 0 : current);
  const posRef = useRef(pos);
  const velRef = useRef(0);
  const targetRef = useRef<number | null>(null);
  const rafRef = useRef(0);
  const drag = useRef<{ startY: number; startPos: number; moved: boolean; samples: { t: number; y: number }[] } | null>(null);
  const lastTickRef = useRef(Math.round(pos));
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const elRef = useRef<HTMLDivElement>(null);
  const seekRef = useRef(onSeek);
  seekRef.current = onSeek;

  const moveTo = useCallback((x: number, settled: boolean) => {
    posRef.current = x;
    setPos(x);
    // A detent tick where the platform has one (Android); silent elsewhere.
    const detent = Math.round(x);
    if (detent !== lastTickRef.current) {
      lastTickRef.current = detent;
      if (!settled) (navigator as Navigator & { vibrate?: (ms: number) => boolean }).vibrate?.(3);
    }
    seekRef.current(x, settled);
  }, []);

  const stopAnimation = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    targetRef.current = null;
  }, []);

  /** Roll to a whole hit under the spring, carrying velocity `v` (hits/s). */
  const animateTo = useCallback((target: number, v: number) => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    targetRef.current = target;
    velRef.current = v;
    if (prefersReducedMotion()) {
      targetRef.current = null;
      moveTo(target, true);
      return;
    }
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      const s = springStep(posRef.current, velRef.current, target, dt);
      velRef.current = s.v;
      if (springAtRest(s.x, s.v, target)) {
        rafRef.current = 0;
        targetRef.current = null;
        velRef.current = 0;
        moveTo(target, true);
        return;
      }
      moveTo(s.x, false);
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
  }, [moveTo]);

  const step = useCallback((dir: 1 | -1) => {
    if (!rollable) {
      onStaticStep(dir);
      return;
    }
    // Steps queue onto a roll in flight, so Enter held down skims.
    const from = targetRef.current ?? clampIndex(posRef.current, count);
    const to = from + dir;
    // Stepping into an end: a bump against the wall, not a lap back round.
    if (to < 0 || to >= count) animateTo(from, dir * BUMP_VELOCITY);
    else animateTo(to, velRef.current);
  }, [rollable, count, onStaticStep, animateTo]);

  useImperativeHandle(ref, () => ({ step }), [step]);

  // Follow the search when it moves the current hit itself — a new query, a
  // re-render re-anchoring — unless the drum is the one moving.
  useEffect(() => {
    if (drag.current || rafRef.current || current < 0) return;
    if (clampIndex(posRef.current, count) === current) return;
    posRef.current = current;
    lastTickRef.current = current;
    setPos(current);
  }, [current, count]);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (wheelTimer.current) clearTimeout(wheelTimer.current);
  }, []);

  // Wheel needs a non-passive listener, or the page scrolls along with it.
  useEffect(() => {
    const el = elRef.current;
    if (!el || !rollable) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stopAnimation();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      // One notch of a clicky wheel (~100px) is one hit, not two and a half.
      const hits = Math.max(-1, Math.min(1, delta / WHEEL_PX));
      moveTo(rubberBand(posRef.current + hits, count), false);
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
      wheelTimer.current = setTimeout(() => animateTo(clampIndex(posRef.current, count), 0), WHEEL_SETTLE_MS);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [rollable, count, moveTo, animateTo, stopAnimation]);

  const total = `${compactCount(count)}${capped ? "+" : ""}`;
  // Sized for the widest face, `17/17` (or `1234/1.2k`), so the drum never
  // changes width while it rolls and every face's `/17` lands in the same
  // column.
  const widthCh = label !== undefined ? Math.max(label.length, 3) : String(count).length + 1 + total.length;
  const color = miss ? "#ff8a8a" : "#e6e6e6";

  const faces: ReactElement[] = [];
  if (rollable) {
    const base = Math.round(pos);
    // Nothing peeks past an end: an empty slot above 1/17 is how the
    // reader knows they are at the top before they push against it.
    for (let k = Math.max(0, base - 3); k <= Math.min(count - 1, base + 3); k++) {
      const d = k - pos;
      const deg = d * STEP_DEG;
      if (Math.abs(deg) > HIDE_DEG) continue;
      const near = Math.max(0, 1 - Math.abs(d));
      faces.push(
        <div
          key={k}
          style={{
            position: "absolute",
            left: 0,
            width: "100%",
            height: PITCH,
            lineHeight: `${PITCH}px`,
            textAlign: "right",
            whiteSpace: "pre",
            transform: `rotateX(${-deg}deg) translateZ(${RADIUS}px)`,
            backfaceVisibility: "hidden",
            opacity: 0.38 + 0.62 * near,
            color: near > 0.5 ? color : "#9a9a9a",
          }}
        >
          {`${k + 1}/${total}`}
        </div>,
      );
    }
  }

  return (
    <div
      ref={elRef}
      role={rollable ? "spinbutton" : "status"}
      aria-label={rollable ? `Match ${clampIndex(pos, count) + 1} of ${count}${capped ? " or more" : ""}` : label}
      aria-valuenow={rollable ? clampIndex(pos, count) + 1 : undefined}
      aria-valuemin={rollable ? 1 : undefined}
      aria-valuemax={rollable ? count : undefined}
      title={rollable ? "Swipe or scroll to move between matches" : undefined}
      // Never take focus: the input keeps it, and with it the keyboard.
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        stopAnimation();
        drag.current = { startY: e.clientY, startPos: posRef.current, moved: false, samples: [{ t: e.timeStamp, y: e.clientY }] };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const g = drag.current;
        if (!g) return;
        const dy = e.clientY - g.startY;
        if (!g.moved && Math.abs(dy) <= TAP_SLOP_PX) return;
        g.moved = true;
        g.samples.push({ t: e.timeStamp, y: e.clientY });
        if (g.samples.length > 12) g.samples.shift();
        // Swipe up brings later hits up from below, as scrolling a list does.
        if (rollable) moveTo(rubberBand(g.startPos - dy / PITCH, count), false);
      }}
      onPointerUp={(e) => {
        const g = drag.current;
        drag.current = null;
        if (!g) return;
        if (!g.moved) {
          const box = e.currentTarget.getBoundingClientRect();
          step(e.clientY < box.top + box.height / 2 ? -1 : 1);
          return;
        }
        if (!rollable) return;
        const vPxMs = releaseVelocity(g.samples, e.timeStamp);
        const v = (-vPxMs * 1000) / PITCH;
        animateTo(throwTarget(posRef.current, v, count), v);
      }}
      onPointerCancel={() => {
        if (!drag.current) return;
        drag.current = null;
        if (rollable) animateTo(clampIndex(posRef.current, count), 0);
      }}
      style={{
        position: "relative",
        // The widest face fills the box exactly (text sits 4px in from the
        // right), and the margins mirror the 🔎 on the far left: 16px from the
        // input to the text, 16px from the text to the bar's edge (with the
        // bar's own 8px padding).
        width: `calc(${widthCh}ch + 4px)`,
        height: SLOT_H,
        margin: `${(36 - SLOT_H) / 2}px 4px ${(36 - SLOT_H) / 2}px 16px`,
        flexShrink: 0,
        fontFamily: FONT,
        fontSize: 13,
        fontVariantNumeric: "tabular-nums",
        cursor: rollable ? "ns-resize" : "pointer",
        userSelect: "none",
        WebkitUserSelect: "none",
        // Without this a vertical swipe scrolls the page, or drags iOS's
        // keyboard accessory, instead of rolling the drum.
        touchAction: "none",
        perspective: 160,
        // Foreshorten toward the faces' right edge, the column the `/17`s end
        // in, so a face tilting away shrinks leftward and its total stays put.
        perspectiveOrigin: "calc(100% - 4px) 50%",
        WebkitMaskImage: rollable ? PEEK_MASK : undefined,
        maskImage: rollable ? PEEK_MASK : undefined,
      }}
    >
      {rollable ? (
        <div style={{
          position: "absolute",
          left: 0,
          // An explicit width, not left + right: the faces right-align in
          // this box, and a `right` that goes missing leaves it 0px wide with
          // every face spilling leftward from its edge.
          width: "calc(100% - 4px)",
          top: (SLOT_H - PITCH) / 2,
          height: PITCH,
          transformStyle: "preserve-3d",
          transform: `translateZ(${-RADIUS}px)`,
          pointerEvents: "none",
        }}>
          {faces}
        </div>
      ) : (
        <div style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: "calc(100% - 4px)",
          height: "100%",
          lineHeight: `${SLOT_H}px`,
          textAlign: "right",
          color,
          pointerEvents: "none",
        }}>{label}</div>
      )}
    </div>
  );
});
