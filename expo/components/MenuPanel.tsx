import { forwardRef } from "react";

// Shared popover-panel look for all of brane's floating menus: a translucent
// (or, with `opaque`, solid), slightly-tinted panel with a soft surrounding
// glow in one of its hues.
// Each menu picks a hue — either by what opens it (🦠 context, 🥫 macros, 🦾
// controls) or, for the narrative list's status badges, by what it is about:
// a menu hanging off LIVE / IDLE / DEAD glows in that word's own color, so the
// panel and the word it came from read as one sign. Everything else
// — position, padding, layout — is passed through via `style` so each menu
// keeps its own structure. Items inside should be transparent so the panel's
// hue shows through (use menuHueRgb() for a matching hover wash).

export type MenuHue = "green" | "tomato" | "blue" | "grey" | "yellow";

const HUE_RGB: Record<MenuHue, string> = {
  green: "140, 230, 170", // 🦠 context menu
  tomato: "255, 120, 90", // 🥫 macros
  blue: "120, 190, 255",  // 🦾 controls, and IDLE
  grey: "170, 175, 180",  // DEAD — lighter than the word it glows behind,
                          // because #666 casts no light of its own
  yellow: "255, 240, 90", // a switcher row's ⋯: not green, which there means
                          // the current machine and awake
};

// Dark backdrop tinted toward each hue, translucent (~75%) unless `opaque`.
const HUE_BG: Record<MenuHue, string> = {
  green: "34,50,42",
  tomato: "58,30,26",
  blue: "26,38,60",
  grey: "40,42,46",
  yellow: "52,46,22",
};

/** The hue's "r, g, b" string, for building matching hover/border colors. */
export function menuHueRgb(hue: MenuHue): string {
  return HUE_RGB[hue];
}

interface MenuPanelProps {
  hue: MenuHue;
  // A solid backdrop. The translucent one keeps a terminal readable under a
  // menu; over rows of text (the switcher's) it mixes theirs into the items'.
  opaque?: boolean;
  // A glow even on every side, for a menu that hangs beside its trigger
  // rather than dropping from it: no downward cast.
  evenGlow?: boolean;
  // Position / layout / sizing — merged over the hue defaults. Callers set
  // top/bottom/left/right, padding, display, gap, width, etc. here.
  style?: React.CSSProperties;
  children: React.ReactNode;
}

// forwardRef so callers that anchor an outside-click handler on the panel
// itself (e.g. ContextMenu) can grab the underlying div.
const MenuPanel = forwardRef<HTMLDivElement, MenuPanelProps>(function MenuPanel(
  { hue, opaque, evenGlow, style, children },
  ref,
) {
  const rgb = HUE_RGB[hue];
  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        // ~75% opaque unless `opaque`, and never blurred, so the terminal
        // beneath stays sharp and readable.
        backgroundColor: `rgba(${HUE_BG[hue]}, ${opaque ? 1 : 0.75})`,
        border: `1px solid rgba(${rgb}, 0.4)`,
        borderRadius: 8,
        zIndex: 100,
        boxShadow: [
          evenGlow ? "0 0 20px rgba(0,0,0,0.45)" : "0 6px 20px rgba(0,0,0,0.45)",
          evenGlow ? `0 0 14px rgba(${rgb}, 0.5)` : `0 4px 14px rgba(${rgb}, 0.5)`,
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
