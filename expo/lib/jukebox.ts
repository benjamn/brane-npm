/** The jukebox's engine: the browser's `<audio>` elements behind the store in
 *  `@shared/now-playing`, and the hooks that read it.
 *
 *  One element per narrative that holds a track, none of them in any screen:
 *  a detached element plays the same, and nothing a screen does (a pane
 *  switch, a push, Back) can unmount it. Starting one pauses the others, so
 *  the elements agree with the store's one-playing rule. A paused element
 *  keeps its place and its buffer, which is what makes resuming a track
 *  instant and scrubbing it while paused possible.
 *
 *  `playTrack` and `toggleTrack` are called from the gesture handler itself:
 *  iOS allows `play()` only inside a user gesture's call stack. */
import { useCallback, useSyncExternalStore } from "react";
import {
  Jukebox,
  type JukeboxEntry,
  type JukeboxTrack,
  sameTrack,
  trackFolder,
  trackTitle,
} from "@shared/now-playing";

export const jukebox = new Jukebox();

const elements = new Map<string, HTMLAudioElement>();

function wire(nid: string, el: HTMLAudioElement): void {
  const time = () => jukebox.setTime(nid, el.currentTime, el.duration);
  el.addEventListener("loadedmetadata", time);
  el.addEventListener("durationchange", time);
  el.addEventListener("timeupdate", time);
  el.addEventListener("seeked", time);
  // `play` fires on the call, `playing` once frames arrive; both count as
  // the active track, so the others pause before the first frame.
  el.addEventListener("play", () => jukebox.setStatus(nid, "loading"));
  el.addEventListener("playing", () => jukebox.setStatus(nid, "playing"));
  el.addEventListener("waiting", () => jukebox.setStatus(nid, "loading"));
  // The element pauses itself at the end, before `ended` fires; that pause
  // is not a pause.
  el.addEventListener("pause", () => { if (!el.ended) jukebox.setStatus(nid, "paused"); });
  el.addEventListener("ended", () => { time(); jukebox.setStatus(nid, "ended"); });
  el.addEventListener("error", () => jukebox.setStatus(nid, "error"));
}

function elementFor(nid: string): HTMLAudioElement | null {
  if (typeof document === "undefined") return null;
  let el = elements.get(nid);
  if (!el) {
    el = document.createElement("audio");
    el.preload = "metadata";
    wire(nid, el);
    elements.set(nid, el);
  }
  return el;
}

function pauseOthers(nid: string): void {
  for (const [other, el] of elements) if (other !== nid && !el.paused) el.pause();
}

function start(nid: string, el: HTMLAudioElement): void {
  pauseOthers(nid);
  announce(nid);
  el.play().catch((err: unknown) => {
    // A play interrupted by a pause or a new load is not a failure.
    if ((err as { name?: string } | null)?.name === "AbortError") return;
    jukebox.setStatus(nid, "error");
  });
}

/** A tap on a file's dial: toggles if this narrative already holds the file,
 *  otherwise loads it in the narrative's slot, replacing what was there. */
export function playTrack(track: JukeboxTrack): void {
  const el = elementFor(track.nid);
  if (!el) return;
  const held = jukebox.get(track.nid);
  if (held && sameTrack(held.track, track)) {
    toggleTrack(track.nid);
    return;
  }
  jukebox.load(track);
  el.src = track.url;
  start(track.nid, el);
}

export function toggleTrack(nid: string): void {
  const el = elements.get(nid);
  if (!el || !jukebox.get(nid)) return;
  if (el.paused) start(nid, el);
  else el.pause();
}

export function seekTrack(nid: string, seconds: number): void {
  const el = elements.get(nid);
  const held = jukebox.get(nid);
  if (!el || !held) return;
  const t = Math.max(0, held.duration > 0 ? Math.min(seconds, held.duration) : seconds);
  el.currentTime = t;
  // The element's own `seeked` follows; saying it now keeps the dial from
  // snapping back to the old position for a frame.
  jukebox.setTime(nid, t, held.duration);
}

/** The track leaves the jukebox. The store forgets it first, so the
 *  element's trailing `pause` and `emptied` land on nothing. */
export function ejectTrack(nid: string): void {
  jukebox.eject(nid);
  const el = elements.get(nid);
  if (el) {
    el.pause();
    el.removeAttribute("src");
    el.load();
  }
  if (jukebox.playing === null) announce(null);
}

/** The OS's now-playing card and the earbuds' buttons follow whichever track
 *  started last. Where the API is missing, the element plays without it. */
function announce(nid: string | null): void {
  const session = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
  if (!session) return;
  try {
    if (nid === null) {
      session.metadata = null;
      return;
    }
    const held = jukebox.get(nid);
    if (!held) return;
    session.metadata = new MediaMetadata({
      title: trackTitle(held.track.path),
      artist: trackFolder(held.track.path) || nid,
      album: nid,
    });
    session.setActionHandler("play", () => {
      const el = elements.get(nid);
      if (el && el.paused) toggleTrack(nid);
    });
    session.setActionHandler("pause", () => {
      const el = elements.get(nid);
      if (el && !el.paused) el.pause();
    });
    session.setActionHandler("seekto", (d) => {
      if (typeof d.seekTime === "number") seekTrack(nid, d.seekTime);
    });
  } catch {
    // An older WebKit without MediaMetadata or one of the actions.
  }
}

/** This narrative's slot on the jukebox, live. Subscribed per narrative, so a
 *  `timeupdate` wakes this card's row and no other. */
export function useJukeboxEntry(nid: string): JukeboxEntry | null {
  const subscribe = useCallback((fn: () => void) => jukebox.subscribe(nid, fn), [nid]);
  const get = useCallback(() => jukebox.get(nid), [nid]);
  return useSyncExternalStore(subscribe, get, get);
}
