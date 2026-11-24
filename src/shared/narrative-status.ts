/**
 * The awaiting glow: how a narrative whose agent is parked waiting for
 * direction — a blocking `listen`, or a `narrate({ wait: true })` — shows it.
 *
 * It is deliberately not a status word. LIVE / IDLE / DEAD say what the
 * session is; the glow says the agent is waiting on you, and it lights the
 * whole row (list card, switcher row, narrative header) from the inside, the
 * way padding would sit, so nothing moves when it comes and goes.
 *
 * The hue is allocated per device (`src/shared/glow-hues.ts`): chosen once,
 * as far as it can be from the hues of the other recently glowing narratives,
 * then kept, so the operator can learn sessions by color. 🎨 Recolor moves it
 * to a random hue still clear of the others.
 *
 * A daemon's row in the brane switcher wears the glows of the narratives
 * awaiting on it (`multiAwaitingGlow`): one narrative, its ring, in its own
 * hue; several, the rim split by edge, one hue each. `GET /api/status` lists
 * them as `awaiting`, and the row counts them as the undead (docs/sleep.md).
 *
 * The fact comes from the daemon's `awaiting` bit (src/daemon/awaiting.ts).
 * It is only honoured while bridged: a parked call cannot outlive its socket,
 * so an unbridged narrative claiming it is a stale client-side value.
 */

export function isAwaiting({ mcpConnected, awaiting }: { mcpConnected?: boolean | null; awaiting?: boolean | null }): boolean {
  return !!mcpConnected && !!awaiting;
}

/** An inset-only `box-shadow`, all glow and no line: every layer is blurred,
 *  none is a solid edge. Inset shadows take no layout space and never spill
 *  onto neighbours.
 *
 *  Near-opaque at the rim, fading inward. The hue is what tells sessions
 *  apart, and translucency over a dark row mixes it toward the background:
 *  the first version peaked at 0.45 alpha, and hues a quarter turn apart
 *  read as the same dim tint. OKLCH rather than HSL because equal HSL
 *  lightness is not equal brightness — yellow and cyan glared while blue and
 *  violet sank — so each layer holds lightness and chroma fixed and only the
 *  hue varies. */
export function awaitingGlow(h: number): string {
  return [
    `inset 0 0 3px 1px oklch(0.78 0.16 ${h} / 0.95)`,
    `inset 0 0 18px 2px oklch(0.74 0.15 ${h} / 0.55)`,
    `inset 0 0 40px 4px oklch(0.7 0.14 ${h} / 0.28)`,
    // The top edge reads a pixel thinner than the bottom, which has the
    // tab bar's hairline under it. A one-sided copy of the first layer
    // thickens the top alone: the negative spread grows the shadow's hole
    // past every edge, and the offset pulls it back to 1px below the top.
    `inset 0 4px 3px -3px oklch(0.78 0.16 ${h} / 0.95)`,
  ].join(", ");
}

/** The daemon reports the bit's edges as their own control message,
 *  `{ type: "awaiting", narrative, awaiting }` — never as a `status`, which an
 *  older app would read as the narrative's lifecycle status. Inside the app the
 *  root layout forwards them to the status listeners as these two words, so a
 *  screen needs one subscription for everything a row depends on. */
export const AWAITING_STATUS = "awaiting";
export const NOT_AWAITING_STATUS = "not_awaiting";

/** The ring's three centred layers as (offset, blur) pairs for one edge:
 *  offset o, blur b and spread -b put the hole's near edge o - b inside the
 *  box, the ring's spread (1, 2, 4), and the other three sides -b past the
 *  box, out of the blur's reach, exactly as the ring's one-sided top layer
 *  does. Lightness, chroma and alpha are the ring's. */
const EDGE_LAYERS: Array<[offset: number, blur: number, l: number, c: number, a: number]> = [
  [4, 3, 0.78, 0.16, 0.95],
  [20, 18, 0.74, 0.15, 0.55],
  [44, 40, 0.7, 0.14, 0.28],
];

/** Top, bottom, left, right: the order edges take hues. A switcher row is
 *  wide and short, so the long edges go first and two hues read as two bands. */
const EDGES: Array<[dx: number, dy: number]> = [[0, 1], [0, -1], [1, 0], [-1, 0]];

/** How many hues one row can wear at once before the edges run out. */
export const GLOW_EDGES = EDGES.length;

/** The glow of several awaiting narratives on one row — a daemon's in the
 *  brane switcher. One hue is {@link awaitingGlow}, the same ring the
 *  narrative's own card wears. Two or more split the rim by edge, each edge
 *  in one narrative's hue, so the colors and the count read together; past
 *  {@link GLOW_EDGES} the edges run out, and the row's text carries the
 *  count. Undefined for no hues, so the style can be spread in. */
export function multiAwaitingGlow(hues: number[]): string | undefined {
  if (hues.length === 0) return undefined;
  if (hues.length === 1) return awaitingGlow(hues[0]);
  const px = (n: number) => (n === 0 ? "0" : `${n}px`);
  const layers: string[] = [];
  hues.slice(0, EDGES.length).forEach((h, i) => {
    const [dx, dy] = EDGES[i];
    for (const [o, b, l, c, a] of EDGE_LAYERS) {
      layers.push(`inset ${px(dx * o)} ${px(dy * o)} ${b}px -${b}px oklch(${l} ${c} ${h} / ${a})`);
    }
  });
  return layers.join(", ");
}
