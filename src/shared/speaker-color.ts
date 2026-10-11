/**
 * The color a foreign speaker's bubbles wear in a narrative — a hue hashed from
 * its nid, so `claude-4c7289d1` is the same purple in every conversation it
 * joins. That global stability is the feature, and it has one failure: two
 * speakers in the *same* narrative can hash a few degrees apart, and a
 * synthesis between two agents becomes a conversation between two purples.
 *
 * `salt` is the 🎨 Recolor escape hatch. Salt 0 is the palette every narrative
 * has always had (the legacy hash, kept byte-for-byte so nothing already on
 * screen shifts). A nonzero salt reshuffles *per speaker*: the legacy hash is
 * pushed through a nonlinear finalizer, because merely seeding or prefixing the
 * polynomial hash adds the same constant to every equal-length nid — a uniform
 * rotation that leaves two close hues exactly as close as they were.
 *
 * Window-free, like `view-url.ts`, so `src/test/speaker-color.test.ts` can pin
 * it; the salt itself lives in the app's storage (`expo/lib/recolor.ts`).
 */

/** The hash every brane app has used for speaker hues (matches Stolon). Kept
 *  verbatim — including its overflow past int32 on the last character — so
 *  salt 0 reproduces existing colors exactly. */
function legacyHash(speaker: string): number {
  let hash = 0;
  for (let i = 0; i < speaker.length; i++) {
    hash = speaker.charCodeAt(i) + ((hash << 5) - hash);
  }
  return hash;
}

/** MurmurHash3's 32-bit finalizer: every input bit affects every output bit,
 *  which is what makes the reshuffle per speaker rather than per palette. */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h | 0;
}

export function speakerHue(speaker: string, salt = 0): number {
  let hash = legacyHash(speaker);
  if (salt) hash = fmix32(hash ^ Math.imul(salt, 0x9e3779b1));
  return Math.abs(hash) % 360;
}

/** Attribution text: a light pastel. */
export function speakerColor(speaker: string, salt = 0): string {
  return `hsl(${speakerHue(speaker, salt)}, 60%, 80%)`;
}

/** Bubble background: the same hue, dark. */
export function speakerBgColor(speaker: string, salt = 0): string {
  return `hsl(${speakerHue(speaker, salt)}, 30%, 20%)`;
}

/** Where a narrative's salt is kept, per device. */
export function recolorStorageKey(nid: string): string {
  return `brane:recolor:${nid}`;
}

/** Parse a stored salt; anything unreadable is the default palette. */
export function parseRecolorSalt(raw: string | null | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}
