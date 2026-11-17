/**
 * What the 膜 says, in the caption under it.
 *
 * `expo/components/MembraneEmpty.web.tsx` shows one of these under the glyph
 * whenever the glyph is shown — under an empty list and under a full one —
 * and a tap on the glyph swaps it for another. Nothing else changes it, so
 * it can be read at leisure, links and all. Each line is markdown, rendered
 * by the app's own renderer. Two kinds, mixed and worn alike: a quip is a
 * joke at the glyph's own expense (it is, after all, a fragment shader
 * running full-time under an empty list), and a tip is the loading-screen
 * filler of a video game — one true thing about brane the operator may not
 * have found yet. Every tip states something the app or CLI actually does;
 * a tip that stops being true should be removed rather than left to
 * mislead. Brevity is the operator's rule: aim
 * for one sentence, with no terminal period (claude-nusb6rnr:7).
 *
 * The order is one shuffle per page load, then a fixed loop through it
 * (`QuipLoop`): every line once before any line twice, and the same order
 * every time round. Randomness is passed in so a test can pin it.
 */

export const MEMBRANE_QUIPS: readonly string[] = [
  // ── quips ──────────────────────────────────────────────────────────────
  "I noticed you were not using your GPU",
  "I am the opposite of load-bearing",
  "膜 is pronounced mó",
  "My Kolmogorov complexity is actually quite low",
  "Covert side-channel? Takes one to know one",
  "Abstract impressionism? No: abstract procedural noise",
  "Drag me around a little",
  "Do you know where your children are running shader programs?",
  "No human art was digested in the making of whatever this is",
  "Too many taps and the paradigm could shift",
  "Bet you wish your phosphenes were lit like me",
  "If this be a prisoner's cinema, then who be the prisoners?",
  "Do not fall in love with any particular color scheme",
  "All these colors will be lost in time, like tears in rain",

  // ── tips ───────────────────────────────────────────────────────────────
  "Agent stop working? Feed it something from the 🥫 menu",
  "What was that terminal shortcut? Maybe it's in the 🦾 menu",
  "Agents glow when actively awaiting your chat input",
  "@-mention any agent by NID (narrative ID) to summon them",
  "Ask your agent about rendering mermaid diagrams",
  "Go ahead and install [Tailscale](https://tailscale.com/) (it's free)",
  "Command your own daemon: `npm install -g brane`",
  "See what's ingestible: `brane absorb survey`",
  "Have YOU read the /LIVE_loop protocol?",
  "Your daemon from any device: `brane meld` and prosper 🖖",
  "Fork tangential narratives with 🧬 Twin in the 🦠 menu",
];

/** A uniformly random permutation of `list` (Fisher–Yates); `list` is left alone. */
export function shuffled<T>(list: readonly T[], rand: () => number = Math.random): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rand() * (i + 1)));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** One shuffle of the lines, walked in a loop: `current` is the line showing,
 *  `next` steps to the one after it, back to the first after the last. */
export class QuipLoop {
  private readonly order: readonly string[];
  private at = 0;

  constructor(list: readonly string[] = MEMBRANE_QUIPS, rand: () => number = Math.random) {
    if (list.length === 0) throw new Error("no quips");
    this.order = shuffled(list, rand);
  }

  current(): string {
    return this.order[this.at];
  }

  next(): string {
    this.at = (this.at + 1) % this.order.length;
    return this.current();
  }
}
