/**
 * The app's walk through several pending protocol files
 * (src/shared/approval-queue.ts): which file shows next, the count, the
 * double-tap guard, and what it says at the end.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { APPROVE_GUARD_MS, approvalStep, approvalSummary, approveGuarded, type Settled } from "../shared/approval-queue.js";

const ORDER = ["~/.brane/protocols/a.md", "~/dev/foo/.brane/protocols/b.md", "~/dev/foo/.brane/protocols/c.md"];
const settled = (entries: Array<[string, Settled]>) => new Map(entries);

describe("approvalStep", () => {
  it("starts on the first file and counts the queue", () => {
    assert.deepEqual(approvalStep(ORDER, settled([])), { path: ORDER[0], position: 1, total: 3, approved: 0, skipped: 0 });
  });

  it("approving one moves straight to the next", () => {
    const step = approvalStep(ORDER, settled([[ORDER[0], "approved"]]));
    assert.equal(step.path, ORDER[1]);
    assert.equal(step.position, 2);
    assert.equal(step.approved, 1);
  });

  it("a skipped file doesn't block the ones behind it, and is counted as still pending", () => {
    const step = approvalStep(ORDER, settled([[ORDER[0], "skipped"]]));
    assert.equal(step.path, ORDER[1]);
    assert.equal(step.skipped, 1);
    assert.equal(step.approved, 0);
  });

  it("a file that stopped awaiting approval by itself is passed over without counting as either", () => {
    const step = approvalStep(ORDER, settled([[ORDER[0], "gone"], [ORDER[1], "approved"]]));
    assert.deepEqual(step, { path: ORDER[2], position: 3, total: 3, approved: 1, skipped: 0 });
  });

  it("is done when every file is settled, and for an empty queue", () => {
    const done = approvalStep(ORDER, settled([[ORDER[0], "approved"], [ORDER[1], "skipped"], [ORDER[2], "approved"]]));
    assert.deepEqual(done, { path: null, position: 3, total: 3, approved: 2, skipped: 1 });
    assert.equal(approvalStep([], settled([])).path, null);
  });
});

describe("approveGuarded", () => {
  it("holds Approve back just after a file appears, so a double tap can't approve the next one unread", () => {
    assert.equal(approveGuarded(1000, 1000), true);
    assert.equal(approveGuarded(1000, 1000 + APPROVE_GUARD_MS - 1), true);
    assert.equal(approveGuarded(1000, 1000 + APPROVE_GUARD_MS), false);
  });
});

describe("approvalSummary", () => {
  const step = (approved: number, skipped: number) => ({ path: null, position: approved + skipped, total: approved + skipped, approved, skipped });

  it("says what was approved, and that skipped files are still ignored", () => {
    assert.equal(approvalSummary(step(1, 0)), "Approved 1 file. Agents follow that text until it changes.");
    assert.equal(
      approvalSummary(step(2, 1)),
      "Approved 2 files. Agents follow that text until it changes. 1 file is still pending: agents ignore it until you approve it.",
    );
    assert.equal(approvalSummary(step(0, 2)), "2 files are still pending: agents ignore them until you approve them.");
  });

  it("says so when nothing was left to decide", () => {
    assert.equal(approvalSummary(step(0, 0)), "Nothing here awaits approval any more.");
  });
});
