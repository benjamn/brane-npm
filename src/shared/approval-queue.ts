/**
 * The order the app walks pending protocol files in, when a fold or home
 * has several awaiting approval (docs/protocols.md#approval).
 *
 * The queue is fixed when the reader opens: the paths the chat's banner
 * counted. Each is then settled one way or another, and the reader shows the
 * first that isn't. Approving one moves straight to the next; skipping one
 * leaves it pending and moves on, so a file the operator doesn't want can't
 * block the ones behind it. Pure, so the stepping is pinned by
 * `src/test/approval-queue.test.ts` rather than by a browser.
 */

/** What became of a queued file: the operator approved it, passed over it
 *  (it stays pending), or it stopped awaiting approval by itself (approved
 *  elsewhere, or removed) and there is nothing to show. */
export type Settled = "approved" | "skipped" | "gone";

export interface ApprovalStep {
  /** The file to show now, or null when every one is settled. */
  path: string | null;
  /** 1-based place of `path` in the queue; the queue's length when done. */
  position: number;
  total: number;
  approved: number;
  skipped: number;
}

export function approvalStep(order: readonly string[], settled: ReadonlyMap<string, Settled>): ApprovalStep {
  const index = order.findIndex((p) => !settled.has(p));
  const count = (what: Settled) => order.filter((p) => settled.get(p) === what).length;
  return {
    path: index < 0 ? null : order[index],
    position: index < 0 ? order.length : index + 1,
    total: order.length,
    approved: count("approved"),
    skipped: count("skipped"),
  };
}

/** How long Approve stays disabled after a file appears. The next file
 *  lands under the finger that just approved the last one, so without this a
 *  double tap approves text nobody has read. */
export const APPROVE_GUARD_MS = 800;

/** Whether Approve is still held back for a file shown at `shownAt`. */
export function approveGuarded(shownAt: number, now: number): boolean {
  return now - shownAt < APPROVE_GUARD_MS;
}

/** What the reader says once the queue is done. */
export function approvalSummary(step: ApprovalStep): string {
  const parts: string[] = [];
  if (step.approved > 0) {
    parts.push(`Approved ${step.approved === 1 ? "1 file" : `${step.approved} files`}. Agents follow that text until it changes.`);
  }
  if (step.skipped > 0) {
    parts.push(`${step.skipped === 1 ? "1 file is" : `${step.skipped} files are`} still pending: agents ignore ${step.skipped === 1 ? "it" : "them"} until you approve ${step.skipped === 1 ? "it" : "them"}.`);
  }
  return parts.length > 0 ? parts.join(" ") : "Nothing here awaits approval any more.";
}
