import { useEffect, useRef, useCallback, useState, useImperativeHandle, forwardRef, memo } from "react";
import { Platform } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { AnsiUp } from "ansi_up";
import { blockGlyphStylesheet, paintBlockGlyphs } from "@shared/block-glyphs";
import { reviveNarrative, type ConnectionParams } from "@/lib/api";
import {
  createTerminalChannel,
  sendInterrupt,
  type TerminalCursor,
  type TerminalFrame,
} from "@/lib/terminal";
import TerminalKeyboard from "./TerminalKeyboard";
import MacroMenu from "./MacroMenu";
import ControlsMenu, { type Control } from "./ControlsMenu";
import { revivesAsTwin } from "./NarrativeMenu";

// How long a frame may sit waiting on a scheduled requestAnimationFrame before
// the next arriving frame stops trusting that schedule and drains it directly.
// Generous next to a 16 ms paint — this is a liveness backstop for a callback
// the browser dropped, not a latency budget.
const RAF_DRAIN_DEADLINE_MS = 400;

// Terminal glyph metrics, shared by the rendered <pre> and the measurement
// spans that derive cols/rows. Keeping them in one place ensures the row math
// divides by the same line height the browser actually paints.
const TERM_FONT_SIZE = 12; // px
const TERM_LINE_HEIGHT = 1.4; // unitless multiplier
// The exact painted height of one line box. `line-height: 1.4` pins each line
// to fontSize × 1.4 = 16.8px regardless of the font's intrinsic metrics, so
// this is precisely what the browser paints. We deliberately do NOT round it:
// getBoundingClientRect() on an inline span reports the glyph/content box
// (~14px, smaller than the line box) which overestimates the row count and
// clips the bottom line; rounding *up* to 17 overestimates line cost and
// intermittently drops a row we had room for (a stray blank tail line that
// comes and goes across reorientations). Dividing by the true 16.8 and
// flooring gives the tightest row count that still never occludes.
const TERM_LINE_PX = TERM_FONT_SIZE * TERM_LINE_HEIGHT;
// Padding inside the <pre>, per side (matches the style below).
const TERM_PADDING = 8;

// The cursor block. It is painted with mix-blend-mode: difference over a white
// fill, which inverts whatever glyph is underneath rather than covering it —
// the same thing a real terminal does, and it means the client never has to
// know which character it is sitting on. Blinking is CSS so it costs no frames
// and keeps running while the mirror is idle.
// Block elements (▀ ▄ █ …) painted to fill the whole line box, so block art —
// `brane meld`'s QR code above all — has no gap between rows. See
// src/shared/block-glyphs.ts.
const BLOCK_GLYPH_STYLES = blockGlyphStylesheet(TERM_LINE_HEIGHT);

const CURSOR_BLINK_KEYFRAMES = `@keyframes brane-cursor-blink {
  0%, 45% { opacity: 1; }
  55%, 100% { opacity: 0; }
}`;

export interface TerminalPaneHandle {
  scrollToTop: () => void;
  scrollToBottom: () => void;
  terminate: () => void;
  revive: () => void;
  /** Move keyboard focus into the terminal so it captures typed keys. */
  focus: () => void;
}

interface TerminalPaneProps {
  conn: ConnectionParams;
  nid: string;
  active?: boolean;
  // Whether this terminal should capture document-level keystrokes. In
  // split view a pane can be `active` (visible, painting frames) but not
  // the focused tab — only the focused tab should steal keys.
  keyboardActive?: boolean;
  agentType?: string | null;
  role?: string | null;
  onAtBottomChange?: (atBottom: boolean) => void;
  // External sessions have no tmux process to restart; instead "revive" means
  // spawning a brane-managed twin from this narrative. When set and role is
  // "external", the Restart button / 🦠 Revive item invoke this instead.
  onTwin?: () => void;
  // A revive can come back as a *different* narrative: when a session can't be
  // resumed in place the daemon spawns a twin and returns its id
  // (`status: "continued"`). The pane can't follow that itself — it is bound to
  // one nid — so it hands the new id up and the screen navigates. Never called
  // when the id comes back unchanged; that case reconnects in place.
  onRevived?: (nid: string) => void;
}

// tmux modifier prefix for a KeyboardEvent: C- (ctrl), S- (shift), M- (alt).
// Order matches tmux's own canonical ordering (C-, M-, S- are all accepted,
// but we emit a stable C-/M-/S- sequence). Shift is only meaningful on the
// non-printable keys we prefix it to (arrows, Home/End, etc.) — for printable
// characters the browser already folds Shift into e.key (e.g. "A"), so we omit
// it there to avoid double-applying.
function tmuxModifierPrefix(e: KeyboardEvent, includeShift: boolean): string {
  let prefix = "";
  if (e.ctrlKey) prefix += "C-";
  if (e.altKey) prefix += "M-";
  if (includeShift && e.shiftKey) prefix += "S-";
  return prefix;
}

// Special (non-printable) keys → tmux key names. Modifiers are composed on
// top of these so chords like ctrl+End / ctrl+Home / shift+Up reach the TUI.
const SPECIAL_KEY_NAMES: Record<string, string> = {
  Enter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  Backspace: "BSpace",
  Delete: "DC",
  Insert: "IC",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PPage",
  PageDown: "NPage",
  F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5", F6: "F6",
  F7: "F7", F8: "F8", F9: "F9", F10: "F10", F11: "F11", F12: "F12",
};

// Map browser KeyboardEvent to tmux key name (with modifier prefixes).
function mapKeyToTmux(e: KeyboardEvent): string | null {
  // Special keys: compose ctrl/alt/shift onto the tmux key name so chords
  // like ctrl+End (TUI "jump to bottom") and ctrl+Home survive the trip.
  const special = SPECIAL_KEY_NAMES[e.key];
  if (special) {
    return tmuxModifierPrefix(e, /* includeShift */ true) + special;
  }

  // Space is a special case: tmux names it "Space", but only bother when a
  // modifier is held (a bare space is a printable character below).
  if (e.key === " ") {
    const prefix = tmuxModifierPrefix(e, /* includeShift */ false);
    return prefix ? prefix + "Space" : " ";
  }

  // Ctrl/Alt + single printable character → C-x / M-x (preserve the combo).
  if ((e.ctrlKey || e.altKey) && e.key.length === 1) {
    return tmuxModifierPrefix(e, /* includeShift */ false) + e.key.toLowerCase();
  }

  // Plain printable character
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    return e.key;
  }

  return null;
}

// ^C and ^O move into the ControlsMenu (🦾) to keep the portrait bar uncramped,
// but Esc and 1/2/3 stay inline (per operator) — they're the high-frequency
// keys for dismissing menus and picking Claude Code's numbered prompts on
// mobile, and burying them would cost taps.
const QUICK_KEYS = [
  { label: "Esc", keys: "Escape" },
  { label: "1", keys: "1" },
  { label: "2", keys: "2" },
  { label: "3", keys: "3" },
];

// iOS WebKit substitutes Apple Color Emoji for many "indicator" Unicode
// codepoints (⏺ U+23FA, 🔘 U+1F518, etc.) regardless of font choice or
// `font-variant-emoji`. In the terminal mirror those glyphs are almost
// always Claude-Code-style status dots, not meaningful content, so on iOS
// we rewrite them to ● U+25CF before rendering. ANSI color codes are
// untouched, so any color/character cycling still drives the cell.
const isIOS =
  typeof navigator !== "undefined" &&
  typeof document !== "undefined" &&
  (/iP(ad|hone|od)/.test(navigator.userAgent) ||
    (/Mac/.test(navigator.userAgent) && "ontouchend" in document));

