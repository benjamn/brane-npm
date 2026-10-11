import React from "react";
import { StyleSheet, Text } from "react-native";

// Native stub. The real canvas-based renderer lives in PdfView.web.tsx; metro
// picks that for web and this for native, so pdfjs-dist is never bundled into
// the native app. A native inline renderer (react-native-pdf) is a separate
// follow-up.
export function PdfView(_props: { url: string }) {
  return <Text style={styles.notice}>PDF preview is available on the web app.</Text>;
}

const styles = StyleSheet.create({
  notice: { color: "#888", padding: 12 },
});

export default PdfView;
