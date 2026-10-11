// React Native Web accepts a handful of DOM/CSS escape hatches that the stock
// react-native type definitions don't model. We use them deliberately on the
// web build (the app only ever runs as a web PWA), so teach the types about
// them rather than sprinkling `as any` at every call site.
import "react-native";

declare module "react-native" {
  // RNW serializes `dataSet` into `data-*` attributes on the rendered DOM node.
  // We tag panes with `dataSet={{ pane: "terminal" }}` so the document-level
  // pointer handler can map a click back to its pane.
  interface ViewProps {
    dataSet?: Record<string, string | number | undefined>;
  }
  interface TextProps {
    dataSet?: Record<string, string | number | undefined>;
  }

  // RNW passes through web-only CSS properties in style objects.
  interface ViewStyle {
    whiteSpace?: "normal" | "nowrap" | "pre" | "pre-wrap" | "pre-line" | "break-spaces";
  }
  interface TextStyle {
    whiteSpace?: "normal" | "nowrap" | "pre" | "pre-wrap" | "pre-line" | "break-spaces";
  }
}
