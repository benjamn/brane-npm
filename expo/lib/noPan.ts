import { Platform } from "react-native";
import { TAP_FOCUS_GRACE_MS, TAP_SLOP_PX, dragAllowed, isTextEntry, layoutHeight, mustBlur, scrollBoxOf, type ScrollBox } from "@shared/no-pan";

/** Keep iOS from moving the page under the app — the rules and the why are
 *  in `@shared/no-pan`; this is the DOM half. Installed once, at module
 *  evaluation, so it is in place before the first tap. */
let installed = false;

export function installNoPan(): void {
  if (installed || Platform.OS !== "web" || typeof window === "undefined") return;
  installed = true;
  const vv = window.visualViewport;
  const docEl = document.documentElement;

  // The layout is the visible area: with the keyboard up, #root ends where
  // the keyboard starts, so a bottom bar sits on it with nothing moved.
  let height: number | null = null;
  const fit = () => {
    if (!vv) return;
    const h = layoutHeight(vv.height, vv.scale, height);
    if (h === null || h === height) return;
    height = h;
    docEl.style.setProperty("--brane-vvh", `${h}px`);
  };
  if (vv) {
    vv.addEventListener("resize", fit);
    fit();
  }

  // The keyboard takes more than this off the visible area; a collapsing
  // address bar or a toolbar never does.
  // Keyboard height is what the visible area lost, whether or not the page is
  // panned: a pan moves the visible area (offsetTop) without resizing it, so
  // subtracting offsetTop would read a panned page as keyboard-down, and the
  // invariant below would blur a field mid-typing (claude-3j4583pl:184).
  const keyboardUp = () => !!vv && window.innerHeight - vv.height > 120;

  // The invariant (see mustBlur): no text field is focused while the soft
  // keyboard is down. Checked when the visible area changes and shortly
  // after any focus, whoever made it, so no path — a swipe-away, a refocus
  // from code, an autofocus on load, one not written yet — can leave a field
  // whose next tap raises the keyboard natively.
  const touch = !window.matchMedia?.("(pointer: fine)").matches;
  let lastTapFocus = 0;
  const enforce = () => {
    const el = document.activeElement as HTMLElement | null;
    if (mustBlur({
      touch,
      textEntryFocused: !!el && isTextEntry(el as HTMLInputElement),
      keyboardUp: keyboardUp(),
      msSinceTapFocus: Date.now() - lastTapFocus,
    })) el?.blur();
  };
  if (vv) vv.addEventListener("resize", enforce);
  document.addEventListener("focusin", () => {
    setTimeout(enforce, TAP_FOCUS_GRACE_MS + 50);
  }, true);

  const zoomed = () => !!vv && Math.abs(vv.scale - 1) > 0.01;
  let startX = 0;
  let startY = 0;
  let moved = false;
  let multi = false;

  document.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    moved = false;
    multi = e.touches.length > 1;
  }, { passive: true, capture: true });

  // The drag pan: a vertical drag nothing under the finger can take would
  // pan the page. Pinches and a zoomed-in pan are the reader's, and pass.
  document.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (Math.abs(dx) > TAP_SLOP_PX || Math.abs(dy) > TAP_SLOP_PX) moved = true;
    if (multi || e.touches.length > 1 || zoomed()) return;
    const chain: ScrollBox[] = [];
    for (let el = e.target as Element | null; el && el !== document.body; el = el.parentElement) {
      const cs = getComputedStyle(el);
      chain.push(scrollBoxOf({
        overflowY: cs.overflowY,
        reversed: cs.display.includes("flex") && cs.flexDirection === "column-reverse",
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      }));
    }
    if (!dragAllowed(dx, dy, chain)) e.preventDefault();
  }, { passive: false, capture: true });

  // The focus pan: a tap on a text field focuses it ourselves, with
  // preventScroll, inside the tap so iOS still raises the keyboard. An
  // already-focused field is left alone, so taps move the caret as usual.
  document.addEventListener("touchend", (e) => {
    if (moved || multi) return;
    const target = (e.target as Element | null)?.closest?.("input, textarea, [contenteditable]") as HTMLElement | null;
    if (!target || target === document.activeElement) return;
    if (!isTextEntry(target as HTMLInputElement)) return;
    e.preventDefault();
    lastTapFocus = Date.now();
    target.focus({ preventScroll: true });
  }, { passive: false, capture: true });
}
