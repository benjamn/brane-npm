import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { QuipLoop } from "@shared/membrane-quips";
import { MarkdownContent } from "./Markdown";
import type { MembraneProps } from "./Membrane";

// Native stub. The membrane itself — the 膜 glyph as a WebGL mask over a
// thin-film surface — lives in Membrane.web.tsx, set as the list's floor by
// MembraneEmpty.web.tsx; metro picks those for web and this for native, so no
// shader or canvas code reaches a native bundle. Native gets the same words,
// without the picture — and so without the tap that changes the caption.
export type MembraneEmptyProps = MembraneProps & {
  /** The line that names the state — "No narratives yet". Omitted under a
   *  populated list, where the glyph is a footer rather than a state. */
  title?: string;
  /** The one thing to do about it, when there is one; the glyph otherwise
   *  stands alone — it says enough. */
  subtitle?: string;
};

export default function MembraneEmpty({ title, subtitle }: MembraneEmptyProps) {
  const [caption] = useState(() => new QuipLoop().current());
  return (
    <View style={styles.center}>
      {title ? <Text style={styles.emptyText}>{title}</Text> : null}
      {subtitle ? <Text style={styles.emptySubtext}>{subtitle}</Text> : null}
      <View style={styles.caption}>
        <MarkdownContent content={caption} caption />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  emptyText: {
    color: "#666",
    fontSize: 16,
  },
  emptySubtext: {
    color: "#555",
    fontSize: 13,
    marginTop: 8,
    textAlign: "center",
  },
  caption: {
    marginTop: 12,
    alignSelf: "stretch",
  },
});
