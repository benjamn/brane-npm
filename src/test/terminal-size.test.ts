import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTerminalSize, newSessionLine } from "../tmux.js";

// The grid a spawn or run request carries: the size the requesting viewer's
// pane last measured, so the session starts at the width it will be watched at
// and a TUI's launch screen isn't redrawn — and left in scrollback — at each
// width it is resized through.

test("parseTerminalSize accepts a positive integer grid", () => {
  assert.deepEqual(parseTerminalSize({ cols: 80, rows: 24 }), { cols: 80, rows: 24 });
});

test("parseTerminalSize drops extra fields", () => {
  assert.deepEqual(parseTerminalSize({ cols: 120, rows: 40, dpr: 2 }), { cols: 120, rows: 40 });
});

test("parseTerminalSize rejects anything that isn't a usable grid", () => {
  for (const bad of [
    undefined,
    null,
    "80x24",
    [80, 24],
    {},
    { cols: 80 },
    { cols: 0, rows: 24 },
    { cols: 80, rows: -1 },
    { cols: 80.5, rows: 24 },
    { cols: "80", rows: "24" },
    { cols: 80, rows: 100000 },
  ]) {
    assert.equal(parseTerminalSize(bad), null, JSON.stringify(bad));
  }
});

test("a parsed size reaches new-session as -x/-y", () => {
  const size = parseTerminalSize({ cols: 93, rows: 41 });
  const line = newSessionLine({ name: "claude-abc", cwd: "/tmp", size, command: "claude" });
  assert.match(line, / -x 93 -y 41 /);
});
