# Terminal Mirroring

The terminal tab is a **mirror, not an attach**, and that is a design position
rather than an unfinished one. `capture-pane` is a *read* of shared state, so
any number of viewers watch one 100 ms capture loop with no tmux client
attaching, no attach/detach churn, and sizing that is brane's policy
(`fitWindowToViewers` — smallest active viewer wins, so a phone joining can
never clip a TUI's bottom rows). Idle costs almost nothing: `content ===
cap.lastContent` returns before a *diff* is sent, so a session waiting on
`listen` produces no repaints and no client rAF work — only the resync
heartbeat below. And because the frame is text rendered into DOM lines,
selection, ⌘F and copy are the platform's rather than ours — an emulator would
have us re-implement them.

The mirror's own consequence is that **anything not in the pane's text has to
be sent explicitly**. There is exactly one such thing, and it is the cursor.

## The resync heartbeat

Sending a diff only when the content changes is right, but it rests on an
assumption the protocol never checks: that a frame the daemon *sent* is a frame
the browser *rendered*. `c.lastContent` records the former and is read as
though it meant the latter. Every way a browser can drop a frame — a
backgrounded tab whose `requestAnimationFrame` never ran, a socket that
reconnected into a wiped `<pre>`, an early return in `applyFrame` — therefore
strands that viewer, and because the pane then goes quiet, *nothing ever
corrects it*. The only repair is a page reload, which is not a repair the
operator should have to know about. Observed in the wild as a phone showing an
entirely black terminal while the daemon's socket was demonstrably serving
frames the whole time.

`TERMINAL_RESYNC_MS` (2 s) closes the class without an ack protocol: a viewer
that hasn't been sent *content* in that long is re-sent the current frame,
whatever the reason it fell behind. Any dropped frame self-heals within one
interval.

| Piece | Where | Does |
|---|---|---|
| `lastSentAt` | `TerminalClient` | When this viewer was last sent content. Cursor-only messages don't touch it — they carry none |
| `isResyncDue()` | `src/daemon/server.ts` | The boundary, pure, so `src/test/terminal-resync.test.ts` can pin it |
| `resyncStaleViewers()` | the capture loop | Runs on **both** paths — see below |

Three details are load-bearing:

**Both paths, not just the idle one.** The obvious place is the `content ===
cap.lastContent` early return. The other is after the per-client fan-out, where
a viewer skipped by `content === c.lastContent` is *exactly* the stranded case
— its `lastContent` says it has this screen and its DOM says otherwise.

**`lastSentAt: 0` is the "due now" sentinel.** A fresh socket and a `refresh`
that just wiped the client's `<pre>` both set it, and against an epoch clock
`now - 0` clears any threshold — so those viewers get content on the very next
tick rather than waiting out an interval.

**Idle stays cheap.** One ~1.6 KB message per viewer every 2 s, serialized once
per tick and shared across viewers. On the client it is a full frame whose
per-line diff finds nothing changed, so it writes no DOM. A busy pane already
sends more often than this and is unaffected.

## The stranded rAF

The heartbeat guarantees the daemon keeps *offering* content. It does not
guarantee the client can *accept* it, and there was one way it could not.

Frames are coalesced through a single `requestAnimationFrame`, with
`rafIdRef !== null` standing for "a drain is already coming". That reading
holds only while the browser still intends to run the callback. **iOS Safari
freezes a backgrounded tab and can drop the scheduled callback outright** — an
app switch, a screen lock, an incoming call. The page resumes holding a
non-null id for a drain that will never fire, and from that moment the guard is
permanently closed: every later frame is stored in `pendingRafFrameRef` and
none is applied. Unmounting is the only thing that clears it, which is to say a
page reload. A pane that never got its first frame this way is not stale but
*blank*.

Note the interaction: **a stranded rAF swallows the heartbeat too**, delivering
fresh frames every 2 s into a queue nothing drains. The two fixes are not
alternatives; neither is sufficient alone.

| Piece | Does |
|---|---|
| `RAF_DRAIN_DEADLINE_MS` (400 ms) | An arriving frame that finds one already waiting this long stops trusting the schedule: cancel the token and drain inline. Generous beside a 16 ms paint on purpose — a liveness backstop, not a latency budget |
| `visibilitychange` → visible | Clear the stale token, drain anything pending, and `refresh()` the channel |

The `visibilitychange` half earns its place because foregrounding is both the
moment a callback was most likely dropped and the only moment repair is
possible without waiting: an idle pane's next frame is two seconds out, and the
`refresh()` is what restates a DOM that went stale for a reason the client
never observed. It is gated on the pane being active: an inactive one
has its DOM wiped and refreshed by `cleanRefresh` on activation anyway.

**A frame arriving no longer means the pane changed.** That equivalence was
free before the heartbeat and is what `applyFrame`'s auto-scroll was built on.
"At bottom" is a 40 px band, so an identical frame every 2 s would yank a
just-started finger-scroll back down for as long as the reader stayed inside
that band — a window that recurs forever rather than a one-off, on every
scrollback pane (alternate-screen panes are `overflow: hidden` and unaffected).
`applyFrameLines` and `applyAppendLines` therefore **return whether they wrote
any line node**, and the scroll follows that rather than the frame's arrival. A
frame that changed nothing has nothing to follow.

## The cursor

One tmux invocation per tick carries both halves of a frame:

```
display-message -p -F "#{cursor_x} #{cursor_y} #{cursor_flag} #{alternate_on} #{pane_height}" \; capture-pane -e -p -S - -E - -t <nid>
```

Deliberately **one** call. A keystroke landing between a separate cursor query
and its capture would paint the block a cell away from the character it belongs
on — the one artifact a cursor cannot have. It also replaced the periodic
`alternate_on` probe, so the per-session exec count went down.

| Piece | Where | Does |
|---|---|---|
| `TERMINAL_STATUS_FORMAT` | `src/daemon/server.ts` | The five fields, all numeric, so the parse cannot be ambiguous |
| `parseTerminalStatus()` | `src/daemon/server.ts` | Status line → fields, `null` on anything unreadable |
| `terminalCursorFrom()` | `src/daemon/server.ts` | Pane coordinates → frame coordinates (pure; `src/test/terminal-cursor.test.ts`) |
| `syncCursor()` | `expo/components/TerminalPane.tsx` | Parks the block on the line it belongs to |

Three things are less obvious than they look:

**`cursor_y` is pane-relative; a frame is not.** `capture-pane -S - -E -`
returns `history_size + pane_height` rows, so the visible pane is the *last*
`pane_height` of them and the cursor's frame line is `rows − pane_height +
cursor_y`. The pane's trailing blank rows are sent, not trimmed, and the
client keeps them. They are what puts a cleared screen's prompt (^L, `clear`)
at the top of the viewer, with the old screen scrolled into history above it,
as in a real terminal; trimmed, the prompt sat at the bottom, right under the
output it had cleared. Because the window is fitted to the smallest active
viewer, the pane always fits, so those blank rows can never fill the view of
someone scrolled to the bottom.

**`cursor_flag` gates rendering.** An application that hides its cursor means
it — Claude Code while a dialog is up, lazygit throughout — and a block drawn
anyway is a caret the operator's real terminal doesn't show. Claude Code
otherwise uses the *real* terminal cursor, so what tmux reports is Claude
Code's cursor rather than an approximation of it.

**A cursor moves when nothing else does.** Walking an arrow key along a shell
input line repaints not one character, so the frame early-return would send
nothing at all — precisely when a cursor is worth most. Position changes with
unchanged content therefore get their own `{type: "cursor"}` message, outside
the rAF frame coalescer, which exists to batch whole-screen work.

Client-side, the block is a span parked **inside the line div it belongs to**,
not positioned against the pane. It inherits that line's vertical position, so
scrolling, alternate-screen centering and reflow are all correct for free, and
the only thing computed here is `col × charWidth`. It paints with
`mix-blend-mode: difference` over white, inverting the glyph underneath the way
a real terminal does instead of covering it — which also means the client never
has to know which character it is sitting on. Solid and blinking when this pane
is where keystrokes land, hollow when they aren't: across split tabs and
stacked routes, "which terminal am I typing into" is otherwise a guess.

## Paste and copy

Paste goes through a tmux **buffer**, never `send-keys`:

```
load-buffer -b brane-paste -   (text on stdin)
paste-buffer -b brane-paste -p -t <nid>
```

`-p` is the point: it wraps the text in bracketed-paste markers *when the
application asked for them*, so Claude Code sees 40 pasted lines as one paste
rather than 40 submits, while a shell that doesn't do bracketed paste behaves
exactly as it would under `tmux attach`. A buffer is also not bounded by argv
(1 MB ceiling, `MAX_PASTE_BYTES`).

Reaching the clipboard differs by platform, and all three paths converge on the
socket's `paste` message:

| Where | Path |
|---|---|
| Desktop | A document-level `paste` listener, behind the same two guards as keydown — the terminal is a `<pre>`, never an editable, so the event has no closer home |
| Any platform chord | `isPasteChord()` makes keydown *step aside* for ⌘V (Mac) / ⌃V, ⌃⇧V (elsewhere). Swallowing ⌃V sent `C-v` to tmux and the browser never fired `paste`; ⌃V on a Mac stays quoted-insert |
| Touch | The `^V 📋` keycap in the 🦾 controls menu (it took ^R's slot, so the quick bar fits phones narrower than a Max) reads the clipboard directly (a tap is the required gesture; iOS shows its own confirm chip). Mobile fires no `paste` event without a focused editable, so there is nothing for the listener to catch |
| Touch, refused | A sheet with a real `<textarea>`, so the OS long-press → Paste menu works. The document listener catches that paste and closes the sheet |

**Copy-out needs an escape hatch, because the mouse is spoken for.** In
alternate mode every drag is forwarded as an SGR mouse event, which leaves no
way to select a line. Holding **Option or Shift** suppresses forwarding and
lets the browser select normally — the same convention Terminal.app and iTerm
use when an application has grabbed the mouse — and the modifier also restores
the context menu with its Copy item.

## Block glyphs

A mirror line is text in a line box pinned at `line-height: 1.4`, and a
font's block glyph (`▀ ▄ █`) covers only its own ascent and descent, about
14 px of a 16.8 px row. So block art was striped with a dark gap on every
row, and `brane meld`'s half-block QR code came out looking like a barcode
that scanned badly. The fix is on the client and nowhere else. `meld` prints
the same bytes, so a real terminal is unaffected.

`paintBlockGlyphs()` (`src/shared/block-glyphs.ts`, pinned by
`src/test/block-glyphs.test.ts`) runs on each changed line after ansi_up. It
wraps every U+2580–U+259F character in a span one cell wide and one line box
tall, which paints the glyph as a background in `currentColor`, so SGR
colors carry through. The character stays in the DOM, hidden with
`-webkit-text-fill-color`, so copy still yields it. A line with no block
element costs one regex test.

**One full-cell image per glyph, never a sized layer.** The first cut
painted each rectangle as a layer sized and positioned inside the cell, and
left a hairline between lit rows. Each row starts on a fractional pixel, and
each layer anti-aliased its own edge onto the shared boundary pixel. A
full-cell gradient with hard stops (linear for bars, conic for quadrants)
has the span's own edges, and the browser snaps those to whole pixels.
