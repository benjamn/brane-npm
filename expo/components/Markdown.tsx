import { memo, useMemo } from "react";
import { Text, View, Linking, Platform, ScrollView } from "react-native";
import { Markdown as MarkdownRenderer } from "@docren/react-native-markdown";
import type { StyleMap } from "@docren/react-native-markdown";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";
import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { math } from "micromark-extension-math";
import { mathFromMarkdown } from "mdast-util-math";
import { HighlightedCode } from "@/components/CodeView";
import { DiagramView } from "@/components/DiagramView";
import { NID_REF_PATTERN, narrativeIdLinks } from "@shared/markdown-nids";
import { mentionLinks } from "@shared/markdown-mentions";
import { listIsLoose, listItemRowMarginTop, listParagraphOverride } from "@shared/markdown-lists";
import { protocolLinks } from "@shared/markdown-protocols";
import { MATH_BLOCK_CSS, prepareMathMarkdown, renderMathHtml } from "@shared/markdown-math";
import { inAppLinkProps, narrativeHref } from "@/lib/routes";
import { useMarkdownLinks } from "@/components/MarkdownLinks";
import { useHorizontalPanGuard } from "@/lib/panGuard";
import { FOLD_COLOR, FOLD_LINK_SCHEME } from "@shared/narrative-format";

const monoFont = Platform.select({ ios: "Menlo", default: "monospace" });

// Matches anything that looks like a URL scheme at the start of a string.
// Used to distinguish real URLs from relative paths in link hrefs.
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

const isWeb = Platform.OS === "web";

/** Props for a link that leaves the app.
 *
 *  Note there's no `onPress` alongside `href` on web: RNW's click handler calls
 *  `onPress` *without* preventing the default, so having both would open the
 *  URL twice — once via `Linking.openURL` (a `window.open`, and so popup-blocker
 *  bait) and once by the anchor itself. */
function externalLinkProps(url: string): Record<string, unknown> {
  if (!isWeb) return { onPress: () => Linking.openURL(url) };
  return { href: url, hrefAttrs: { target: "_blank", rel: "noopener noreferrer" } };
}

export const darkMarkdownStyles: StyleMap = {
  root: { marginVertical: -2 },
  text: { color: "#e0e0e0", fontSize: 15, lineHeight: 21 },
  paragraph: { marginVertical: 8, width: "100%" },
  strong: { color: "#f0f0f0", fontWeight: "600" },
  emphasis: { fontStyle: "italic" },
  link: { color: "#6cb6ff", textDecorationLine: "underline" },
  heading1: { color: "#f0f0f0", fontSize: 26, lineHeight: 32, fontWeight: "700", marginTop: 16, marginBottom: 8 },
  heading2: { color: "#f0f0f0", fontSize: 22, lineHeight: 28, fontWeight: "700", marginTop: 14, marginBottom: 6 },
  heading3: { color: "#f0f0f0", fontSize: 19, lineHeight: 25, fontWeight: "700", marginTop: 12, marginBottom: 4 },
  heading4: { color: "#e8e8e8", fontSize: 17, lineHeight: 23, fontWeight: "600", marginTop: 10, marginBottom: 4 },
  heading5: { color: "#e8e8e8", fontSize: 16, lineHeight: 22, fontWeight: "600", marginTop: 8, marginBottom: 2 },
  heading6: { color: "#ccc", fontSize: 15, lineHeight: 21, fontWeight: "600", marginTop: 6, marginBottom: 2 },
  inlineCode: { color: "#f8c555", backgroundColor: "#1a1a1a", fontFamily: monoFont, fontSize: 13 },
  code: { backgroundColor: "#0d1117", color: "#e0e0e0", fontFamily: monoFont, fontSize: 13, padding: 10 },
  blockquote: { borderColor: "#555", borderLeftWidth: 3, paddingHorizontal: 10, marginVertical: 2, backgroundColor: "transparent" },
  thematicBreak: { backgroundColor: "#444", marginVertical: 6, height: 1 },
  list: {},
  listItem: { flexDirection: "row", alignItems: "flex-start", justifyContent: "flex-start", gap: 6 },
  listBullet: { color: "#e0e0e0", fontSize: 15, lineHeight: 21 },
  listItemContent: { flex: 1 },
  // A task item's checkbox, drawn rather than borrowed: RN has no checkbox
  // primitive, and the glyphs that look like one (☐ / ☑) are emoji-presentation
  // on iOS and a different width on every platform. 13px against a 21px line
  // box, so `marginTop` centers it on the first line of the item's text. The
  // export builds the same box out of a real `<input>` — see src/export.ts.
  listCheckbox: {
    width: 13, height: 13, marginTop: 4, borderRadius: 3,
    borderWidth: 1, borderColor: "#8a8a8e",
    alignItems: "center", justifyContent: "center",
  },
  listCheckboxChecked: { backgroundColor: "#6cb6ff", borderColor: "#6cb6ff" },
  listCheckmark: { color: "#111", fontSize: 10, lineHeight: 11, fontWeight: "700" },
  table: { borderWidth: 1, borderColor: "#555", borderRadius: 4, marginVertical: 4, overflow: "hidden" },
  tableRow: { flexDirection: "row", borderBottomWidth: 1, borderColor: "#555" },
  tableRowHeader: { backgroundColor: "rgba(255,255,255,0.08)" },
  tableCell: { flex: 1, paddingHorizontal: 8, paddingVertical: 4, borderRightWidth: 1, borderColor: "#555" },
  tableCellText: { color: "#e0e0e0", fontSize: 13 },
  tableCellHeaderText: { color: "#f0f0f0", fontSize: 13, fontWeight: "600" },
};

