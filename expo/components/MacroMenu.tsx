import { useState, useRef, useEffect } from "react";
import MenuPanel, { menuHueRgb } from "./MenuPanel";

export interface Macro {
  label: string;
  text?: string;
  keys?: string;
}

const MACROS: Macro[] = [
  { label: "live loop", text: "live loop\n" },
  { label: "live loop (full)", text: "Use your brane MCP server's read_protocol tool to read the 'LIVE_loop' protocol, then commence LIVE looping. All LIVE loop tools (narrate, listen, whoami, etc.) come from the brane MCP server.\n" },
  { label: "narrate more", text: "narrate more per LIVE loop protocol\n" },
  { label: "continue if unblocked", text: "continue if unblocked\n" },
  { label: "/ramify", text: "/ramify\n" },
];

interface MacroMenuProps {
  onSelect: (macro: Macro) => void;
}

export default function MacroMenu({ onSelect }: MacroMenuProps) {
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

  return (
    <div ref={menuRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Macros"
        aria-expanded={open}
        style={{
          padding: "6px 8px",
          borderRadius: 6,
          border: `1px solid ${open ? "rgba(255,120,90,0.9)" : "#555"}`,
          backgroundColor: open ? "#6e2f24" : "#252525",
          color: open ? "#fff" : "#ccc",
          fontSize: 14,
          lineHeight: "18px",
          fontFamily: "monospace",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        🥫▾
      </button>
      {open && (
        <MenuPanel
          hue="tomato"
          style={{
            bottom: "calc(100% + 4px)",
            left: 0,
            padding: 4,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            minWidth: 180,
          }}
        >
          {MACROS.map((macro) => (
            <button
              key={macro.label}
              onClick={() => {
                onSelect(macro);
                setOpen(false);
              }}
              style={{
                padding: "10px 14px",
                borderRadius: 6,
                border: "none",
                backgroundColor: "transparent",
                color: "#ccc",
                fontSize: 14,
                fontFamily: "monospace",
                cursor: "pointer",
                textAlign: "left",
                whiteSpace: "nowrap",
              }}
              onMouseEnter={(e) => {
                (e.target as HTMLElement).style.backgroundColor = `rgba(${menuHueRgb("tomato")}, 0.18)`;
              }}
              onMouseLeave={(e) => {
                (e.target as HTMLElement).style.backgroundColor = "transparent";
              }}
            >
              {macro.label}
            </button>
          ))}
        </MenuPanel>
      )}
    </div>
  );
}
