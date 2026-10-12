import { useState, useRef, useEffect } from "react";
import MenuPanel, { menuHueRgb } from "./MenuPanel";

// A common terminal control rendered as a compact keycap `[code emoji]`.
// `keys` is sent verbatim to tmux via the channel; `action`s are special-cased
// by the caller: ^O (toggle verbose transcript) also needs a clean DOM
// refresh, not just a keystroke, and paste opens onto the OS clipboard rather
// than onto a keystroke at all. `label` is the hover/long-press tooltip —
// option-C keycaps show only code + emoji to stay dense.
export interface Control {
  code: string;       // key notation, leftmost (e.g. "^C", "⌃End")
  emoji: string;      // operator-chosen glyph hint
  label: string;      // tooltip / a11y description
  keys?: string;      // tmux key name to send (omitted for custom actions)
  action?: "transcript" | "paste" | "clear-history";
}

// Row 1 — common control sequences. Labels follow Claude Code's keybindings.md.
// Paste lives here rather than on the quick bar so the bar fits phones
// narrower than a Max; it took the slot of ^R (history search), which is a
// keyboard-shaped action nobody reaches for from a touch menu.
const COMMON_CONTROLS: Control[] = [
  { code: "^C", emoji: "🛑", label: "cancel / interrupt", keys: "C-c" },
  { code: "^O", emoji: "🪗", label: "verbose transcript", action: "transcript" },
  { code: "^T", emoji: "✅", label: "toggle todos", keys: "C-t" },
  { code: "^V", emoji: "📋", label: "paste clipboard", action: "paste" },
  { code: "⇧⇥", emoji: "🚦", label: "cycle permission mode", keys: "BTab" },
  { code: "^B", emoji: "😶‍🌫️", label: "background task", keys: "C-b" },
  { code: "^D", emoji: "🪂", label: "exit (EOF on empty input)", keys: "C-d" },
  { code: "^J", emoji: "↩️", label: "newline without submitting", keys: "C-j" },
  { code: "^L", emoji: "🧹", label: "clear / redraw", keys: "C-l" },
];

// Row 2 — scrollback nav (Claude's virtual scrollback in fullscreen). Double
// arrows = jump, single arrows = page, so they read distinctly. The cells are
// centered and the font is monospace, so `End` gets a leading no-break space
// to match `Page`'s four columns — otherwise its emoji sits half a character
// off the ⬇️ directly beneath it.
const NAV_CONTROLS: Control[] = [
  { code: "Home", emoji: "⏫", label: "jump to top", keys: "C-Home" },
  { code: " End", emoji: "⏬", label: "jump to bottom", keys: "C-End" },
  { code: "Page", emoji: "⬆️", label: "page up", keys: "PPage" },
  { code: "Page", emoji: "⬇️", label: "page down", keys: "NPage" },
];

// Row 3 — not a key at all: drops the pane's tmux scrollback, where stale
// redraws pile up (Claude's trust dialog drawn at every width a new session
// passed through, say). The live screen is untouched; the history is gone, so
// it sits on its own row rather than among keys pressed in passing.
const CLEAR_HISTORY: Control = { code: "Clear", emoji: "🧽", label: "clear scrollback (keeps the screen)", action: "clear-history" };

interface ControlsMenuProps {
  onControl: (control: Control) => void;
}

export default function ControlsMenu({ onControl }: ControlsMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const renderKeycap = (control: Control) => (
    <button
      key={control.label}
      title={control.label}
      onClick={() => {
        // Stay open on tap: many of these (Page up/down especially) are made to
        // be pressed repeatedly. Dismiss via outside-tap or the 🦾 toggle.
        // Paste and Clear are the exceptions — one-shot, and the operator wants
        // to see the terminal (or paste's fallback sheet) the moment they land.
        if (control.action === "paste" || control.action === "clear-history") setOpen(false);
        onControl(control);
      }}
      style={{
        display: "inline-flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 0,
        gap: 5,
        padding: "7px 8px",
        borderRadius: 6,
        // Transparent, border-less cells like the 🦠 ContextMenu rows — keeps
        // the menu feeling airy (the panel's hue shows through) rather than a
        // dense block of pills. Hover paints a faint blue highlight.
        border: "none",
        backgroundColor: "transparent",
        color: "#e0e0e0",
        fontSize: 13,
        lineHeight: "16px",
        fontFamily: "monospace",
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.backgroundColor = `rgba(${menuHueRgb("blue")}, 0.2)`;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
      }}
    >
      <span>{control.code}</span>
      <span style={{ fontSize: 14 }}>{control.emoji}</span>
    </button>
  );

  // The common-controls grid (3 columns) defines the panel's width; the nav
  // grid (2 columns) then lays out as ⌃Home/⌃End on one line, PgUp/PgDn the
  // next, staying within that width to keep the panel slim.
  const commonGroupStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 6,
  };
  const navGroupStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(2, 1fr)",
    gap: 6,
  };

  return (
    <div ref={menuRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          padding: "6px 8px",
          borderRadius: 6,
          border: `1px solid ${open ? "rgba(120,190,255,0.9)" : "#555"}`,
          backgroundColor: open ? "#27496f" : "#252525",
          color: open ? "#fff" : "#ccc",
          fontSize: 14,
          lineHeight: "18px",
          fontFamily: "monospace",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        🦾▾
      </button>
      {open && (
        <MenuPanel
          hue="blue"
          style={{
            bottom: "calc(100% + 4px)",
            left: 0,
            padding: 8,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            // Definite width so the 3-col / 2-col grids equalize into a uniform,
            // justified layout (set to comfortably fit three common keycaps).
            width: 220,
            maxWidth: "92vw",
          }}
        >
          <div style={commonGroupStyle}>{COMMON_CONTROLS.map(renderKeycap)}</div>
          <div style={{ height: 1, backgroundColor: `rgba(${menuHueRgb("blue")}, 0.25)` }} />
          <div style={navGroupStyle}>{NAV_CONTROLS.map(renderKeycap)}</div>
          <div style={{ height: 1, backgroundColor: `rgba(${menuHueRgb("blue")}, 0.25)` }} />
          <div style={{ display: "grid" }}>{renderKeycap(CLEAR_HISTORY)}</div>
        </MenuPanel>
      )}
    </div>
  );
}
