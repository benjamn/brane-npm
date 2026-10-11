import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTerminalStatus, terminalCursorFrom } from "../daemon/server.js";

// The mirror sends a pane's text; the cursor is the one thing about a pane
// that isn't in its text. These two functions are the whole translation from
// what tmux reports to what a client can draw, and both halves are pure — the
// arithmetic is the part that can be wrong without anyone noticing, since a
// cursor one row off still looks like a cursor.

describe("parseTerminalStatus", () => {
  it("reads the five fields display-message emits", () => {
    assert.deepEqual(parseTerminalStatus("39 23 1 0 24"), {
      cursorX: 39,
      cursorY: 23,
      cursorVisible: true,
      alternateOn: false,
      paneHeight: 24,
    });
  });

  it("treats flags as flags — only 1 is on", () => {
    const status = parseTerminalStatus("0 0 0 1 24");
    assert.equal(status?.cursorVisible, false);
    assert.equal(status?.alternateOn, true);
  });

  it("returns null rather than NaN for a line it can't read", () => {
    // A tmux that fails, a truncated read, an error string where a status
    // line was expected: better no cursor than one at NaN.
    assert.equal(parseTerminalStatus(""), null);
    assert.equal(parseTerminalStatus("no server running"), null);
    assert.equal(parseTerminalStatus("39 23 1 0"), null);
    assert.equal(parseTerminalStatus("39 x 1 0 24"), null);
  });
});

describe("terminalCursorFrom", () => {
  // Measured against a real session: 798 rows of history under a 24-row pane
  // captures 822 lines, and the shell prompt sits on the last of them.
  it("places the cursor below the scrollback a frame carries", () => {
    const status = parseTerminalStatus("39 23 1 0 24");
    assert.deepEqual(terminalCursorFrom(status, 822), { line: 821, col: 39 });
  });

  it("is the row itself when there is no history (alternate screen)", () => {
    const status = parseTerminalStatus("2 31 1 1 34");
    assert.deepEqual(terminalCursorFrom(status, 34), { line: 31, col: 2 });
  });

  // cursor_flag is the pane's own DECTCEM state. An application that hides the
  // cursor — Claude Code with a dialog up, lazygit throughout — means it, and a
  // block drawn anyway would be a cursor the operator's real terminal doesn't
  // show. Nothing is more misleading than a caret in the wrong place.
  it("draws nothing when the pane has hidden its cursor", () => {
    assert.equal(terminalCursorFrom(parseTerminalStatus("1 81 0 1 85"), 85), null);
  });

  it("draws nothing when the status line was unreadable", () => {
    assert.equal(terminalCursorFrom(null, 822), null);
  });

  // Defensive: a capture that raced a resize can report fewer rows than the
  // pane height, which would put the cursor above the frame's first line.
  it("declines a line that would fall off the top of the frame", () => {
    assert.equal(terminalCursorFrom(parseTerminalStatus("0 0 1 1 40"), 10), null);
    assert.equal(terminalCursorFrom(parseTerminalStatus("0 0 1 1 0"), 10), null);
  });
});
