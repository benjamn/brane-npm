import { useState } from "react";

export default function CopyButton({
  text,
  size = 11,
  padding = 8,
  marginLeft = 0,
  translateY = 0,
}: {
  text: string;
  size?: number;
  padding?: number;
  marginLeft?: number;
  /**
   * Optical lift, in px. The 📋 glyph hangs below the baseline of the text it
   * sits beside, and the smaller it gets the more that reads as a sag rather
   * than as alignment. Negative values raise it.
   */
  translateY?: number;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      // Both glyphs are now either hidden or aria-hidden, so the button would
      // otherwise have no accessible name at all.
      aria-label={copied ? `Copied ${text}` : `Copy ${text}`}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        if (typeof navigator !== "undefined" && navigator.clipboard) {
          navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
      }}
      style={{
        background: "none",
        border: "none",
        padding,
        margin: 0,
        marginLeft,
        cursor: "pointer",
        color: copied ? "#66d9a0" : "#888",
        fontSize: size,
        lineHeight: 1,
        fontFamily: "inherit",
        transform: translateY ? `translateY(${translateY}px)` : undefined,
        position: "relative",
      }}
    >
      {/* The 📋 never leaves the flow — it only goes invisible. It is what
          gives the button its width, and ✓ is the narrower glyph, so swapping
          one for the other would shrink the button and reflow whatever sits
          beside it for the 1.2s the confirmation is up. Keeping it also lets
          the ✓ center on the clipboard's box rather than on its own. */}
      <span style={{ visibility: copied ? "hidden" : "visible" }}>📋</span>
      {copied && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          ✓
        </span>
      )}
    </button>
  );
}
