/**
 * The lightbox's gallery: which images sit either side of the one open.
 *
 * Tapping a chat image opens it full-screen, and from there the operator
 * steps to its neighbors without closing. "Neighbors" means every inline
 * payload in the chat's loaded events, in the order the chat shows them —
 * oldest first, and within a message in the order its thumbnails are laid
 * out — so the sequence carries straight across message boundaries. Older
 * history paged in while the lightbox is open simply lengthens the list.
 *
 * Pure, so the stepping rules are pinned by `src/test/lightbox-gallery.test.ts`
 * rather than by a browser.
 */

import { isInlinePayload } from "./payload-inline.js";

/** The slice of an event the gallery reads. */
export interface GalleryEvent {
  payloads?: string[] | null;
}

/** Every inline (image) payload path in `events`, in display order: the
 *  same filter `MessageBubble` applies to decide what is a thumbnail. */
export function galleryPaths(events: readonly GalleryEvent[]): string[] {
  const paths: string[] = [];
  for (const event of events) {
    if (!event.payloads) continue;
    for (const path of event.payloads) {
      if (isInlinePayload(path)) paths.push(path);
    }
  }
  return paths;
}

/** Where `current` sits in `gallery`, and what lies either side of it.
 *  `index` is -1 when `current` isn't in the gallery at all (an image opened
 *  from the Files view, say), and then there is nowhere to step. No
 *  wrap-around: the first image has no `prev` and the last no `next`, so the
 *  ends of the chat read as ends. */
export function galleryPosition<T>(
  gallery: readonly T[],
  current: T,
): { index: number; count: number; prev: T | null; next: T | null } {
  const index = gallery.indexOf(current);
  if (index < 0) return { index, count: gallery.length, prev: null, next: null };
  return {
    index,
    count: gallery.length,
    prev: index > 0 ? gallery[index - 1] : null,
    next: index < gallery.length - 1 ? gallery[index + 1] : null,
  };
}

/** How far a touch must travel sideways before it is a swipe, in px. */
export const SWIPE_MIN_DX = 50;

/** A swipe must be this many times wider than it is tall, so a vertical
 *  drag (or a sloppy tap) never turns the page. */
export const SWIPE_AXIS_RATIO = 1.5;

/** Below this much travel a touch is still a tap, and closes the lightbox;
 *  above it the touch was a drag, and must not also close it. */
export const TAP_SLOP = 10;

/** Which way a finished touch steps the gallery: -1 for the previous image
 *  (finger moved right, as a page turns), +1 for the next (finger moved
 *  left), 0 when it wasn't a horizontal swipe. */
export function swipeStep(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < SWIPE_MIN_DX) return 0;
  if (Math.abs(dx) < Math.abs(dy) * SWIPE_AXIS_RATIO) return 0;
  return dx > 0 ? -1 : 1;
}

/** Which way a key steps the gallery: ← and → only. Anything else is 0 and
 *  is left alone, so Esc still reaches the modal's own close handling. */
export function keyStep(key: string): -1 | 0 | 1 {
  if (key === "ArrowLeft") return -1;
  if (key === "ArrowRight") return 1;
  return 0;
}
