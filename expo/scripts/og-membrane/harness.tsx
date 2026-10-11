// Mounts the 膜 alone, at a size the URL asks for, centered on the list
// screen's ground — the page render.mjs screenshots for the link preview
// image and the touch icon. Nothing else is on the page on purpose: the
// card's own title says "brane" under the picture, and a wordmark in the
// image would say it twice.
//
// `?seed=N` makes the frame reproducible: the component draws its terrain
// and schemes from Math.random, so the seed replaces it with mulberry32
// before the component mounts. `?label=text` prints text in a corner, for
// contact sheets; leave it off for the image that ships. `?taps=x,y,t;…`
// taps the glyph at glyph-normalized (x, y) t seconds after mount — two taps
// whose splotches touch commit a new color, which then washes through the
// film — so a frame can be taken mid-invasion (render.mjs --taps).
// @ts-expect-error -- react-dom ships no types in this tree; esbuild bundles this file, tsc only looks at it.
import { createRoot } from "react-dom/client";
import Membrane from "../../components/Membrane.web";

const params = new URLSearchParams(location.search);
const size = Number(params.get("glyph") ?? 480);
const seed = params.get("seed");
if (seed !== null) {
  let a = (Number(seed) >>> 0) || 1;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const style = document.createElement("style");
style.textContent = `html,body{margin:0;background:#121214;width:100%;height:100%;overflow:hidden}
#root{width:100vw;height:100vh;display:flex;align-items:center;justify-content:center}
#root div[role=button]{width:${size}px !important;height:${size}px !important}
#label{position:fixed;left:12px;top:8px;font:bold 28px system-ui,sans-serif;color:#888}`;
document.head.appendChild(style);
const label = params.get("label");
if (label) {
  const el = document.createElement("div");
  el.id = "label";
  el.textContent = label;
  document.body.appendChild(el);
}
// Headless Chromium under --virtual-time-budget runs few or no animation
// frames, so the film never moves and a tap never lands. `?frames=N` takes
// the clock over: performance.now and requestAnimationFrame are replaced
// before the component mounts, and N frames are stepped at 60 fps through a
// setTimeout chain, so the frame after N steps is the same frame every run —
// which is what lets a mid-invasion image be rendered again later.
const FPS = 60;
const frames = params.has("frames") ? Number(params.get("frames")) : 0;
const taps = (params.get("taps") ?? "").split(";").filter(Boolean).map((spec) => {
  const [x, y, t] = spec.split(",").map(Number);
  return { x, y, frame: Math.round(t * FPS) };
});

// Synthetic tap: a press and a release under TAP_MS with no movement, which
// is what the component's pointer handling reads as a tap.
function tapAt(x: number, y: number, release: (fn: () => void) => void) {
  const host = document.querySelector<HTMLElement>("#root div[role=button]");
  if (!host) return;
  const r = host.getBoundingClientRect();
  const init: PointerEventInit = {
    clientX: r.left + (x + 0.5) * r.width, clientY: r.top + (y + 0.5) * r.height,
    pointerId: 1, isPrimary: true, pointerType: "touch", button: 0, buttons: 1, bubbles: true,
  };
  host.dispatchEvent(new PointerEvent("pointerdown", init));
  release(() => host.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 })));
}

if (frames > 0) {
  let now = 0;
  let n = 0;
  const pending: FrameRequestCallback[] = [];
  const releases: (() => void)[] = [];
  performance.now = () => now;
  window.requestAnimationFrame = (cb) => { pending.push(cb); return pending.length; };
  window.cancelAnimationFrame = () => {};
  const tick = () => {
    if (n >= frames) return;
    now += 1000 / FPS;
    for (const fn of releases.splice(0)) fn();
    for (const t of taps) if (t.frame === n) tapAt(t.x, t.y, (fn) => releases.push(fn));
    for (const cb of pending.splice(0)) cb(now);
    n++;
    setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
} else {
  for (const t of taps) setTimeout(() => tapAt(t.x, t.y, (fn) => setTimeout(fn, 40)), (t.frame / FPS) * 1000);
}

createRoot(document.getElementById("root")!).render(<Membrane voice="dormant" />);
