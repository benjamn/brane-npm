import React from "react";
import { StyleSheet, Text, View } from "react-native";
import Membrane from "./Membrane";
import type { MembraneEmptyProps } from "./MembraneEmpty";

/**
 * The floor of the list screen: the 膜 membrane (see Membrane.web.tsx), as
 * the centered empty state when there are no narratives and the footer under
 * the last card when there are; either way any instruction line rides with
 * it. Motion props pass straight through to the glyph.
 */
export default function MembraneEmpty({ title, subtitle, ...motion }: MembraneEmptyProps) {
  return (
    <View style={styles.center}>
      <Membrane {...motion} />
      {title ? <Text style={styles.emptyText}>{title}</Text> : null}
      {subtitle ? <Text style={styles.emptySubtext}>{subtitle}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
    gap: 4,
  },
  emptyText: {
    color: "#666",
    fontSize: 16,
    marginTop: 20,
  },
  emptySubtext: {
    color: "#555",
    fontSize: 13,
    marginTop: 4,
    textAlign: "center",
  },
});