export const foreignMarkdownStyles: StyleMap = {
  ...darkMarkdownStyles,
  text: { color: "#d0d0d0", fontSize: 15, lineHeight: 21 },
};

/** Daemon-written lifecycle events. Identical to the default styles but dimmer
 *  — same type size, same paragraph margins, so a system bubble's interior
 *  spacing matches every other bubble's. The dashed outline is what marks these
 *  as system; nothing about the text needs to shrink or tighten. Links keep
 *  their normal color: a twin's `/twin from <nid>:<seq>` back-pointer is the
 *  whole point of the line. */
export const systemMarkdownStyles: StyleMap = {
  ...darkMarkdownStyles,
  text: { color: "#8a8a8e", fontSize: 15, lineHeight: 21 },
};

/** The line under the 膜 (MembraneEmpty): small, dim and centered, one
 *  paragraph with no margin of its own. Links and code keep their color, so a
 *  tip that points somewhere still looks like it does. */
export const captionMarkdownStyles: StyleMap = {
  ...darkMarkdownStyles,
  root: {},
  text: { color: "#666", fontSize: 13, lineHeight: 18 },
  paragraph: { marginVertical: 0, width: "100%", textAlign: "center" },
  strong: { color: "#888", fontWeight: "600" },
  inlineCode: { ...darkMarkdownStyles.inlineCode, fontSize: 12 },
};

// GFM autolink literals: bare `https://…`, `www.…` and `me@example.com` become
// real link nodes at parse time, with GFM's trailing-punctuation and
// paren-balancing rules. Being parse-level is the point — a URL inside a code
// span, a fenced block or an existing [label](url) is never touched.
const gfmSyntaxExtensions = [gfmTable(), gfmAutolinkLiteral(), gfmTaskListItem(), math()];
const gfmMdastExtensions = [
  gfmTableFromMarkdown(),
  gfmAutolinkLiteralFromMarkdown(),
  gfmTaskListItemFromMarkdown(),
  mathFromMarkdown(),
];

