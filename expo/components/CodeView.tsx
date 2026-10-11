import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Text } from "react-native";
import {
  fetchHighlight,
  type FileHighlight,
  type HighlightToken,
} from "@/lib/api";
import { useBrane } from "@/app/_layout";
import { useHorizontalPanGuard } from "@/lib/panGuard";

const monoFont = Platform.select({ ios: "Menlo", default: "monospace" });

function fontStyle(s?: number) {
  if (!s) return undefined;
  return {
    fontStyle: s & 1 ? "italic" : undefined,
    fontWeight: s & 2 ? "bold" : undefined,
    textDecoration: s & 4 ? "underline" : undefined,
  } as const;
}

export interface CodeViewProps {
  content: string;
  highlight?: FileHighlight | null;
  line?: number;
  lineEnd?: number;
  showLineNumbers?: boolean;
}

export function CodeView({
  content,
  highlight,
  line,
  lineEnd,
  showLineNumbers = true,
}: CodeViewProps) {
  const lines = useMemo<HighlightToken[][]>(() => {
    if (highlight?.tokens) return highlight.tokens;
    return content.split("\n").map((l): HighlightToken[] => [{ c: l }]);
  }, [content, highlight]);
  const bg = highlight?.bg ?? "#0d1117";
  const fg = highlight?.fg ?? "#e0e0e0";
  const hlStart = line ?? 0;
  const hlEnd = lineEnd ?? line ?? 0;
  // Horizontal pans inside the code block shouldn't trigger the chat pane's
  // tab-swipe gesture, but vertical pans must still bubble up so the chat
  // ScrollView keeps scrolling when a touch starts on a code block.
  const panGuard = useHorizontalPanGuard();

  if (Platform.OS !== "web") {
    return (
      <Text style={{ color: fg, fontSize: 13, fontFamily: monoFont }}>
        {content}
      </Text>
    );
  }

  return (
    <div
      style={{
        fontFamily: monoFont,
        fontSize: 13,
        lineHeight: "19px",
        color: fg,
        backgroundColor: bg,
        borderRadius: 4,
        padding: "8px 0",
        overflowX: "auto",
      }}
      {...panGuard}
    >
      {lines.map((tokens, idx) => {
        const n = idx + 1;
        const empty = tokens.length === 0 || (tokens.length === 1 && tokens[0].c === "");
        const highlighted = hlStart > 0 && n >= hlStart && n <= hlEnd;
        return (
          <div key={n} id={showLineNumbers ? `L${n}` : undefined} style={{
            display: "flex",
            whiteSpace: "pre",
            // Width-to-content: lets the flex row expand beyond the parent's
            // width so overflow-x: auto actually scrolls instead of clipping.
            minWidth: "max-content",
            backgroundColor: highlighted ? "rgba(255, 215, 0, 0.12)" : undefined,
          }}>
            {showLineNumbers && (
              // data-find-skip: the Files tab's 🔎 searches the file, not its
              // gutter — `12` must not match every line numbered 12.
              <span data-find-skip="" style={{
                display: "inline-block",
                minWidth: 48,
                paddingRight: 12,
                textAlign: "right",
                color: "#555",
                userSelect: "none",
              }}>{n}</span>
            )}
            <span style={{ flex: 1, paddingRight: showLineNumbers ? 12 : 10, paddingLeft: showLineNumbers ? 0 : 10 }}>
              {empty ? "​" : tokens.map((tok, ti) => (
                <span key={ti} style={{ color: tok.f ?? fg, ...fontStyle(tok.s) }}>{tok.c}</span>
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export interface HighlightedCodeProps {
  content: string;
  lang?: string | null;
  showLineNumbers?: boolean;
}

export function HighlightedCode({ content, lang, showLineNumbers = false }: HighlightedCodeProps) {
  const { conn } = useBrane();
  const [highlight, setHighlight] = useState<FileHighlight | null>(null);
  const reqGen = useRef(0);

  useEffect(() => {
    if (!conn || !lang) {
      setHighlight(null);
      return;
    }
    const gen = ++reqGen.current;
    fetchHighlight(conn, content, lang)
      .then((h) => {
        if (reqGen.current === gen) setHighlight(h);
      })
      .catch(() => {
        if (reqGen.current === gen) setHighlight(null);
      });
  }, [conn, content, lang]);

  return (
    <CodeView content={content} highlight={highlight} showLineNumbers={showLineNumbers} />
  );
}
