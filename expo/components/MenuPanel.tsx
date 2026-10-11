import { forwardRef } from "react";

// Shared popover-panel look for all of brane's floating menus: a translucent,
// slightly-tinted panel with a soft surrounding glow in one of four hues.
// Each menu picks a hue — either by what opens it (🦠 context, 🥫 macros, 🦾
// controls) or, for the narrative list's status badges, by what it is about:
// a menu hanging off LIVE / IDLE / DEAD glows in that word's own color, so the
// panel and the word it came from read as one sign. Everything else
// — position, padding, layout — is passed through via `style` so each menu
// keeps its own structure. Items inside should be transparent so the panel's
// hue shows through (use menuHueRgb() for a matching hover wash).

export type MenuHue = "green" | "tomato" | "blue" | "grey";

const HUE_RGB: Record<MenuHue, string> = {
  green: "140, 230, 170", // 🦠 context menu
  tomato: "255, 120, 90", // 🥫 macros
  blue: "120, 190, 255",  // 🦾 controls, and IDLE
  grey: "170, 175, 180",  // DEAD — lighter than the word it glows behind,
                          // because #666 casts no light of its own
};

// Translucent (~75%) dark backdrop tinted toward each hue.
const HUE_BG: Record<MenuHue, string> = {
  green: "rgba(34,50,42,0.75)",
  tomato: "rgba(58,30,26,0.75)",
  blue: "rgba(26,38,60,0.75)",
  grey: "rgba(40,42,46,0.75)",
};

/** The hue's "r, g, b" string, for building matching hover/border colors. */
export function menuHueRgb(hue: MenuHue): string {
  return HUE_RGB[hue];
}

interface MenuPanelProps {
  hue: MenuHue;
  // Position / layout / sizing — merged over the hue defaults. Callers set
  // top/bottom/left/right, padding, display, gap, width, etc. here.
  style?: React.CSSProperties;
  children: React.ReactNode;
}

// forwardRef so callers that anchor an outside-click handler on the panel
// itself (e.g. ContextMenu) can grab the underlying div.
const MenuPanel = forwardRef<HTMLDivElement, MenuPanelProps>(function MenuPanel(
  { hue, style, children },
  ref,
) {
  const rgb = HUE_RGB[hue];
  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        // ~75% opaque, intentionally NOT blurred so the terminal beneath stays
        // sharp and readable.
        backgroundColor: HUE_BG[hue],
        border: `1px solid rgba(${rgb}, 0.4)`,
        borderRadius: 8,
        zIndex: 100,
        boxShadow: [
          "0 6px 20px rgba(0,0,0,0.45)",
          `0 4px 14px rgba(${rgb}, 0.5)`,
          `0 0 24px rgba(${rgb}, 0.32)`,
          `0 0 50px rgba(${rgb}, 0.18)`,
        ].join(", "),
        ...style,
      }}
    >
      {children}
    </div>
  );
});

export default MenuPanel;