// Which chord the platform means by "paste". On a Mac that's ⌘V; everywhere
// else ⌃V (and ⌃⇧V, which terminals use because ⌃V is quoted-insert). It
// matters because our keydown handler otherwise swallows ⌃V and forwards it
// to tmux, and the browser never fires the `paste` event that carries the
// clipboard. ⌘V needs no exemption — mapKeyToTmux already declines it — but
// naming both keeps the rule in one place.
const isApplePlatform =
  typeof navigator !== "undefined" &&
  /Mac|iP(ad|hone|od)/.test(navigator.platform || navigator.userAgent);

function isPasteChord(e: KeyboardEvent): boolean {
  if (e.key.toLowerCase() !== "v" || e.altKey) return false;
  return isApplePlatform ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

// Narrow set: only codepoints we've actually observed Claude Code using
// as indicator dots. Add more here as we encounter them.
//   U+23FA  ⏺  BLACK CIRCLE FOR RECORD  (participle, tool-call lines)
//   U+1F518 🔘 RADIO BUTTON              (suspected "Calling…" prefix)
const INDICATOR_RE = /[⏺\u{1F518}]/gu;

function fixIosIndicators(s: string): string {
  return isIOS ? s.replace(INDICATOR_RE, "●") : s;
}

// ansi_up handles SGR (CSI ... m) but not OSC sequences. Claude Code's TUI
// emits OSC 8 hyperlinks for file paths (open: \x1b]8;<params>;<url>ST,
// close: \x1b]8;;ST, where ST is either BEL \x07 or ESC \). Without
// stripping, the literal `]8;;` bytes leak into the rendered mirror as
// visible junk. The non-greedy class captures the shortest run between
// `\x1b]` and the next ST, so the URL text between the open and close
// markers is preserved.
const OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;

function stripOSC(s: string): string {
  return s.replace(OSC_RE, "");
}

/** Quick bar button with brief press flash for screenshare visibility */
function FlashButton({ onPress, style, children }: {
  onPress: () => void;
  style: React.CSSProperties;
  children: React.ReactNode;
}) {
  const [pressed, setPressed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClick = useCallback(() => {
    onPress();
    if (timerRef.current) clearTimeout(timerRef.current);
    setPressed(true);
    timerRef.current = setTimeout(() => setPressed(false), 180);
  }, [onPress]);

  return (
    <button
      onClick={handleClick}
      style={{
        ...style,
        ...(pressed ? {
          backgroundColor: "#4444cc",
          border: "1px solid #7c7cff",
          color: "#fff",
          boxShadow: "0 0 8px rgba(120, 120, 255, 0.8)",
        } : {
          boxShadow: "none",
        }),
        transition: "background-color 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease, color 0.15s ease",
      }}
    >
      {children}
    </button>
  );
}

const TerminalPane = forwardRef<TerminalPaneHandle, TerminalPaneProps>(function TerminalPane({ conn, nid, active = true, keyboardActive, agentType, role, onAtBottomChange, onTwin, onRevived }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ansiUpRef = useRef<InstanceType<typeof AnsiUp> | null>(null);
  const channelRef = useRef<ReturnType<typeof createTerminalChannel> | null>(null);
  const wasAtBottomRef = useRef(true);
  const pendingFrameRef = useRef<TerminalFrame | null>(null);
  // Hold the latest incoming WS frame and apply it in one rAF tick so a burst
  // of capture-pane updates can't starve the main thread between paints.
  // Design note: drainFrames does NOT re-schedule itself — it fires once,
  // applies the pending frame, and stops. A new rAF is only registered when
  // the next WS frame arrives (handleFrame). The daemon also skips sending
  // frames when content is unchanged, so when the terminal is idle there are
  // zero rAF registrations and zero main-thread frames drawn. This keeps the
  // tab completely quiescent between actual terminal updates.
  const pendingRafFrameRef = useRef<TerminalFrame | null>(null);
  const rafIdRef = useRef<number | null>(null);
  // When the frame currently sitting in pendingRafFrameRef arrived.
  //
  // `rafIdRef !== null` is used as "a drain is already coming", which is only
  // true while the browser still intends to run the callback. iOS Safari
  // freezes a backgrounded tab and can drop the scheduled callback outright;
  // the page then resumes with a non-null id for a drain that will never fire,
  // and the guard below turns that into a permanent freeze — every later frame
  // is stored and none is ever applied. Which is why the pane could sit blank
  // or stale until a reload while the socket was demonstrably still delivering
  // frames. A pending frame older than this deadline means the token is stale,
  // so we drop it and apply the frame ourselves.
  const pendingRafSinceRef = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  // Default keyboard capture to `active` for back-compat when only one tab
  // is visible, but in split view callers pass `activeTab === "terminal"`
  // so the chat composer doesn't fight this listener for the same keystroke.
  const keyboardActiveRef = useRef(keyboardActive ?? active);
  keyboardActiveRef.current = keyboardActive ?? active;
  // Expo Router keeps previously-visited [nid] screens mounted underneath the
  // top of the stack, and our keydown listener is attached to `document`. Without
  // a focus guard, every mounted pane left on the terminal tab would forward each
  // keystroke to its OWN tmux session — fanning input out across sessions and, when
  // the same nid is stacked more than once, doubling characters. Gate on real route
  // focus so only the foreground screen's terminal captures keys.
  const isFocused = useIsFocused();
  const isFocusedRef = useRef(isFocused);
  isFocusedRef.current = isFocused;
  const [showKeyboard, setShowKeyboard] = useState(false);
  // Shown only when we can't read the clipboard ourselves — see handlePasteButton.
  const [pastePrompt, setPastePrompt] = useState(false);
  const pasteInputRef = useRef<HTMLTextAreaElement>(null);
  const pastePromptRef = useRef(false);
  pastePromptRef.current = pastePrompt;
  const [terminated, setTerminated] = useState(false);
  const [reviving, setReviving] = useState(false);
  // Holds the latest `handleRevive` so the imperative handle (declared above
  // it) can invoke the same revive-and-reconnect path as the overlay button.
  const handleReviveRef = useRef<() => void>(() => {});
  const [alternateOn, setAlternateOn] = useState(false);
  // Mirror of the alternateOn state so we can short-circuit setState calls on
  // every frame when the value hasn't changed — React bails on same-value
  // updates, but the setter call itself is non-free at 10 fps.
  const alternateOnRef = useRef(false);
  const charDimsRef = useRef<{ width: number; height: number } | null>(null);

  // ── Cursor ────────────────────────────────────────────────────────────────
  // The mirror is text; the cursor is the one thing about a pane that isn't in
  // its text, so the daemon sends it alongside each frame (and on its own when
  // only it moved). The block is a span parked inside the line div it belongs
  // to, which is what keeps it correct for free: it inherits that line's
  // vertical position, so it survives scrolling, alternate-screen centering,
  // and reflow without any of them being computed here. Only the horizontal
  // offset is ours, and that is one character width times the column.
  const cursorPosRef = useRef<TerminalCursor | null>(null);
  const cursorElRef = useRef<HTMLSpanElement | null>(null);
  // Whether keystrokes currently land in this pane — the same condition the
  // keydown handler gates on. A filled, blinking block therefore means "typing
  // goes here" and a hollow one means it doesn't, which is information the
  // operator otherwise has to guess at across split tabs and stacked routes.
  const cursorLive = (keyboardActive ?? active) && isFocused;
  const cursorLiveRef = useRef(cursorLive);
  cursorLiveRef.current = cursorLive;

  // Whether we believe Claude's fullscreen virtual scrollback is pinned to the
  // bottom (auto-following latest output). In the alternate screen, tmux
  // capture-pane only sees the live viewport, so brane can't measure scroll
  // position — instead we infer it from the scroll commands we forward: any
  // scroll-up → not following, jump-to-bottom → following. This drives the same
  // termAtBottom wiring the native (non-fullscreen) path uses, preserving the
  // arrow's ↓-everywhere / ↑-at-bottom split.
  const followingRef = useRef(true);
  // Keep the latest onAtBottomChange in a ref so setFollowing (called from
  // effects with empty dep arrays, e.g. the keydown handler) never goes stale.
  const onAtBottomChangeRef = useRef(onAtBottomChange);
  onAtBottomChangeRef.current = onAtBottomChange;
  const setFollowing = useCallback((val: boolean) => {
    followingRef.current = val;
    // Only the fullscreen path reports through this; the native path computes
    // atBottom from real scroll geometry.
    if (alternateOnRef.current && val !== wasAtBottomRef.current) {
      wasAtBottomRef.current = val;
      onAtBottomChangeRef.current?.(val);
    }
  }, []);

  // Update the inferred follow state from a scroll key we're forwarding.
  const trackScrollIntent = useCallback((keys: string) => {
    if (keys === "C-End") setFollowing(true);
    else if (keys === "PPage" || keys === "C-Home") setFollowing(false);
  }, [setFollowing]);

  useImperativeHandle(ref, () => ({
    focus: () => {
      const el = containerRef.current;
      if (!el) return;
      try { el.focus({ preventScroll: true }); } catch { el.focus(); }
    },
    scrollToTop: () => {
      // Fullscreen: drive Claude's virtual scrollback to the top via ⌃Home.
      if (alternateOnRef.current) {
        channelRef.current?.sendKeys("C-Home");
        setFollowing(false);
        return;
      }
      const container = containerRef.current;
      if (container) {
        container.scrollTop = 0;
        wasAtBottomRef.current = false;
        onAtBottomChange?.(false);
      }
    },
    scrollToBottom: () => {
      // Fullscreen: jump Claude's virtual scrollback to the latest via ⌃End.
      if (alternateOnRef.current) {
        channelRef.current?.sendKeys("C-End");
        setFollowing(true);
        return;
      }
      const container = containerRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
        wasAtBottomRef.current = true;
        onAtBottomChange?.(true);
      }
    },
    terminate: () => {
      // The sequence itself lives in lib/terminal so the list screen's End —
      // which has no pane and opens its own one-shot channel — interrupts a
      // session exactly the way this does.
      sendInterrupt((keys) => channelRef.current?.sendKeys(keys));
    },
    // Reuse the overlay button's revive-and-reconnect path so the menu's
    // Revive refreshes the terminal without a manual page reload.
    revive: () => { handleReviveRef.current(); },
  }), [onAtBottomChange, setFollowing]);

  // Web-only component
  if (Platform.OS !== "web") return null;

  // Per-line DOM diffing: each row is its own <div>. The raw line text is
  // tracked off-DOM in `lineSourceRef` (a WeakMap from element to source
  // string) rather than a dataset attribute — tmux capture lines contain
  // ESC (\x1b) and other control characters, and writing those into an HTML
  // data-* attribute is unreliable across browsers (some silently mangle,
  // some throw, blanking the mirror). The WeakMap dodges the encoder
  // entirely and also keeps the actual DOM markup clean.
  //
  // Unchanged lines are never touched, so (a) per-frame work scales with the
  // number of *changed* lines rather than total scrollback size, and
  // (b) text selection survives any frame whose changes happen outside the
  // selected range.
  const lineSourceRef = useRef<WeakMap<HTMLDivElement, string>>(new WeakMap());

  const renderLineContent = useCallback((node: HTMLDivElement, text: string) => {
    if (text.length === 0) {
      // Use a non-breaking space so the div is guaranteed to take a full row
      // of vertical space even when min-height/em isn't honored consistently.
      node.textContent = " ";
    } else if (ansiUpRef.current) {
      node.innerHTML = paintBlockGlyphs(
        ansiUpRef.current.ansi_to_html(fixIosIndicators(stripOSC(text))),
      );
    } else {
      node.textContent = stripOSC(text);
    }
  }, []);

  const createLineNode = useCallback((text: string): HTMLDivElement => {
    const div = document.createElement("div");
    // Block layout so each line occupies its own row; min-height so even
    // collapsed empty lines (theoretically — we always seed nbsp above) keep
    // their row of vertical space.
    div.style.display = "block";
    div.style.minHeight = "1.4em";
    // Containing block for the cursor span when the caret lands on this line.
    div.style.position = "relative";
    renderLineContent(div, text);
    lineSourceRef.current.set(div, text);
    return div;
  }, [renderLineContent]);

  const updateLineNode = useCallback((node: HTMLDivElement, text: string) => {
    renderLineContent(node, text);
    lineSourceRef.current.set(node, text);
  }, [renderLineContent]);

  const lineSourceOf = useCallback((node: HTMLDivElement): string | undefined => {
    return lineSourceRef.current.get(node);
  }, []);

  // Park the cursor block on the line it belongs to. Called after every frame
  // (updateLineNode rewrites a line's innerHTML, which takes the span with it)
  // and on cursor-only messages. Cheap enough to run unconditionally: at most
  // one detach and one append per capture tick.
  const syncCursor = useCallback(() => {
    const pre = containerRef.current?.querySelector("pre");
    const el = cursorElRef.current;
    const pos = cursorPosRef.current;
    const dims = charDimsRef.current;

    if (!pre || !pos || !dims) {
      // No cursor to show — tmux says it's hidden, or we haven't measured the
      // font yet. Detach rather than hide so a stale block can never outlive
      // the pane it was drawn for.
      if (el?.parentNode) el.parentNode.removeChild(el);
      return;
    }

    const line = pre.children[pos.line] as HTMLDivElement | undefined;
    if (!line) {
      if (el?.parentNode) el.parentNode.removeChild(el);
      return;
    }

    const node = el ?? document.createElement("span");
    if (!el) {
      node.style.position = "absolute";
      node.style.top = "0";
      node.style.pointerEvents = "none";
      node.style.backgroundColor = "#fff";
      node.style.mixBlendMode = "difference";
      cursorElRef.current = node;
    }
    node.style.left = `${pos.col * dims.width}px`;
    node.style.width = `${dims.width}px`;
    node.style.height = `${TERM_LINE_PX}px`;
    // Live: solid and blinking. Not live: a hollow outline that still says
    // where you are without pretending your keystrokes go there.
    if (cursorLiveRef.current) {
      node.style.backgroundColor = "#fff";
      node.style.border = "none";
      node.style.animation = "brane-cursor-blink 1.06s steps(1, end) infinite";
    } else {
      node.style.backgroundColor = "transparent";
      node.style.border = "1px solid #fff";
      node.style.boxSizing = "border-box";
      node.style.animation = "none";
    }
    // Line divs created before this build (or by a path that missed it) still
    // need to be a containing block for the absolute span.
    if (line.style.position !== "relative") line.style.position = "relative";
    if (node.parentNode !== line) line.appendChild(node);
  }, []);

  // Re-render the block when focus moves between panes or tabs — the position
  // hasn't changed, only whether typing lands here.
  useEffect(() => { syncCursor(); }, [cursorLive, syncCursor]);

  // Wipe the <pre> DOM and reset lineSource tracking, then ask the server for
  // a clean full frame. Called on accordion toggle and on tab activation to
  // prevent stale nodes from accumulating.
  const cleanRefresh = useCallback(() => {
    const container = containerRef.current;
    const pre = container?.querySelector("pre");
    if (pre) {
      while (pre.firstChild) pre.removeChild(pre.firstChild);
      lineSourceRef.current = new WeakMap();
      // The cursor span lived inside one of those lines; drop the handle so
      // the next sync builds a fresh one rather than re-parenting a detached
      // node from a DOM that no longer exists.
      cursorElRef.current = null;
    }
    channelRef.current?.refresh();
  }, []);

  // Returns whether any line node was actually written. The resync heartbeat
  // re-sends the current frame every 2s, so "a frame arrived" no longer implies
  // "the pane changed" — and callers that act on change (the auto-scroll) must
  // key on this rather than on arrival.
  const applyFrameLines = useCallback((pre: HTMLPreElement, newLines: string[]): boolean => {
    // Snapshot children before mutating — `pre.children` is live and would
    // shift indices underneath us if we removed/appended during the walk.
    const oldNodes = Array.from(pre.children) as HTMLDivElement[];
    const newLen = newLines.length;
    const oldLen = oldNodes.length;
    const common = Math.min(newLen, oldLen);
    let changed = newLen !== oldLen;

    // Walk the overlap: skip lines whose source matches, replace the rest.
    for (let i = 0; i < common; i++) {
      if (lineSourceOf(oldNodes[i]) !== newLines[i]) {
        updateLineNode(oldNodes[i], newLines[i]);
        changed = true;
      }
    }

    if (newLen > oldLen) {
      // Append new tail lines in one batched insertion.
      const frag = document.createDocumentFragment();
      for (let i = oldLen; i < newLen; i++) frag.appendChild(createLineNode(newLines[i]));
      pre.appendChild(frag);
    } else if (oldLen > newLen) {
      // Remove the surplus tail nodes.
      for (let i = oldLen - 1; i >= newLen; i--) pre.removeChild(oldNodes[i]);
    }
    return changed;
  }, [createLineNode, updateLineNode, lineSourceOf]);

  const applyAppendLines = useCallback((
    pre: HTMLPreElement,
    appendLines: string[],
    lineOffsetRaw: number,
    totalLinesRaw: number,
  ) => {
    const lineOffset = Math.max(0, lineOffsetRaw | 0);
    const totalLines = Math.max(0, totalLinesRaw | 0);
    const oldNodes = Array.from(pre.children) as HTMLDivElement[];
    const oldLen = oldNodes.length;
    let changed = false;

    // Pad with empty rows if the append's lineOffset overshoots what we
    // currently have. This shouldn't happen in healthy operation, but defends
    // against a server-side full frame we missed before the append landed.
    if (lineOffset > oldLen) {
      const padFrag = document.createDocumentFragment();
      for (let i = oldLen; i < lineOffset; i++) padFrag.appendChild(createLineNode(""));
      pre.appendChild(padFrag);
      changed = true;
    }

    // Walk the append payload. For each index, either patch an existing node
    // (if its source differs) or append a fresh one.
    const live = Array.from(pre.children) as HTMLDivElement[];
    let appendFrag: DocumentFragment | null = null;
    for (let i = 0; i < appendLines.length; i++) {
      const idx = lineOffset + i;
      if (idx < live.length) {
        if (lineSourceOf(live[idx]) !== appendLines[i]) {
          updateLineNode(live[idx], appendLines[i]);
          changed = true;
        }
      } else {
        if (!appendFrag) appendFrag = document.createDocumentFragment();
        appendFrag.appendChild(createLineNode(appendLines[i]));
        changed = true;
      }
    }
    if (appendFrag) pre.appendChild(appendFrag);

    // Trim anything past the new total. Server's `totalLines` is authoritative.
    const finalLen = pre.children.length;
    if (finalLen > totalLines) {
      for (let i = finalLen - 1; i >= totalLines; i--) {
        const child = pre.children[i];
        if (child) pre.removeChild(child);
      }
      changed = true;
    }
    return changed;
  }, [createLineNode, updateLineNode, lineSourceOf]);

  const applyFrame = useCallback((frame: TerminalFrame) => {
    const container = containerRef.current;
    if (!container || !ansiUpRef.current) return;

    const pre = container.querySelector("pre");
    if (!pre) return;

    const scrollParent = container;
    // In fullscreen (alternate screen) there's no real scroll to measure, so
    // trust the inferred follow flag; otherwise use real scroll geometry.
    const atBottom = alternateOnRef.current
      ? followingRef.current
      : scrollParent.scrollHeight - scrollParent.scrollTop - scrollParent.clientHeight < 40;
    if (atBottom !== wasAtBottomRef.current) {
      onAtBottomChange?.(atBottom);
    }
    wasAtBottomRef.current = atBottom;

    if (frame.type === "frame" || frame.type === "append") {
      cursorPosRef.current = frame.cursor ?? null;
    }

    let nextAlternateOn: boolean | undefined;
    let changedLines = false;
    if (frame.type === "frame") {
      // Trailing blank rows are the pane's unused space and are kept, never
      // stripped: they are what puts a cleared screen's prompt at the top.
      const lines = frame.data.split("\n");
      changedLines = applyFrameLines(pre as HTMLPreElement, lines);
      nextAlternateOn = frame.alternate_on;
    } else if (frame.type === "append") {
      const appendLines = frame.data.split("\n");
      changedLines = applyAppendLines(pre as HTMLPreElement, appendLines, frame.lineOffset, frame.totalLines);
      nextAlternateOn = frame.alternate_on;
    }

    if (nextAlternateOn !== undefined && nextAlternateOn !== alternateOnRef.current) {
      alternateOnRef.current = nextAlternateOn;
      setAlternateOn(nextAlternateOn);
    }

    // After the lines, always: a rewritten line node has just discarded the
    // span that was inside it.
    syncCursor();

    // Only auto-scroll when the pane actually changed, and only when its
    // content overflows the viewport.
    //
    // The `changedLines` half is what keeps the resync heartbeat invisible.
    // "At bottom" is a 40px band, so a scrollback pane that receives an
    // identical frame every 2s would yank a just-started finger-scroll back
    // down for as long as the reader stayed inside that band — a recurring
    // window rather than a one-off. A frame that wrote no line node has
    // nothing to follow, so following it is never right.
    //
    // The overflow half is older: when the pane is shorter than one screen,
    // scrollHeight <= clientHeight and the user can't scroll at all, so
    // forcing scrollTop would fight any attempt to read a short terminal from
    // the top.
    if (
      changedLines &&
      wasAtBottomRef.current &&
      scrollParent.scrollHeight > scrollParent.clientHeight
    ) {
      scrollParent.scrollTop = scrollParent.scrollHeight;
    }
  }, [applyFrameLines, applyAppendLines, onAtBottomChange, syncCursor]);

  const drainFrames = useCallback(() => {
    rafIdRef.current = null;
    const frame = pendingRafFrameRef.current;
    if (!frame) return;
    pendingRafFrameRef.current = null;
    applyFrame(frame);
  }, [applyFrame]);

  const handleFrame = useCallback((frame: TerminalFrame) => {
    if (!activeRef.current) {
      // Buffer the latest frame; we'll apply it when tab becomes active.
      pendingFrameRef.current = frame;
      return;
    }
    // Always keep only the latest frame — the per-line DOM diff makes a full
    // repaint cheap, so there's no benefit to applying intermediate frames.
    const hadPending = pendingRafFrameRef.current !== null;
    pendingRafFrameRef.current = frame;
    if (!hadPending) pendingRafSinceRef.current = Date.now();

    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(drainFrames);
      return;
    }
    // A drain is supposedly already scheduled. If it hasn't happened well
    // inside a frame's worth of time, the browser is not going to run it —
    // see pendingRafSinceRef. Take over rather than wait forever.
    if (Date.now() - pendingRafSinceRef.current >= RAF_DRAIN_DEADLINE_MS) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
      drainFrames();
    }
  }, [drainFrames]);

  // A tab returning to the foreground is the moment a dropped rAF is most
  // likely to have happened, and the one moment we can act on without waiting
  // for another frame to arrive: an idle pane's next frame is two seconds out
  // (the daemon's resync heartbeat), and a torn-down one may send nothing at
  // all until the operator types.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      if (pendingRafFrameRef.current) drainFrames();
      // Whatever the client believes it has, ask the daemon to restate the
      // pane. It costs one small message and it is the only thing that repairs
      // a DOM that went stale for a reason the client never observed.
      //
      // Only for a pane that is actually showing: an inactive one is about to
      // have its DOM wiped and refreshed by `cleanRefresh` on activation
      // anyway, so asking now buys nothing and costs the daemon a send plus a
      // forced capture per hidden pane per foreground.
      if (activeRef.current) channelRef.current?.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [drainFrames]);

  // Cancel any pending drain on unmount.
  useEffect(() => () => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    pendingRafFrameRef.current = null;
  }, []);

  // Start/stop server-side capture when tab visibility changes. On the
  // inactive→active transition (not initial mount), wipe any stale DOM that
  // accumulated while the tab was hidden — the initial mount already gets a
  // clean DOM and a fresh frame from `channel.start()` in the init effect.
  const prevActiveRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    const ch = channelRef.current;
    if (!ch) return;
    const wasActive = prevActiveRef.current;
    prevActiveRef.current = active;
    if (active) {
      ch.start();
      if (pendingFrameRef.current) {
        applyFrame(pendingFrameRef.current);
        pendingFrameRef.current = null;
      }
      if (wasActive === false) cleanRefresh();
    } else {
      ch.stop();
    }
  }, [active, applyFrame, cleanRefresh]);

  useEffect(() => {
    if (!ansiUpRef.current) {
      const au = new AnsiUp();
      au.use_classes = false;
      ansiUpRef.current = au;
    }

    const channel = createTerminalChannel({
      conn,
      nid,
      onFrame: handleFrame,
      // A cursor-only move repaints one span; it doesn't go through the rAF
      // frame coalescer, which exists to batch whole-screen work.
      onCursor: (cursor) => {
        cursorPosRef.current = cursor;
        if (activeRef.current) syncCursor();
      },
      onTerminated: () => setTerminated(true),
    });
    channelRef.current = channel;
    channel.start();

    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [conn, nid, handleFrame, syncCursor]);

  // Keyboard handler — document-level so typing reaches the terminal
  // even when focus is on the tab bar or other non-input elements.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Two guards, one routing rule. (1) Only the foreground route's terminal
      // tab may capture keys: isFocusedRef is false for any backgrounded-but-
      // still-mounted screen in the nav stack, which prevents cross-session
      // delivery and per-character doubling. (2) The active (green) tab is the
      // sole source of truth — DOM focus is never authoritative — so once those
      // guards pass we capture every key regardless of which element holds
      // focus, and keystrokes can't leak into a still-focused chat composer
      // (the terminal→chat duplication bug). Callers gate keyboardActive off
      // while a modal is open, so the brane-switcher / twin / lightbox inputs
      // still type normally.
      if (!keyboardActiveRef.current || !isFocusedRef.current) return;
      // The paste sheet is our own modal, so gate here rather than relying on
      // the caller's keyboardActive.
      if (pastePromptRef.current) return;
      // Hands off the platform paste chord: swallowing it would send C-v to
      // tmux and the clipboard would never be read. Letting it through makes
      // the browser fire `paste`, which is where the text actually arrives.
      if (isPasteChord(e)) return;
      let key = mapKeyToTmux(e);
      // In fullscreen, let bare Home/End drive Claude's virtual scrollback
      // (scroll:top / scroll:bottom = ⌃Home/⌃End) so you don't have to hold
      // Ctrl. Outside fullscreen they stay literal Home/End for input-line
      // editing. A held Ctrl already maps to C-Home/C-End upstream.
      if (key && alternateOnRef.current) {
        if (key === "Home") key = "C-Home";
        else if (key === "End") key = "C-End";
      }
      if (key && channelRef.current) {
        e.preventDefault();
        channelRef.current.sendKeys(key);
        trackScrollIntent(key);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Paste. Document-level for the same reason as keydown: the terminal is a
  // <pre>, never an editable, so the event has no closer home to land in.
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (!keyboardActiveRef.current || !isFocusedRef.current) return;
      const text = e.clipboardData?.getData("text");
      if (!text) return;
      e.preventDefault();
      channelRef.current?.sendPaste(text);
      // A paste into the fallback sheet is the sheet doing its job.
      if (pastePromptRef.current) setPastePrompt(false);
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, []);

  // The 📋 button, which exists for touch: iOS and Android fire no `paste`
  // event without a focused editable, so there is nothing for the listener
  // above to catch. Reading the clipboard directly is allowed from a user
  // gesture in a secure context, and iOS shows its own confirm-paste chip.
  // When that's refused or unavailable we fall back to a sheet whose textarea
  // *is* an editable, so the OS paste menu works — the listener above catches
  // it and closes the sheet.
  const handlePasteButton = useCallback(async () => {
    try {
      const text = await navigator.clipboard?.readText();
      if (text) {
        channelRef.current?.sendPaste(text);
        return;
      }
      if (text === "") return; // clipboard genuinely empty — nothing to paste
    } catch {
      // Denied, insecure context, or no Clipboard API. Fall through.
    }
    setPastePrompt(true);
  }, []);

  // ResizeObserver: measure container and send cols/rows to server
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Create a measurement element to get monospace character dimensions
    const measure = document.createElement("span");
    measure.style.fontFamily = "'Menlo', 'Monaco', 'Courier New', monospace";
    measure.style.fontSize = `${TERM_FONT_SIZE}px`;
    measure.style.lineHeight = `${TERM_LINE_HEIGHT}`;
    measure.style.position = "absolute";
    measure.style.visibility = "hidden";
    measure.style.whiteSpace = "pre";
    measure.textContent = "X";
    document.body.appendChild(measure);

    const charWidth = measure.getBoundingClientRect().width;
    document.body.removeChild(measure);

    if (charWidth === 0) return;
    // Row height is the painted line box, not the measured glyph box.
    const charHeight = TERM_LINE_PX;

    let lastCols = 0;
    let lastRows = 0;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        // Subtract pre padding (TERM_PADDING on each side, both axes), then
        // floor both dimensions. Flooring guarantees the content is never
        // larger than the viewport, so nothing is ever cropped — critical for
        // full-screen TUIs (e.g. lazygit) whose outer ASCII border must stay
        // intact on all sides. The sub-cell residual (< 1 col wide, < 1 row
        // tall) is absorbed by centering the <pre> in the container, which
        // splits it into even margins all around rather than a lopsided gap.
        const cols = Math.floor((width - TERM_PADDING * 2) / charWidth);
        const rows = Math.floor((height - TERM_PADDING * 2) / charHeight);
        if (cols > 0 && rows > 0 && (cols !== lastCols || rows !== lastRows)) {
          lastCols = cols;
          lastRows = rows;
          channelRef.current?.resize(cols, rows);
        }
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // No orientation-change handler needed: the per-line DOM diff compares each
  // line's source text, so after a resize the next full frame from tmux
  // updates every line that changed width naturally. Wiping pre.innerHTML
  // on orientation change would blank the terminal until the next 100ms tick
  // and could fire spuriously on iOS when the viewport height shifts.

  // Measure character dimensions (once) for mouse coordinate mapping
  useEffect(() => {
    const measure = document.createElement("span");
    measure.style.fontFamily = "'Menlo', 'Monaco', 'Courier New', monospace";
    measure.style.fontSize = `${TERM_FONT_SIZE}px`;
    measure.style.lineHeight = `${TERM_LINE_HEIGHT}`;
    measure.style.position = "absolute";
    measure.style.visibility = "hidden";
    measure.style.whiteSpace = "pre";
    measure.textContent = "X";
    document.body.appendChild(measure);
    charDimsRef.current = {
      width: measure.getBoundingClientRect().width,
      // Line box height, matching the row math and the painted <pre>.
      height: TERM_LINE_PX,
    };
    document.body.removeChild(measure);
  }, []);

  // Tap-to-position for panes that are *not* full-screen TUIs. A shell doesn't
  // enable mouse reporting, so there is no click for it to receive: real
  // terminals that offer this (iTerm's option-click) synthesize arrow keys,
  // and so do we. Now cheap, because the cursor's column finally arrives —
  // the distance to walk is a subtraction.
  //
  // Deliberately confined to the cursor's own line. Vertical movement in a
  // shell is history, not navigation, so a tap two lines up would summon a
  // previous command instead of moving a caret. A tap anywhere else does
  // nothing at all, which is easier to live with than a wrong guess.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || alternateOn) return;

    const handleClick = (e: MouseEvent) => {
      if (e.altKey || e.shiftKey || e.metaKey || e.ctrlKey) return; // selection intent
      const pos = cursorPosRef.current;
      const dims = charDimsRef.current;
      const channel = channelRef.current;
      if (!pos || !dims || !channel) return;
      // A drag that selected text is not a tap.
      const sel = typeof window !== "undefined" ? window.getSelection() : null;
      if (sel && !sel.isCollapsed) return;

      const pre = container.querySelector("pre");
      if (!pre) return;
      // Walk up to the line div that is a direct child of <pre>, so the index
      // is the frame line the operator actually touched.
      let node = e.target as HTMLElement | null;
      while (node && node.parentElement !== pre) node = node.parentElement;
      if (!node) return;
      const line = Array.prototype.indexOf.call(pre.children, node);
      if (line !== pos.line) return;

      const col = Math.max(0, Math.round((e.clientX - node.getBoundingClientRect().left) / dims.width));
      const delta = col - pos.col;
      if (delta === 0) return;
      channel.sendKeys(delta > 0 ? "Right" : "Left", Math.abs(delta));
    };

    container.addEventListener("click", handleClick);
    return () => container.removeEventListener("click", handleClick);
  }, [alternateOn]);

  // Native mouse + wheel listeners for alternate mode — forward clicks,
  // drags, right-clicks, and scroll to the focused TUI panel as SGR mouse
  // events. Wired on the container so mousedown can win over the React
  // click path, and move/up are on `window` so a drag that leaves the
  // terminal still produces a clean release.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !alternateOn) return;

    const coordsOf = (clientX: number, clientY: number): { col: number; row: number } | null => {
      if (!charDimsRef.current) return null;
      const pre = container.querySelector("pre");
      if (!pre) return null;
      const rect = pre.getBoundingClientRect();
      const x = clientX - rect.left - 8; // subtract pre padding (x)
      const y = clientY - rect.top - 8;  // subtract pre padding (y)
      return {
        col: Math.max(0, Math.floor(x / charDimsRef.current.width)),
        row: Math.max(0, Math.floor(y / charDimsRef.current.height)),
      };
    };

    // Browser button → SGR button code (0=left, 1=middle, 2=right).
    const mapButton = (btn: number): number => (btn === 1 ? 1 : btn === 2 ? 2 : 0);

    let dragging = false;
    let dragButton = 0;
    let lastDragCoord: { col: number; row: number } | null = null;

    // Hold Option (or Shift) to select instead of clicking through. This is
    // the same escape hatch Terminal.app and iTerm give you when an
    // application has grabbed the mouse: without it, a fullscreen TUI eats
    // every drag and there is no way to copy a line off the screen. The
    // browser's own selection is what does the work — we just decline to
    // preventDefault.
    const wantsSelection = (e: MouseEvent) => e.altKey || e.shiftKey;

    const handleMouseDown = (e: MouseEvent) => {
      if (wantsSelection(e)) return;
      const coords = coordsOf(e.clientX, e.clientY);
      if (!coords || !channelRef.current) return;
      // preventDefault (below) suppresses the browser's default focus-on-click,
      // so focus would stay on whatever held it (e.g. the chat composer in a
      // split view) and our document key capture would route typing there.
      // Focus the container explicitly so clicking the TUI grabs the keyboard.
      try { container.focus({ preventScroll: true }); } catch { container.focus(); }
      e.preventDefault();
      dragButton = mapButton(e.button);
      dragging = true;
      lastDragCoord = coords;
      channelRef.current.sendMouse(coords.col, coords.row, dragButton, "down");
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging) return;
      const coords = coordsOf(e.clientX, e.clientY);
      if (!coords || !channelRef.current) return;
      // Only emit when the cell actually changes — don't flood the wire.
      if (lastDragCoord && coords.col === lastDragCoord.col && coords.row === lastDragCoord.row) return;
      lastDragCoord = coords;
      channelRef.current.sendMouse(coords.col, coords.row, dragButton, "drag");
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (!dragging) return;
      const coords = coordsOf(e.clientX, e.clientY) ?? lastDragCoord;
      dragging = false;
      if (!coords || !channelRef.current) {
        lastDragCoord = null;
        return;
      }
      channelRef.current.sendMouse(coords.col, coords.row, dragButton, "up");
      lastDragCoord = null;
    };

    const handleWheel = (e: WheelEvent) => {
      const coords = coordsOf(e.clientX, e.clientY);
      if (!coords || !channelRef.current) return;
      e.preventDefault();
      const direction = e.deltaY > 0 ? "scroll_down" : "scroll_up";
      channelRef.current.sendMouse(coords.col, coords.row, 0, direction);
      if (direction === "scroll_up") setFollowing(false);
    };

    // Suppress the browser context menu so right-click reaches the TUI —
    // unless the operator is holding the selection modifier, in which case
    // they want the menu (and its Copy item).
    const handleContextMenu = (e: MouseEvent) => {
      if (wantsSelection(e)) return;
      e.preventDefault();
    };

    container.addEventListener("mousedown", handleMouseDown);
    container.addEventListener("wheel", handleWheel, { passive: false });
    container.addEventListener("contextmenu", handleContextMenu);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      container.removeEventListener("mousedown", handleMouseDown);
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("contextmenu", handleContextMenu);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [alternateOn]);

  // Touch listener for alternate mode — lock page scroll and forward
  // vertical drag gestures to the focused TUI panel as scroll events.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !alternateOn) return;

    // Emit one scroll event per this many pixels of vertical drag.
    const STEP_PX = 20;

    let startX = 0;
    let startY = 0;
    let lastFiredY = 0;
    let anchorCol = 0;
    let anchorRow = 0;

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      lastFiredY = t.clientY;
      if (charDimsRef.current) {
        const pre = container.querySelector("pre");
        const rect = (pre ?? container).getBoundingClientRect();
        const x = t.clientX - rect.left - 8; // subtract pre padding (x)
        const y = t.clientY - rect.top - 8;  // subtract pre padding (y)
        anchorCol = Math.max(0, Math.floor(x / charDimsRef.current.width));
        anchorRow = Math.max(0, Math.floor(y / charDimsRef.current.height));
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      if (!channelRef.current) return;
      const t = e.touches[0];
      // Only preventDefault once we're clearly in a vertical drag, so
      // horizontal taps/clicks still work.
      const dy = t.clientY - startY;
      const dx = t.clientX - startX;
      if (Math.abs(dy) > Math.abs(dx)) {
        e.preventDefault();
      }
      const delta = t.clientY - lastFiredY;
      if (Math.abs(delta) < STEP_PX) return;
      const steps = Math.trunc(delta / STEP_PX);
      lastFiredY += steps * STEP_PX;
      // Finger drags down → content moves down → scroll_up in TUI terms.
      const direction = steps > 0 ? "scroll_up" : "scroll_down";
      for (let i = 0; i < Math.abs(steps); i++) {
        channelRef.current.sendMouse(anchorCol, anchorRow, 0, direction);
      }
      if (direction === "scroll_up") setFollowing(false);
    };

    container.addEventListener("touchstart", handleTouchStart, { passive: true });
    container.addEventListener("touchmove", handleTouchMove, { passive: false });
    return () => {
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
    };
  }, [alternateOn]);

  // When keyboard opens/closes, keep terminal scrolled to bottom if it was there
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !wasAtBottomRef.current) return;
    // Wait one frame for layout to settle after keyboard toggle
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }, [showKeyboard]);

  // Grab keyboard focus whenever the terminal is the active tab — not just
  // once on mount. The chat composer <textarea> stays mounted behind the
  // terminal (tabs are zIndex-stacked, not unmounted), so if it held focus
  // when you switched here, the document-level keydown handler's INPUT/TEXTAREA
  // guard would silently drop every physical key — including Enter — into that
  // hidden textarea. Re-focusing the container on activation keeps focus where
  // key capture expects it. preventScroll avoids yanking the page on switch.
  const focusActive = keyboardActive ?? active;
  useEffect(() => {
    if (!focusActive) return;
    const el = containerRef.current;
    if (!el) return;
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
  }, [focusActive]);

  // Track manual scroll position for atBottom state
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let lastAtBottom = wasAtBottomRef.current;
    const handleScroll = () => {
      const atBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight < 40;
      if (atBottom !== lastAtBottom) {
        lastAtBottom = atBottom;
        wasAtBottomRef.current = atBottom;
        onAtBottomChange?.(atBottom);
      }
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [onAtBottomChange]);

  const handleRevive = useCallback(async () => {
    // Some narratives can't be revived in place — external sessions (no tmux
    // process, no known agent to resume) and absorbed imports. For those,
    // "revive" means twinning: spawn a brane-managed agent that continues from
    // this narrative (the parent opens the spawn dialog prefilled with twin).
    if (revivesAsTwin(role) && onTwin) {
      onTwin();
      return;
    }
    setReviving(true);
    try {
      const revived = await reviveNarrative(conn, nid);
      // The daemon is the authority on what actually happened. If it continued
      // this narrative as a twin rather than restarting it, reconnecting here
      // would mirror a pane that is never coming back — hand the caller the id
      // that is actually alive instead.
      if (revived.nid && revived.nid !== nid) {
        onRevived?.(revived.nid);
        return;
      }
      setTerminated(false);
      // Reconnect the terminal channel
      channelRef.current?.close();
      const channel = createTerminalChannel({
        conn,
        nid,
        onFrame: handleFrame,
        onTerminated: () => setTerminated(true),
      });
      channelRef.current = channel;
      channel.start();
    } catch (err) {
      console.error("Revive failed:", err);
    } finally {
      setReviving(false);
    }
  }, [conn, nid, handleFrame, role, onTwin, onRevived]);
  handleReviveRef.current = handleRevive;

  const handleMacro = useCallback((macro: { label: string; text?: string; keys?: string }) => {
    if (!channelRef.current) return;
    if (macro.keys) {
      channelRef.current.sendKeys(macro.keys);
      return;
    }
    if (!macro.text) return;
    const parts = macro.text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]) channelRef.current.sendKeys(parts[i]);
      if (i < parts.length - 1) channelRef.current.sendKeys("Enter");
    }
  }, []);

  const handleSendKeys = useCallback((keys: string) => {
    channelRef.current?.sendKeys(keys);
    trackScrollIntent(keys);
  }, [trackScrollIntent]);

  const handleControl = useCallback((control: Control) => {
    if (!channelRef.current) return;
    if (control.action === "transcript") {
      // ^O toggles Claude Code's verbose transcript; follow with a clean DOM
      // refresh so stale wrapped lines don't linger (as the old 🪗 button did).
      channelRef.current.sendKeys("C-o");
      cleanRefresh();
      return;
    }
    if (control.action === "paste") {
      void handlePasteButton();
      return;
    }
    if (control.keys) {
      channelRef.current.sendKeys(control.keys);
      trackScrollIntent(control.keys);
    }
  }, [cleanRefresh, trackScrollIntent, handlePasteButton]);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
      <style>{CURSOR_BLINK_KEYFRAMES}</style>
      <style>{BLOCK_GLYPH_STYLES}</style>
      <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {terminated && (
          <div style={{
            position: "absolute",
            top: 0, left: 0, right: 0, bottom: 0,
            zIndex: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0, 0, 0, 0.85)",
          }}>
            {(
              <>
                <div style={{
                  position: "absolute",
                  left: 0, right: 0,
                  top: "50%",
                  transform: "translateY(calc(-100% - 36px))",
                  textAlign: "center",
                  color: "#888",
                  fontSize: 15,
                  fontFamily: "system-ui, -apple-system, sans-serif",
                  pointerEvents: "none",
                }}>Session ended</div>
                <button
                  onClick={() => handleRevive()}
                  disabled={reviving}
                  style={{
                    padding: "10px 24px",
                    borderRadius: 8,
                    border: "1px solid #4caf50",
                    backgroundColor: reviving ? "#1c1c1e" : "#2e7d32",
                    color: "#fff",
                    fontSize: 15,
                    fontWeight: "600",
                    cursor: reviving ? "default" : "pointer",
                    opacity: reviving ? 0.6 : 1,
                    fontFamily: "system-ui, -apple-system, sans-serif",
                  }}
                >
                  {/* The same verbs as the 🦠 menu and the lifecycle line the
                      press will write: /twin for roles with nothing to resume,
                      Revive for an agent, Restart for a utility command. */}
                  {reviving
                    ? (role === "utility" ? "Restarting…" : "Reviving…")
                    : revivesAsTwin(role) ? "/twin" : role === "utility" ? "Restart" : "Revive"}
                </button>
              </>
            )}
          </div>
        )}
        <div
          ref={containerRef}
          tabIndex={0}
          style={{
            flex: 1,
            minHeight: 0,
            overflow: alternateOn ? "hidden" : "auto",
            backgroundColor: "#111",
            outline: "none",
            WebkitOverflowScrolling: "touch",
            touchAction: alternateOn ? "none" : "auto",
            // Alternate-screen (full-screen TUI): cols/rows are floored, so up
            // to one cell of slack remains on each axis. Centering splits that
            // slack into even margins on all four sides — a bordered TUI
            // (lazygit, etc.) then sits symmetrically framed instead of
            // hugging one edge with the gap dumped on the opposite side.
            // Centering is done with auto margins on the <pre> (see below)
            // rather than justify/align center, because auto margins collapse
            // to zero on overflow: if the tmux grid is momentarily larger than
            // this viewport (another, bigger client set the window size and
            // the daemon hasn't re-fit it yet), flex-end/flex-start anchoring
            // takes over and pins the bottom-left — keeping a TUI's input box
            // and status line visible — where centering would clip both ends.
            // Scrollback mode keeps normal top-anchored flow so scrolling works.
            ...(alternateOn
              ? { display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "flex-start" }
              : {}),
          }}
        >
          <pre
            style={{
              // Auto margins center the pane when it fits (they absorb the
              // free space on both axes); on overflow they resolve to zero and
              // the container's flex-end/flex-start anchoring keeps the
              // bottom-left corner visible. Scrollback mode stays margin: 0 in
              // normal flow.
              margin: alternateOn ? "auto" : 0,
              padding: TERM_PADDING,
              fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
              fontSize: TERM_FONT_SIZE,
              lineHeight: TERM_LINE_HEIGHT,
              color: "#e0e0e0",
              whiteSpace: "pre",
              wordWrap: "normal",
              overflowX: "auto",
              cursor: alternateOn ? "pointer" : "default",
            }}
          />
        </div>
      </div>
      {/* Paste fallback sheet: a real editable, so the OS paste menu has
          something to paste into when the Clipboard API won't read for us.
          The document-level paste listener catches it and closes this. */}
      {pastePrompt && (
        <div style={{
          padding: "8px 10px",
          backgroundColor: "#1a1a1a",
          borderTop: "1px solid #444",
          flexShrink: 0,
        }}>
          <div style={{ color: "#aaa", fontSize: 12, marginBottom: 6, fontFamily: "monospace" }}>
            Paste here (long-press → Paste), or type and Send
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <textarea
              autoFocus
              ref={pasteInputRef}
              rows={2}
              style={{
                flex: 1,
                backgroundColor: "#111",
                color: "#e0e0e0",
                border: "1px solid #555",
                borderRadius: 6,
                padding: 6,
                fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
                fontSize: 13,
                resize: "vertical" as const,
              }}
            />
            <button
              onClick={() => {
                const value = pasteInputRef.current?.value ?? "";
                if (value) channelRef.current?.sendPaste(value);
                setPastePrompt(false);
              }}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid #555",
                backgroundColor: "#252525",
                color: "#ccc",
                fontSize: 13,
                fontFamily: "monospace",
                cursor: "pointer",
              }}
            >
              Send
            </button>
            <button
              onClick={() => setPastePrompt(false)}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid #555",
                backgroundColor: "#1e1e1e",
                color: "#888",
                fontSize: 13,
                fontFamily: "monospace",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {/* Full keyboard (toggleable) — rendered above the quick bar so the bar
          (and its 🎹 toggle) stays anchored at the bottom and doesn't shift. */}
      {showKeyboard && <TerminalKeyboard sendKeys={handleSendKeys} />}
      {/* Quick bar: [🎹] | [macros] | [keys + Ret] — all centered */}
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          justifyContent: "center",
          gap: 8,
          padding: "6px 8px",
          paddingBottom: "max(6px, env(safe-area-inset-bottom))" as any,
          minHeight: 53,
          boxSizing: "border-box",
          backgroundColor: "#1a1a1a",
          borderTop: "1px solid rgb(216, 216, 216)",
          flexShrink: 0,
          alignItems: "center",
        }}
      >
        {/* Keyboard toggle */}
        <button
          onClick={() => setShowKeyboard((v) => !v)}
          style={{
            padding: "6px 8px",
            borderRadius: 6,
            border: `1px solid ${showKeyboard ? "#4caf50" : "#555"}`,
            backgroundColor: showKeyboard ? "#2e7d32" : "#252525",
            color: showKeyboard ? "#fff" : "#ccc",
            fontSize: 15,
            lineHeight: "18px",
            fontFamily: "monospace",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          🎹
        </button>
        {/* Divider */}
        <div style={{ width: 1, height: 24, backgroundColor: "#333", flexShrink: 0 }} />
        {/* Macro menu */}
        <MacroMenu onSelect={handleMacro} />
        {/* Controls menu (🦾): ^C, ^O accordion, paste, and scrollback nav.
            Paste is the touch path to the clipboard, since mobile fires no
            paste event without an editable to fire it into; it lives in the
            menu rather than on the bar so the bar fits narrower phones. */}
        <ControlsMenu onControl={handleControl} />
        {/* Divider */}
        <div style={{ width: 1, height: 24, backgroundColor: "#333", flexShrink: 0 }} />
        {/* Quick keys */}
        {QUICK_KEYS.map((qk) => (
          <FlashButton
            key={qk.label}
            onPress={() => channelRef.current?.sendKeys(qk.keys)}
            style={{
              padding: "6px 8px",
              borderRadius: 6,
              border: "1px solid #555",
              backgroundColor: "#1e1e1e",
              color: "#aaa",
              fontSize: 14,
              fontFamily: "monospace",
              cursor: "pointer",
              whiteSpace: "nowrap",
              minWidth: 28,
              textAlign: "center" as const,
            }}
          >
            {qk.label}
          </FlashButton>
        ))}
        {/* Ret */}
        <FlashButton
          onPress={() => channelRef.current?.sendKeys("Enter")}
          style={{
            padding: "6px 8px",
            borderRadius: 6,
            border: "1px solid #555",
            backgroundColor: "#1e1e1e",
            color: "#aaa",
            fontSize: 14,
            fontFamily: "monospace",
            cursor: "pointer",
            whiteSpace: "nowrap",
            minWidth: 34,
            textAlign: "center" as const,
          }}
        >
          Ret
        </FlashButton>
      </div>
    </div>
  );
});

export default memo(TerminalPane);
