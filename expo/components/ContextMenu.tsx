import { useEffect, useRef } from "react";
import { useIsFocused } from "@react-navigation/native";
import MenuPanel, { menuHueRgb, type MenuHue } from "./MenuPanel";

export interface ContextMenuItem {
  label: string;
  // Optional emoji/icon rendered to the left of the label with a CSS gap.
  // Splitting the icon out keeps the gap from being controlled by the
  // emoji font's own whitespace metrics, which can render adjacent spaces
  // wider than the surrounding text font.
  icon?: string;
  onPress: () => void;
  // Stay open after the press, the way the 🥫 and 🦾 menus do, so several
  // items can be tapped in a row. Otherwise the menu closes itself after
  // calling onPress: items need not (and the 🦠 menu's items do not) close it.
  keepOpen?: boolean;
  // Shown but not pressable: a slot whose action is under way (a daemon
  // row's "Waking…"), so the menu keeps its shape while it can't be used.
  // aria-disabled only, not the native attribute, so the item stays in the
  // tab order and a screen reader still announces the state.
  disabled?: boolean;
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
  // Screens behind the top one stay mounted, so a menu left open on a screen
  // the operator navigated away from would keep its outside-tap catcher on the
  // document — and swallow the first tap on the screen in front, a menu handed
  // off to it included. Leaving the screen closes the menu instead: an item
  // that navigates closes it, whether or not it keeps it open in place.
  const focused = useIsFocused();
  useEffect(() => {
    if (!focused) onClose();
  }, [focused, onClose]);

  useEffect(() => {
    if (!focused) return;
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
  }, [focused, onClose]);

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
          aria-disabled={item.disabled || undefined}
          onClick={(e) => {
            e.stopPropagation();
            if (item.disabled) return;
            item.onPress();
            if (!item.keepOpen) onClose();
          }}
          style={{
            opacity: item.disabled ? 0.5 : 1,
            padding: "10px 14px",
            borderRadius: 6,
            border: "none",
            backgroundColor: "transparent",
            color: "#ccc",
            fontSize: 15,
            lineHeight: "21px",
            cursor: item.disabled ? "default" : "pointer",
            textAlign: "left",
            whiteSpace: "nowrap",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
          onPointerEnter={(e) => {
            if (item.disabled) return;
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