/** The type context KaTeX renders against.
 *
 *  react-native-web puts `fontSize` and `color` on each `Text` element rather
 *  than on a common ancestor, and these math nodes are raw DOM siblings of
 *  those elements — so left alone they inherit the *document* defaults, not the
 *  bubble's. That means 14px where the prose beside them is 15px (KaTeX then
 *  scales its `1.21em` off the wrong base), and near-black text on a near-black
 *  bubble. The export has neither problem, since its `.content` rule covers the
 *  math and the prose alike — so without this the two disagree despite running
 *  the identical renderer.
 *
 *  `lineHeight` comes along for consistency rather than to fix anything
 *  visible: the export's math inherits the `.content` leading, so declaring it
 *  here keeps the two describing the same box. It does *not* even out the line
 *  rhythm — a paragraph with inline math runs 21–23px against 18–21px for one
 *  without, in the export and the app alike, because KaTeX's inline-block
 *  height sets the line box whatever the leading says. That growth is inherent
 *  to inline math on the web, not a defect to chase. Display math keeps
 *  KaTeX's own leading — it is a block, not a line.
 *
 *  Reading all three off the active style map is what keeps the agent, foreign
 *  and system variants each in step with their own bubble. */
function mathTextStyle(styles: any): { fontSize: number; color: string; lineHeight: string } {
  const size = styles?.text?.fontSize;
  const color = styles?.text?.color;
  const leading = styles?.text?.lineHeight;
  return {
    fontSize: typeof size === "number" ? size : 15,
    color: typeof color === "string" ? color : "#e0e0e0",
    // `px`, not a unitless ratio: KaTeX sets its own line-height inside
    // `.katex`, so this governs only the line box the math occupies in the
    // paragraph — which is what has to match the prose around it.
    lineHeight: `${typeof leading === "number" ? leading : 21}px`,
  };
}

// Math renders through the same `renderMathHtml` the HTML export calls, so the
// two can't drift — a narrative looks the same downloaded as it does live. KaTeX
// emits a span tree that only CSS can lay out, so this is one of the places the
// app drops to real DOM rather than RN primitives (as `code` and `image` below
// already do). The markup is KaTeX's own, built with `trust: false`.
const mathRenderRules = {
  inlineMath: ({ node, styles }: any) => (
    <span
      key={node.key}
      className="math math-inline"
      style={mathTextStyle(styles)}
      dangerouslySetInnerHTML={{ __html: renderMathHtml(String(node.value ?? ""), false) }}
    />
  ),
};

/** The app's copy of the display-math rules — which is to say, not a copy.
 *
 *  `MATH_BLOCK_CSS` is the same string `src/export.ts` writes into its
 *  stylesheet: what makes a wide equation scroll instead of being silently
 *  clipped, and the no-script hint that says it can. It lands in a `<style>`
 *  here rather than in `public/index.html` precisely so it can't drift from
 *  the export — the `<link>` to KaTeX's own stylesheet stays there, since that
 *  one is a vendored file rather than something both sides derive.
 *
 *  Once per document; there is nothing per-bubble in it — the fade is a mask
 *  on the equation, so it needs no notion of what color the bubble is. */
let mathStyleInjected = false;
function ensureMathBlockStyle(): void {
  if (mathStyleInjected || Platform.OS !== "web" || typeof document === "undefined") return;
  mathStyleInjected = true;
  const el = document.createElement("style");
  el.id = "brane-math-block";
  el.textContent = MATH_BLOCK_CSS;
  document.head.appendChild(el);
}

const tableRenderRules = {
  table: ({ node, styles, children }: any) => (
    <View key={node.key} style={styles.table}>{children}</View>
  ),
  tableRow: ({ node, styles, children }: any) => (
    <View key={node.key} style={styles.tableRow}>{children}</View>
  ),
  tableCell: ({ node, styles, children, parentStack }: any) => {
    const isHeader = parentStack.length >= 2 &&
      parentStack[1].type === "table" &&
      parentStack[1].children?.[0] === parentStack[0];
    return (
      <View key={node.key} style={styles.tableCell}>
        <Text style={isHeader ? styles.tableCellHeaderText : styles.tableCellText}>
          {children}
        </Text>
      </View>
    );
  },
};

