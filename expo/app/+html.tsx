import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

// iOS Safari's text autosizing rescales text per-block based on a width heuristic.
// Without this rule short blocks (e.g., brief operator messages) render at the
// base CSS size while long blocks get boosted, making short messages *look*
// smaller in landscape. Forcing 100% pins text to our declared font sizes.
const textSizeAdjust = "html,body{-webkit-text-size-adjust:100%;text-size-adjust:100%}";

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, shrink-to-fit=no"
        />
        <meta name="theme-color" content="#141414" />
        <title>brane</title>
        {/* The link preview card — see the comment in public/index.html, which
            is what actually ships; this copy is kept in step with it. */}
        <meta property="og:site_name" content="brane" />
        <meta property="og:type" content="website" />
        <meta property="og:title" content="brane" />
        <meta property="og:description" content="Your agents, live — chat, terminal and files for every session, from any device on your tailnet." />
        <meta property="og:image" content="https://brane.organelle.dev/og/membrane.v1.png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content="膜 — the character for membrane, filled with a swirl of thin-film color on a dark ground" />
        <meta name="twitter:card" content="summary_large_image" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <ScrollViewStyleReset />
        {/* KaTeX lays its span tree out entirely in CSS — without this the math
            renders as a pile of overlapping glyphs. Vendored under public/ by
            `npm run sync:katex` rather than imported, because metro bundles a
            CSS import but never copies the fonts it references. The HTML export
            inlines the same stylesheet itself (src/math.ts). */}
        <link rel="stylesheet" href="/katex/katex.min.css" />
        {/* Kept in step with public/index.html, which is what actually ships —
            see the comment there for why the manifest cannot be left to the
            runtime <Head> in _layout.tsx. */}
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <style dangerouslySetInnerHTML={{ __html: textSizeAdjust }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
