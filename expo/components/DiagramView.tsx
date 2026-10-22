import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { fetchDiagram, type DiagramResult } from "@/lib/api";
import { useBrane } from "@/app/_layout";
import { HighlightedCode } from "@/components/CodeView";
import { useMarkdownLinks } from "@/components/MarkdownLinks";
import { useHorizontalPanGuard } from "@/lib/panGuard";
import { DIAGRAM_EDGE_HIGHLIGHT_CSS } from "@shared/diagram-css";

/** The rule that reveals an edge's highlight layer on hover or tap: the same
 *  string the export writes into its stylesheet. Once per document. */
let edgeStyleInjected = false;
function ensureEdgeHighlightStyle(): void {
  if (edgeStyleInjected || typeof document === "undefined") return;
  edgeStyleInjected = true;
  const el = document.createElement("style");
  el.id = "brane-diagram-edge-hl";
  el.textContent = DIAGRAM_EDGE_HIGHLIGHT_CSS;
  document.head.appendChild(el);
}

/** A ```mermaid fence, drawn.
 *
 *  A sibling of `HighlightedCode` in every respect that matters: it fetches
 *  from the daemon, guards against out-of-order responses with a generation
 *  counter, and falls back to the plain code view when the answer is empty.
 *  A diagram brane does not draw is therefore exactly the highlighted code
 *  block it has always been — there is no second failure path to maintain.
 *
 *  Native renders the code block unconditionally. There is no DOM there to
 *  put an SVG into, and the honest options (react-native-svg, a WebView) are
 *  their own change; the fence still reads as source, which is what it did
 *  before.
 */
export function DiagramView({ source }: { source: string }) {
  const { conn } = useBrane();
  const [result, setResult] = useState<DiagramResult | null | undefined>(undefined);
  const reqGen = useRef(0);
  const { onNarrativePress } = useMarkdownLinks();
  // A wide diagram scrolls sideways, and that pan must not also reach the chat
  // pane's tab-swipe handler — the collision code blocks and display math
  // already guard against. Called before the early returns: it is a hook.
  const panGuard = useHorizontalPanGuard();

  useEffect(() => {
    if (!conn || Platform.OS !== "web") {
      setResult(null);
      return;
    }
    const gen = ++reqGen.current;
    fetchDiagram(conn, source)
      .then((d) => { if (reqGen.current === gen) setResult(d); })
      .catch(() => { if (reqGen.current === gen) setResult(null); });
  }, [conn, source]);

  /** A node label that resolved to a narrative is an `<a>` inside the SVG.
   *  Catching it here rather than binding a listener per anchor keeps the
   *  markup inert — the SVG stays a string the daemon produced, with no
   *  scripting of any kind, which is also what lets the export reuse it. */
  const onClick = useCallback((e: any) => {
    const anchor = e?.target?.closest?.("a");
    const href: string | undefined = anchor?.getAttribute?.("href");
    if (!href) return;
    const m = /^brane:\/\/nid\/([^/]+)(?:\/(\d+))?$/.exec(href);
    if (!m || !onNarrativePress) return;
    e.preventDefault?.();
    onNarrativePress(m[1], m[2] ? Number(m[2]) : undefined);
  }, [onNarrativePress]);

  // `undefined` is "not answered yet". Rendering the code block during that
  // window and then swapping would make every diagram flash as source first.
  if (result === undefined) return null;
  if (!result) return <HighlightedCode content={source} lang="mermaid" />;
  ensureEdgeHighlightStyle();

  return (
    <div
      className="brane-diagram-host"
      // The click is delegated to the <a>s inside the SVG; the host is a group
      // around them, not a control.
      role="group"
      aria-label="Diagram"
      onClick={onClick}
      style={{ margin: "6px 0", overflowX: "auto", overflowY: "hidden", overscrollBehaviorX: "contain", maxWidth: "100%" }}
      {...panGuard}
      dangerouslySetInnerHTML={{ __html: result.svg }}
    />
  );
}