export interface MarkdownContentProps {
  content: string;
  foreign?: boolean;
  /** Daemon-written lifecycle event — renders recessive (see systemMarkdownStyles). */
  system?: boolean;
  /** The line under the 膜 (see captionMarkdownStyles). */
  caption?: boolean;
  /** Link handling — `knownNarrativeIds`, `knownProtocols`, `onNarrativePress`,
   *  `onProtocolPress` — normally comes from the enclosing `MarkdownLinksProvider`;
   *  passing any of them here overrides it for this one renderer. */
  onNarrativePress?: (nid: string, seq?: number) => void;
  /** Opens a protocol document — what a `/command` in prose links to. */
  onProtocolPress?: (name: string) => void;
  onFilePress?: (relativePath: string) => void;
  /** Resolves a fold-relative path to an in-app URL, so file links can be real
   *  anchors. Unlike narrative links, this depends on the surrounding route
   *  (which narrative, which tabs are pinned), so the screen supplies it.
   *  Without it file links still work — they just aren't ⌘-clickable. */
  fileHref?: (relativePath: string) => string | undefined;
  imageSrcResolver?: (src: string) => string | null;
  knownNarrativeIds?: Set<string>;
  /** Protocol names that exist on this daemon; only these get linkified. */
  knownProtocols?: Set<string>;
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
  foreign = false,
  system = false,
  caption = false,
  onNarrativePress: ownNarrativePress,
  onProtocolPress: ownProtocolPress,
  onFilePress,
  fileHref,
  imageSrcResolver,
  knownNarrativeIds: ownNarrativeIds,
  knownProtocols: ownProtocols,
}: MarkdownContentProps) {
  const links = useMarkdownLinks();
  const onNarrativePress = ownNarrativePress ?? links.onNarrativePress;
  const onProtocolPress = ownProtocolPress ?? links.onProtocolPress;
  const knownNarrativeIds = ownNarrativeIds ?? links.knownNarrativeIds;
  const knownProtocols = ownProtocols ?? links.knownProtocols;
  ensureMathBlockStyle();
  // A sideways pan across a wide equation scrolls the equation. Without this it
  // would *also* reach the chat pane's tab-swipe handler and flip to Terminal
  // mid-gesture — the same collision code blocks already guard against, and the
  // reason display math couldn't be scrolled by touch at all.
  const mathPanGuard = useHorizontalPanGuard();
  const mdastExtensions = useMemo(() => {
    const exts = [...gfmMdastExtensions];
    // Mentions before citations, and the order is load-bearing: each
    // extension's links are opaque to the next, so if `narrativeIdLinks` ran
    // first it would consume the id and strand the `@`. `nidSpec` carries a
    // matching `before !== "@"` veto, which means the two must ship together —
    // without this line an `@`-prefixed id renders as plain text.
    if (knownNarrativeIds) exts.push(mentionLinks(knownNarrativeIds));
    if (knownNarrativeIds) exts.push(narrativeIdLinks(knownNarrativeIds));
    if (knownProtocols) exts.push(protocolLinks(knownProtocols));
    return exts;
  }, [knownNarrativeIds, knownProtocols]);

  // Escapes the dollars that aren't math and promotes one-line `$$…$$` to a
  // display block — the identical call `src/export.ts` makes before micromark.
  const prepared = useMemo(() => prepareMathMarkdown(content), [content]);

  const rules = useMemo(() => {
    const base: any = { ...tableRenderRules, ...mathRenderRules };
    base.math = ({ node, styles }: any) => (
      <div
        key={node.key}
        className="math math-display"
        style={{ ...mathTextStyle(styles), lineHeight: "normal" }}
        {...mathPanGuard}
        dangerouslySetInnerHTML={{ __html: renderMathHtml(String(node.value ?? ""), true) }}
      />
    );
    base.code = ({ node, styles }: any) => {
      const lang: string | null = typeof node.lang === "string" ? node.lang : null;
      const value: string = typeof node.value === "string" ? node.value : "";
      if (Platform.OS === "web") {
        // One branch, three surfaces. Chat bubbles, the Files tab and the
        // wiki/protocol reader all render through this rule, so a `mermaid`
        // fence starts drawing in all of them at once. `DiagramView` falls
        // back to `HighlightedCode` itself when the daemon declines to draw.
        return (
          <div key={node.key} style={{ margin: "4px 0" }}>
            {lang === "mermaid"
              ? <DiagramView source={value} />
              : <HighlightedCode content={value} lang={lang} />}
          </div>
        );
      }
      return (
        <ScrollView
          key={node.key}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles._VIEW_SAFE_code}
          contentContainerStyle={{ minWidth: "100%" }}
        >
          <Text style={styles.code}>{value}</Text>
        </ScrollView>
      );
    };
    // GFM task list items: `- [x]` / `- [ ]`. `checked` is `null` for an
    // ordinary bullet, so the box *replaces* the marker only for real task
    // items, which is how GitHub renders them. The rest of the row is the
    // library's own listItem rule restated — there is no way to call it and
    // substitute one child.
    base.listItem = ({ node, styles, children, extras, parentStack }: any) => {
      const checked: boolean | null | undefined = node.checked;
      // A loose list's top margin rides on the row, not on the first paragraph
      // inside it — see `listItemRowMarginTop`. `parentStack[0]` is the
      // enclosing list, since ASTRenderer pushes ancestors innermost-first.
      const marginTop = listItemRowMarginTop(
        listIsLoose(parentStack?.[0]),
        styles.paragraph?.marginVertical ?? 0,
      );
      return (
        <View key={node.key} style={marginTop ? [styles.listItem, { marginTop }] : styles.listItem}>
          {checked == null ? (
            // Truthiness, not `??`: for an ordered list the library sets
            // `customListStyleType` to `false` rather than leaving it undefined.
            extras?.customListStyleType ? (
              extras.customListStyleType
            ) : (
              <Text style={styles.listBullet}>{extras?.listStyleType}</Text>
            )
          ) : (
            <View style={[styles.listCheckbox, checked && styles.listCheckboxChecked]}>
              {checked ? <Text style={styles.listCheckmark}>✓</Text> : null}
            </View>
          )}
          <View style={styles.listItemContent}>{children}</View>
        </View>
      );
    };
    base.paragraph = ({ node, styles, parentStack, children }: any) => {
      // Only a *tight* list runs its items together. Flattening every paragraph
      // that had a listItem anywhere above it — which is what this did — also
      // collapsed loose lists, which micromark gives real paragraph margins in
      // the export. `listIsLoose` is the shared predicate that keeps the two
      // agreeing; `parentStack[i + 1]` is the enclosing list, since ASTRenderer
      // pushes ancestors innermost-first.
      const i = parentStack?.findIndex((p: any) => p.type === "listItem") ?? -1;
      const override = listParagraphOverride({
        inListItem: i >= 0,
        // Only the item's first block sits beside the marker, so only that one
        // has to give up its top margin — later paragraphs in the same item
        // keep theirs. Same shape as the `tableCell` header test above.
        firstBlock: i >= 0 && parentStack[i].children?.[0] === node,
        loose: i >= 0 && listIsLoose(parentStack[i + 1]),
      });
      return (
        <Text key={node.key} style={override ? [styles.paragraph, override] : styles.paragraph}>
          {children}
        </Text>
      );
    };
    base.text = ({ node, styles, parentStack }: any) => {
      const value: string = typeof node.value === "string" ? node.value.replace(/\n/g, " ") : node.value;
      const heading = parentStack?.find((p: any) => p.type === "heading");
      // Link labels deliberately keep body color: the blue underline from the
      // enclosing link's style is the affordance, and coloring the text too
      // makes references shout over the prose they sit in.
      const style = heading ? styles[`heading${heading.depth}`] : styles.text;
      return (
        <Text key={node.key} style={style} maxFontSizeMultiplier={1.2}>
          {value}
        </Text>
      );
    };
    base.link = ({ node, styles, children }: any) => {
      const url: string = node.url || "";
      // Narrative references arrive two ways: `brane://nid/<nid>[/<seq>]` from
      // the linkifier, and a bare `nid` / `nid:seq` href, which agents write by
      // hand as `[label](nid:seq)` and the linkifier leaves alone. Without the
      // second form `nid:seq` would trip SCHEME_RE (the colon reads as a
      // scheme) and a bare `nid` would fall through to the Files tab.
      const nidMatch = url.match(/^brane:\/\/nid\/([^/]+)(?:\/(\d+))?$/)
        ?? url.match(new RegExp(`^${NID_REF_PATTERN}$`));
      if (nidMatch && onNarrativePress) {
        const targetNid = nidMatch[1];
        const targetSeq = nidMatch[2] ? Number(nidMatch[2]) : undefined;
        // A mention keeps its `@` in the label, which is the whole visible
        // difference between addressing a narrative and citing one. Weighting
        // it is what stops the two reading identically in a wall of prose.
        const isMention = String(node.children?.[0]?.value ?? "").startsWith("@");
        return (
          <Text
            key={node.key}
            style={[
              styles.link,
              { fontFamily: monoFont, fontSize: 13 },
              isMention && { fontWeight: "600" as const },
            ]}
            {...inAppLinkProps(narrativeHref(targetNid, targetSeq), () =>
              onNarrativePress(targetNid, targetSeq))}
          >
            {children}
          </Text>
        );
      }
      // `/ramify` and friends, from the protocol linkifier. Rendered like a
      // narrative reference — same mono treatment, same "this opens something
      // inside brane" reading.
      const protocolMatch = url.match(/^brane:\/\/protocol\/(.+)$/);
      if (protocolMatch && onProtocolPress) {
        const name = decodeURIComponent(protocolMatch[1]);
        return (
          <Text
            key={node.key}
            style={[styles.link, { fontFamily: monoFont, fontSize: 13 }]}
            onPress={() => onProtocolPress(name)}
          >
            {children}
          </Text>
        );
      }
      // The fold ending a lifecycle line (`linkFold` in shared/narrative-format).
      // Painted the identity row's green rather than link blue: it says where
      // the narrative lives, the same way the header does, and opens nothing.
      if (url.startsWith(FOLD_LINK_SCHEME)) {
        return (
          <Text key={node.key} style={[styles.text, { color: FOLD_COLOR, fontFamily: monoFont, fontSize: 13 }]}>
            {children}
          </Text>
        );
      }
      // Any URL scheme (http, https, mailto, brane://, javascript, etc.)
      if (SCHEME_RE.test(url)) {
        if (url.startsWith("brane://")) {
          // Unrecognized brane:// URL — render plain (no handler to match)
          return <Text key={node.key} style={styles.link}>{children}</Text>;
        }
        return (
          <Text key={node.key} style={styles.link} {...externalLinkProps(url)}>
            {children}
          </Text>
        );
      }
      // No scheme: treat as fold-relative path. Absolute paths skip (no handler).
      if (!url || url.startsWith("/")) {
        return <Text key={node.key} style={styles.link}>{children}</Text>;
      }
      if (onFilePress) {
        return (
          <Text
            key={node.key}
            style={styles.link}
            {...inAppLinkProps(fileHref?.(url), () => onFilePress(url))}
          >
            {children}
          </Text>
        );
      }
      return <Text key={node.key} style={styles.link}>{children}</Text>;
    };
    if (imageSrcResolver) {
      base.image = ({ node, styles }: any) => {
        const src: string = node.url || "";
        const resolved = imageSrcResolver(src);
        if (!resolved) {
          return <Text key={node.key} style={styles.text}>{node.alt || src}</Text>;
        }
        // Using a plain <img> on web; React Native Web renders <Image> as well,
        // but a direct <img> makes inline sizing simpler for markdown images.
        return (
          <img
            key={node.key}
            src={resolved}
            alt={node.alt || ""}
            style={{ maxWidth: "100%", borderRadius: 4, display: "block", margin: "4px 0" }}
          />
        );
      };
    }
    return base;
  }, [onNarrativePress, onProtocolPress, onFilePress, fileHref, imageSrcResolver, mathPanGuard]);

  return (
    <MarkdownRenderer
      markdown={prepared}
      styles={caption ? captionMarkdownStyles : system ? systemMarkdownStyles : foreign ? foreignMarkdownStyles : darkMarkdownStyles}
      mergeStyle={false}
      syntaxExtensions={gfmSyntaxExtensions}
      extensions={mdastExtensions}
      renderRules={rules}
    />
  );
});
