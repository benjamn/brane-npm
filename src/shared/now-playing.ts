/** The jukebox: what each narrative has loaded, and which one is playing.
 *
 *  Playback used to belong to the Files pane that started it, and three
 *  things followed: no other screen could tell anything was playing, a second
 *  copy of the same narrative screen (every navigation is a push) showed
 *  controls wired to nothing, and two panes could play two files at once. So
 *  the player moved out of the pane, into one record for the whole app.
 *
 *  The record is keyed by narrative. A narrative holds at most one track,
 *  with its own position and status, and starting a track anywhere pauses
 *  every other narrative's: one jukebox, many records on the rack, one
 *  needle. A paused track stays loaded, with its controls, until it is
 *  ejected. The browser's `<audio>` elements live in `expo/lib/jukebox.ts`
 *  and feed this store; the list card's row and the Files card both read it.
 *
 *  Pure: no DOM, no timers. Subscriptions are per narrative, so a
 *  `timeupdate` four times a second wakes one card's row and nothing else. */

export interface JukeboxTrack {
  nid: string;
  path: string;
  /** The raw file URL, token included. Identity is `nid` + `path`; the URL is
   *  what the engine loads and may differ between two loads of one file. */
  url: string;
}

export type PlaybackStatus = "loading" | "playing" | "paused" | "ended" | "error";

export interface JukeboxEntry {
  track: JukeboxTrack;
  status: PlaybackStatus;
  /** Seconds into the track. */
  position: number;
  /** Seconds in the track; 0 until the engine knows. */
  duration: number;
}

export function sameTrack(a: JukeboxTrack | null | undefined, b: JukeboxTrack | null | undefined): boolean {
  return !!a && !!b && a.nid === b.nid && a.path === b.path;
}

/** The file's name, for the card row and the OS's now-playing card. */
export function trackTitle(path: string): string {
  return path.split("/").pop() || path;
}

/** Its folder within the fold, shown where a card wants an "artist" line. */
export function trackFolder(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

type Listener = () => void;

export class Jukebox {
  private readonly entries = new Map<string, JukeboxEntry>();
  private readonly byNid = new Map<string, Set<Listener>>();
  private readonly any = new Set<Listener>();

  /** This narrative's loaded track, or null. The same object until it
   *  changes, as `useSyncExternalStore` requires. */
  get(nid: string): JukeboxEntry | null {
    return this.entries.get(nid) ?? null;
  }

  /** The one narrative whose track is playing (or starting), if any. */
  get playing(): string | null {
    for (const [nid, e] of this.entries) if (e.status === "playing" || e.status === "loading") return nid;
    return null;
  }

  /** Narratives with a track loaded, in loading order. */
  nids(): string[] {
    return [...this.entries.keys()];
  }

  subscribe(nid: string, listener: Listener): () => void {
    let set = this.byNid.get(nid);
    if (!set) {
      set = new Set();
      this.byNid.set(nid, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  /** Any change in any narrative: for whatever lists the rack as a whole. */
  subscribeAll(listener: Listener): () => void {
    this.any.add(listener);
    return () => {
      this.any.delete(listener);
    };
  }

  /** A track enters the jukebox, from the start, replacing whatever its
   *  narrative held. Loading is the first step of playing, so every other
   *  narrative's track pauses here, before the engine has a frame. */
  load(track: JukeboxTrack): void {
    this.pauseOthers(track.nid);
    this.set(track.nid, { track, status: "loading", position: 0, duration: 0 });
  }

  /** Ignored for a narrative with nothing loaded: an engine event that trails
   *  an `eject()` (the element's own `pause` as it is emptied) must not
   *  resurrect the entry. `playing` pauses every other narrative's track: the
   *  invariant the engine also enforces on its elements, kept here so a
   *  reader of the store never sees two. */
  setStatus(nid: string, status: PlaybackStatus): void {
    const e = this.entries.get(nid);
    if (!e) return;
    if (status === "playing" || status === "loading") this.pauseOthers(nid);
    if (e.status === status) return;
    this.set(nid, { ...e, status });
  }

  setTime(nid: string, position: number, duration: number): void {
    const e = this.entries.get(nid);
    if (!e) return;
    const p = Number.isFinite(position) && position > 0 ? position : 0;
    const d = Number.isFinite(duration) && duration > 0 ? duration : 0;
    if (e.position === p && e.duration === d) return;
    this.set(nid, { ...e, position: p, duration: d });
  }

  /** The track leaves the jukebox; its row goes with it. */
  eject(nid: string): void {
    if (!this.entries.has(nid)) return;
    this.entries.delete(nid);
    this.wake(nid);
  }

  private pauseOthers(nid: string): void {
    for (const [other, e] of this.entries) {
      if (other !== nid && (e.status === "playing" || e.status === "loading")) {
        this.set(other, { ...e, status: "paused" });
      }
    }
  }

  private set(nid: string, next: JukeboxEntry): void {
    this.entries.set(nid, next);
    this.wake(nid);
  }

  private wake(nid: string): void {
    const set = this.byNid.get(nid);
    if (set) for (const l of set) l();
    for (const l of this.any) l();
  }
}
