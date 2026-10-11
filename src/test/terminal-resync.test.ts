import { test } from "node:test";
import assert from "node:assert";
import { isResyncDue } from "../daemon/server.js";

// The mirror records what it *sent*, not what the browser *rendered*, and a
// quiet pane never speaks again — so a dropped frame used to persist until the
// operator reloaded the page. The heartbeat is what bounds that to one
// interval; these pin the boundary it turns on.

test("a viewer just sent a frame is not due", () => {
  assert.equal(isResyncDue(1_000, 1_000, 2_000), false);
  assert.equal(isResyncDue(1_000, 2_999, 2_000), false);
});

test("a viewer that has gone an interval without content is due", () => {
  assert.equal(isResyncDue(1_000, 3_000, 2_000), true);
  assert.equal(isResyncDue(1_000, 9_999, 2_000), true);
});

test("a viewer that has never been sent anything is due immediately", () => {
  // `lastSentAt: 0` is the state of a fresh socket and of one whose DOM was
  // just wiped by `refresh`. Both want content on the very next tick, and the
  // sentinel gets that for free against a real epoch clock — which is the only
  // clock the capture loop ever passes.
  assert.equal(isResyncDue(0, 1_787_598_000_000, 2_000), true);
});
