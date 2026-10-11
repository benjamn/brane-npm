import { useEffect, useRef } from "react";
import MenuPanel, { menuHueRgb, type MenuHue } from "./MenuPanel";

export interface ContextMenuItem {
  label: string;
  // Optional emoji/icon rendered to the left of the label with a CSS gap.
  // Splitting the icon out keeps the gap from being controlled by the
  // emoji font's own whitespace metrics, which can render adjacent spaces
  // wider than the surrounding text font.
  icon?: string;
  onPress: () => void;
}

// Where the menu sits relative to its trigger:
//   "below"  — drops beneath the trigger (default; the card-header idiom).
//   "beside" — vertically centered on the trigger's line, so a compact
//              single-item menu on a list row doesn't spill onto the row below.
export type ContextMenuAlign = "below" | "beside";

export default function ContextMenu({ items, onClose, align = "below", hue = "green" }: {
  items: ContextMenuItem[];
  onClose: () => void;
  align?: ContextMenuAlign;
  // Defaults to the 🦠 green every context menu used to be. Pass a hue when the
  // thing that opened the menu has a color of its own — the list's status
  // badges do — so the panel and its anchor read as one sign.
  hue?: MenuHue;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        e.preventDefault();
        e.stopPropagation();
        // Also swallow the subsequent click event (mousedown alone doesn't prevent it)
        document.addEventListener("click", (ce) => {
          ce.preventDefault();
          ce.stopPropagation();
        }, { capture: true, once: true });
        onClose();
      }
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [onClose]);

  return (
    <MenuPanel
      ref={menuRef}
      hue={hue}
      style={{
        right: 16,
        // "below" drops under the trigger; "beside" centers on its line.
        top: align === "beside" ? "50%" : "calc(100% + 4px)",
        transform: align === "beside" ? "translateY(-50%)" : undefined,
        padding: 4,
        display: "flex",
        flexDirection: "column",
        gap: 2,
        minWidth: 120,
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          onClick={(e) => { e.stopPropagation(); item.onPress(); }}
          style={{
            padding: "10px 14px",
            borderRadius: 6,
            border: "none",
            backgroundColor: "transparent",
            color: "#ccc",
            fontSize: 15,
            lineHeight: "21px",
            cursor: "pointer",
            textAlign: "left",
            whiteSpace: "nowrap",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
          onPointerEnter={(e) => {
            (e.currentTarget as HTMLElement).style.backgroundColor = `rgba(${menuHueRgb(hue)}, 0.18)`;
          }}
          onPointerLeave={(e) => {
            (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
          }}
        >
          {item.icon ? <span style={{ fontSize: 20, lineHeight: "20px" }}>{item.icon}</span> : null}
          <span>{item.label}</span>
        </button>
      ))}
    </MenuPanel>
  );
}
