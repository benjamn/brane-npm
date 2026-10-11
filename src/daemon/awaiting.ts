/**
 * Which narratives are parked waiting for direction.
 *
 * An agent that has gone back to a blocking `listen` — or to a
 * `narrate({ wait: true })`, which parks through the same machinery — is, as
 * a rule, done with what it was doing and waiting to be told what next. The
 * daemon holds that fact exactly: the call sits in its bridge's
 * `pendingListens` until something resolves it. This turns the parks and
 * resolutions into one boolean per narrative, and reports its edges.
 *
 * The boolean means "a call is parked right now", and every way a call ends
 * clears it: `delivered` (the agent has something to act on), `closed` (its
 * bridge is gone), `cancelled` (the harness abandoned the call: Esc, a killed
 * task) and `timeout`. A timeout clears it too, though the agent will usually
 * park again a model turn later. The glow goes out for that turn, and that is
 * accurate: the agent is re-reading its context, not hanging on the operator's
 * next word. (A 120 s grace used to hold it on across the gap; it made the
 * glow a guess exactly when the agent had left the loop at the timeout.)
 *
 * Counted per narrative, not per call: a narrative can have more than one
 * bridge (a reconnect, a subagent's), and it is awaiting while any of them
 * holds a parked call.
 */

export type AwaitingEnding = "delivered" | "timeout" | "closed" | "cancelled";

export class AwaitingTracker {
  private readonly parkedCount = new Map<string, number>();

  constructor(private readonly emit: (nid: string, awaiting: boolean) => void) {}

  isAwaiting(nid: string): boolean {
    return (this.parkedCount.get(nid) ?? 0) > 0;
  }

  /** A blocking call parked for this narrative. */
  parked(nid: string): void {
    const count = this.parkedCount.get(nid) ?? 0;
    this.parkedCount.set(nid, count + 1);
    if (count === 0) this.emit(nid, true);
  }

  /** A parked call for this narrative stopped waiting. The ending no longer
   *  changes what happens; it is kept so every call site says why. */
  resolved(nid: string, _ending: AwaitingEnding): void {
    const count = this.parkedCount.get(nid) ?? 0;
    if (count === 0) return; // not one we saw park; nothing to undo
    if (count > 1) {
      this.parkedCount.set(nid, count - 1);
      return;
    }
    this.parkedCount.delete(nid);
    this.emit(nid, false);
  }
}
