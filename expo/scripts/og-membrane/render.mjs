// Renders the link preview image (public/og/membrane.v<N>.png, 1200×630) and
// the touch icon (public/apple-touch-icon.png, 180×180) from the real
// Membrane component, so the card shows the same film the app does rather
// than a hand-ported approximation of its shader.
//
//   node scripts/og-membrane/render.mjs [outdir] [--seed N] [--frames N] [--taps x,y,t;…] [--sheet A-B]
//   (from expo/)
//
// With --seed the frame is reproducible (the harness replaces Math.random),
// so the seed that shipped can be rendered again after a change to the
// component. --frames N steps the film N frames at 60 fps on a clock the
// harness owns — headless Chromium runs no animation frames of its own under
// --virtual-time-budget — and --taps plants taps at glyph-normalized (x, y)
// t seconds in, so a frame can be taken mid-invasion: two taps whose
// splotches touch commit a new color, which washes up through the glyph over
// the next few seconds. --sheet renders seeds A..B labeled, for choosing.
//
// Needs a headless Chromium with WebGL. Playwright's `chrome-headless-shell`
// is what this was written against; point BRANE_HEADLESS_CHROME at any
// Chromium binary that takes --screenshot. Every run rolls a fresh color
// scheme — the component seeds from Math.random — so run it a few times and
// keep the frame you like (or find its seed with --sheet and pin it), then bump the version in the filename and in the
// two og:image tags (public/index.html, app/+html.tsx): iMessage caches a
// preview by URL, and a same-named image would never reach a phone that has
// already seen the old one.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const expoRoot = resolve(here, "..", "..");
const repoRoot = resolve(expoRoot, "..");
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const seed = flag("--seed");
const frames = flag("--frames");
const taps = flag("--taps");
const sheet = flag("--sheet");
const outDir = resolve(args[0] ?? join(tmpdir(), "brane-og"));
mkdirSync(outDir, { recursive: true });

const chrome =
  process.env.BRANE_HEADLESS_CHROME ??
  [
    `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
  ].find(existsSync);
if (!chrome) {
  console.error("No headless Chromium found; set BRANE_HEADLESS_CHROME to a binary that takes --screenshot.");
  process.exit(1);
}

/** Glyph size in the 1200×630 card. 560 leaves a 35 px margin top and bottom. */
const GLYPH = 560;

const work = mkdtempSync(join(tmpdir(), "og-membrane-"));
execFileSync(
  join(repoRoot, "node_modules", ".bin", "esbuild"),
  [
    join(here, "harness.tsx"),
    "--bundle",
    `--outfile=${join(work, "bundle.js")}`,
    "--format=iife",
    "--jsx=automatic",
    `--alias:@shared=${join(repoRoot, "src", "shared")}`,
    '--define:process.env.NODE_ENV="production"',
    "--log-level=warning",
  ],
  { stdio: "inherit", env: { ...process.env, NODE_PATH: join(expoRoot, "node_modules") } },
);
writeFileSync(
  join(work, "index.html"),
  '<!doctype html><html><head><meta charset="utf-8"><title>og</title></head><body><div id="root"></div><script src="bundle.js"></script></body></html>',
);

function shoot(name, width, height, glyph, query = "") {
  const out = join(outDir, name);
  execFileSync(
    chrome,
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--hide-scrollbars",
      `--window-size=${width},${height}`,
      "--force-device-scale-factor=1",
      "--virtual-time-budget=4000",
      `--screenshot=${out}`,
      `file://${join(work, "index.html")}?glyph=${glyph}${query}`,
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  console.log(out);
}

const film = (frames ? `&frames=${frames}` : "") + (taps ? `&taps=${encodeURIComponent(taps)}` : "");
if (sheet) {
  const [a, b] = sheet.split("-").map(Number);
  for (let n = a; n <= b; n++) {
    shoot(`seed-${String(n).padStart(3, "0")}.png`, 1200, 630, GLYPH, `&seed=${n}&label=${n}${film}`);
  }
} else {
  const q = (seed !== undefined ? `&seed=${seed}` : "") + film;
  shoot("membrane.png", 1200, 630, GLYPH, q);
  shoot("apple-touch-icon.png", 180, 180, 156, q);
}
