import { test } from "node:test";
import assert from "node:assert/strict";
import { sgrMouseSequences } from "../tmux.js";

// A viewer's `mouse` message becomes SGR sequences typed into the pane with
// `send-keys -l`. Every field is interpolated into that sequence, so each is
// checked first: a string `x` was once concatenated as-is, which made a free
// `mouse` message a keyboard (claude-vxnhxcg9:6, finding 2).

test("a click is a press then a release, 1-indexed", () => {
  assert.deepEqual(sgrMouseSequences({ x: 0, y: 0 }), ["\x1b[<0;1;1M", "\x1b[<0;1;1m"]);
  assert.deepEqual(sgrMouseSequences({ x: 9, y: 4, button: 2, action: "click" }), ["\x1b[<2;10;5M", "\x1b[<2;10;5m"]);
});

test("each action maps to its SGR form", () => {
  assert.deepEqual(sgrMouseSequences({ x: 1, y: 1, action: "down" }), ["\x1b[<0;2;2M"]);
  assert.deepEqual(sgrMouseSequences({ x: 1, y: 1, action: "up" }), ["\x1b[<0;2;2m"]);
  assert.deepEqual(sgrMouseSequences({ x: 1, y: 1, button: 1, action: "drag" }), ["\x1b[<33;2;2M"]);
  assert.deepEqual(sgrMouseSequences({ x: 1, y: 1, action: "scroll_up" }), ["\x1b[<64;2;2M"]);
  assert.deepEqual(sgrMouseSequences({ x: 1, y: 1, action: "scroll_down" }), ["\x1b[<65;2;2M"]);
});

test("a field that is not a non-negative integer sends nothing", () => {
  const injected = "\rtouch /tmp/x\r";
  for (const bad of [
    { x: injected, y: 0 },
    { x: 0, y: injected },
    { x: 0, y: 0, button: injected },
    { x: "3", y: 4 },
    { x: 1.5, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 100000 },
    { y: 0 },
    { x: 0 },
    {},
    null,
    undefined,
    "click",
    [0, 0],
  ]) {
    assert.deepEqual(sgrMouseSequences(bad), [], JSON.stringify(bad));
  }
});

test("an action the viewer does not send sends nothing", () => {
  assert.deepEqual(sgrMouseSequences({ x: 0, y: 0, action: "\rls\r" }), []);
  assert.deepEqual(sgrMouseSequences({ x: 0, y: 0, action: 7 }), []);
});

test("no sequence ever carries anything but digits and the SGR frame", () => {
  for (const seq of sgrMouseSequences({ x: 12, y: 34, button: 1, action: "drag" })) {
    assert.match(seq, /^\x1b\[<\d+;\d+;\d+[Mm]$/);
  }
});
