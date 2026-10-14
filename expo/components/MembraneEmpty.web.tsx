import React, { useCallback, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { QuipLoop } from "@shared/membrane-quips";
import { MarkdownContent } from "./Markdown";
import { MO_GLYPH_BOX, MO_GLYPH_MARGIN } from "@shared/mo-glyph";
// By its full name: the size is web-only, and the bare "./Membrane" is the
// native stub to the type checker.
import Membrane, { MEMBRANE_SIDE } from "./Membrane.web";
import type { MembraneEmptyProps } from "./MembraneEmpty";

/**
 * The floor of the list screen: the 膜 membrane (see Membrane.web.tsx), as
 * the centered empty state when there are no narratives and the footer under
 * the last card when there are. An empty state's title and instruction sit
 * above the glyph, so the caption under it is the same in both. Motion props
 * pass straight through to the glyph.
 *
 * Under it, always, one line from src/shared/membrane-quips.ts, rendered as
 * markdown: a quip or a tip. It changes when the glyph is tapped and at no
 * other time — never on a timer — so it can be read at leisure, and anything
 * tappable in it stays where it was.
 *
 * The loop is the page's, not the component's: shuffled once when this
 * module loads, and carried across the empty state giving way to the footer,
 * so a tap always moves on to the next line of the same cycle.
 */
const LOOP = new QuipLoop();

export default function MembraneEmpty({ title, subtitle, ...motion }: MembraneEmptyProps) {
  const [caption, setCaption] = useState(() => LOOP.current());
  const onTap = useCallback(() => setCaption(LOOP.next()), []);
  return (
    <View style={styles.center}>
      {title || subtitle ? (
        <View style={styles.heading}>
          {title ? <Text style={styles.emptyText}>{title}</Text> : null}
          {subtitle ? <Text style={styles.emptySubtext}>{subtitle}</Text> : null}
        </View>
      ) : null}
      <Membrane {...motion} onTap={onTap} />
      <View style={styles.caption} accessibilityLiveRegion="polite">
        <MarkdownContent content={caption} caption />
      </View>
      <div aria-hidden style={{ height: CAPTION_FOOT }} />
    </View>
  );
}

// Scrolled to the bottom, the caption sits as far above the list's end as it
// sits below the ink. Above it: the box's empty band under the ink, the
// column's gap, and the caption's marginTop. Below it: the gap before this
// spacer, the spacer, and the column's padding. So the spacer is the band,
// plus 4 + 12, less 4 + 20.
const CAPTION_FOOT = `calc(${MEMBRANE_SIDE} * ${MO_GLYPH_MARGIN / MO_GLYPH_BOX} - 8px)`;

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
    gap: 4,
  },
  // As far above the ink as the caption is below it: the box's band above
  // the ink matches the band below, and this margin matches the caption's.
  heading: {
    alignItems: "center",
    marginBottom: 12,
  },
  emptyText: {
    color: "#666",
    fontSize: 16,
    textAlign: "center",
  },
  emptySubtext: {
    color: "#555",
    fontSize: 13,
    marginTop: 4,
    textAlign: "center",
  },
  // No width of its own: a line wraps only where the window does, less the
  // padding above, never early under a narrow glyph. The type is the
  // renderer's (captionMarkdownStyles in Markdown.tsx).
  caption: {
    marginTop: 12,
    alignSelf: "stretch",
    alignItems: "center",
  },
});
