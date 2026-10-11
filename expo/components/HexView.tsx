import { memo, useCallback, useMemo, useSyncExternalStore } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { HEX_ROW_BYTES, hexOffset, hexRowColumns, hexRows } from "@shared/hex-dump";
import { pagesOfHit } from "@shared/hex-pages";
import type { HexDoc, HexSearch } from "@/lib/hexDoc";

const monoFont = Platform.select({ ios: "Menlo", default: "monospace" });

/** The floor under every other renderer: a file brane can't show as text,
 *  image or PDF is shown as its bytes, `xxd`-style, a page at a time.
 *
 *  Pages sit where they belong in the file, not in the order they were
 *  loaded: a gap row stands for each run not loaded yet, with a button to
 *  load the 16 KB on either side of it. That's what lets 🔎 land on a hit a
 *  gigabyte in without reading the gigabyte before it. The pages and the
 *  search live in a `HexDoc` so the search bar's `useHexFind` can load the
 *  page a hit is on. */
export const HexView = memo(function HexView({ doc }: { doc: HexDoc }) {
  useSyncExternalStore(doc.subscribe, doc.getVersion);
  const segments = doc.segments();
  const rowBytes = doc.rowBytes;
  // Sixteen bytes a row where they fit, eight on a phone: a 76-column row
  // would leave the ASCII gutter, the half most people read, off-screen.
  const onLayout = useCallback((e: { nativeEvent: { layout: { width: number } } }) => {
    const fits = e.nativeEvent.layout.width >= hexRowColumns(HEX_ROW_BYTES) * CHAR_WIDTH;
    doc.setRowBytes(fits ? HEX_ROW_BYTES : HEX_ROW_BYTES / 2);
  }, [doc]);
  const setRoot = useCallback((el: HTMLDivElement | null) => doc.setRoot(el), [doc]);

  const loaded = doc.loadedBytes();
  const whole = segments.length === 1;
  const header = doc.size === null
    ? `${loaded.toLocaleString()} bytes shown · size unknown until read`
    : whole
      ? `${doc.size.toLocaleString()} bytes`
      : `${loaded.toLocaleString()} of ${doc.size.toLocaleString()} bytes shown`;

  const rows = segments.map((seg) =>
    seg.kind === "page" ? (
      <HexPageRows key={`p${seg.offset}`} offset={seg.offset} bytes={doc.pages.get(seg.offset)!.bytes} rowBytes={rowBytes} />
    ) : (
      <GapRow key={`g${seg.from}`} doc={doc} from={seg.from} to={seg.to} />
    ),
  );

  return (
    <View onLayout={onLayout}>
      <Text style={styles.header}>{header}</Text>
      {doc.search && <SearchStatus doc={doc} search={doc.search} />}
      {Platform.OS === "web" ? (
        // Should even eight not fit, the rows scroll sideways rather than
        // wrap, which would break the columns apart.
        <div ref={setRoot} style={{ overflowX: "auto", overflowY: "hidden" }}>
          {rows}
        </div>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View>{rows}</View>
        </ScrollView>
      )}
      {doc.notice && <Text style={styles.notice}>{doc.notice}</Text>}
    </View>
  );
});

/** Where the search stands, when there's more to say than the drum does:
 *  that it is still reading, or that it stopped short and can go on. Sticky,
 *  since the reader who wants the next window is at the last hit, a long way
 *  below the header. */
function SearchStatus({ doc, search }: { doc: HexDoc; search: HexSearch }) {
  const count = search.starts.length;
  const matches = `${count.toLocaleString()} match${count === 1 ? "" : "es"}`;
  const from = search.from > 0 ? ` from 0x${hexOffset(search.from)}` : "";
  let text: string | null = null;
  if (search.error) text = search.error;
  else if (search.running) {
    text = `Searching${from}… ${formatBytes(search.scanned)}${doc.size !== null ? ` of ${formatBytes(doc.size)}` : ""}`;
  } else if (search.stop === "pages") text = `${matches} in the first ${pagesWithHits(search, doc.pageBytes)} pages that have any${from}`;
  else if (search.stop === "hits") text = `The first ${matches}${from}`;
  else if (search.stop === "time") text = `${matches}${from}; stopped after 30 s at 0x${hexOffset(search.next ?? search.scanned)}`;
  else if (search.stop === "cancelled") text = `${matches}${from} before the search was interrupted`;
  else if (search.stop === "reach") text = `${matches}${from}; stopped ${formatBytes(search.scanned)} into the compressed stream, as far as brane decompresses`;
  else if (search.from > 0) text = `${matches}${from} to the end`;
  if (text === null) return null;
  const more = !search.running && search.next !== null;
  const body = (
    <View style={styles.status}>
      <Text style={styles.statusText}>{text}</Text>
      {more && (
        <Pressable onPress={() => doc.searchOn()} hitSlop={8}>
          <Text style={styles.statusLink}>{search.stop === "cancelled" ? "Resume" : "Search on"} from 0x{hexOffset(search.next!)}</Text>
        </Pressable>
      )}
    </View>
  );
  if (Platform.OS !== "web") return body;
  return <div style={{ position: "sticky", top: 0, zIndex: 1, backgroundColor: "#111" }}>{body}</div>;
}

/** Pages the window's hits are on, counted rather than assumed: a resumed
 *  search can hold a few more than one window's 64. */
function pagesWithHits(search: HexSearch, pageBytes: number): number {
  const pages = new Set<number>();
  search.starts.forEach((at, i) => {
    for (const p of pagesOfHit(at, search.lengths[i], pageBytes)) pages.add(p);
  });
  return pages.size;
}

/** An unloaded run, and the two ways into it. */
function GapRow({ doc, from, to }: { doc: HexDoc; from: number; to: number | null }) {
  const page = doc.pageBytes;
  const kb = Math.round(page / 1024);
  // The page just past the one above, and the page just before the one below.
  const down = from;
  const up = to !== null ? Math.max(from, to - page) : null;
  const busy = doc.isLoading(down) || (up !== null && doc.isLoading(up));
  const label = to === null ? "⋯ more bytes not loaded" : `⋯ ${(to - from).toLocaleString()} bytes not loaded`;
  const body = (
    <View style={styles.gap}>
      <Text style={styles.gapText}>{label}</Text>
      {busy ? (
        <ActivityIndicator color="#888" />
      ) : (
        <View style={styles.gapButtons}>
          <Pressable onPress={() => void doc.ensure(down)} hitSlop={8}>
            <Text style={styles.gapLink}>↓ {kb} KB</Text>
          </Pressable>
          {up !== null && up !== down && (
            <Pressable onPress={() => void doc.ensure(up)} hitSlop={8}>
              <Text style={styles.gapLink}>↑ {kb} KB</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
  if (Platform.OS !== "web") return body;
  // The search bar finds a gap by the bytes it stands for, to point at a hit
  // whose page isn't loaded.
  return <div data-hex-gap-from={from} data-hex-gap-to={to ?? undefined}>{body}</div>;
}

const HexPageRows = memo(function HexPageRows({ offset, bytes, rowBytes }: { offset: number; bytes: Uint8Array; rowBytes: number }) {
  const rows = useMemo(() => hexRows(bytes, offset, rowBytes), [bytes, offset, rowBytes]);
  if (Platform.OS === "web") {
    // Plain elements, one per row, three spans per row: `useHexFind` paints
    // a hit by finding row k of page `offset` and the character each byte
    // sits at in each column. Nothing but whitespace between the spans.
    return (
      <div data-hex-page={offset}>
        {rows.map((row, i) => (
          <div key={i} style={webRow}>
            <span style={{ color: "#666" }}>{row.offset}</span>
            {"  "}
            <span style={{ color: "#c8d3f5" }}>{row.hex}</span>
            {" "}
            <span style={{ color: "#9ece6a" }}>{row.ascii}</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <View>
      {rows.map((row, i) => (
        <Text key={i} style={styles.row} selectable>
          <Text style={styles.offset}>{row.offset}</Text>
          {"  "}
          <Text style={styles.hex}>{row.hex}</Text>
          {" "}
          <Text style={styles.ascii}>{row.ascii}</Text>
        </Text>
      ))}
    </View>
  );
});

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** A 12px monospace cell, a little generous so a row never just misses. */
const CHAR_WIDTH = 7.4;

const webRow = {
  fontFamily: "ui-monospace, Menlo, monospace",
  fontSize: 12,
  lineHeight: "17px",
  color: "#e0e0e0",
  whiteSpace: "pre" as const,
  width: "max-content",
};

const styles = StyleSheet.create({
  header: { color: "#888", fontSize: 12, fontFamily: monoFont, paddingBottom: 8 },
  row: { fontFamily: monoFont, fontSize: 12, lineHeight: 17, color: "#e0e0e0" },
  offset: { color: "#666" },
  hex: { color: "#c8d3f5" },
  ascii: { color: "#9ece6a" },
  notice: { color: "#888", fontSize: 13, paddingVertical: 12 },
  status: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 12, rowGap: 4, paddingVertical: 6 },
  statusText: { color: "#d8a657", fontSize: 12, fontFamily: monoFont },
  statusLink: { color: "#6cb6ff", fontSize: 12, fontFamily: monoFont },
  gap: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 16, rowGap: 4, paddingVertical: 10 },
  gapText: { color: "#777", fontSize: 12, fontFamily: monoFont },
  gapButtons: { flexDirection: "row", gap: 16 },
  gapLink: { color: "#6cb6ff", fontSize: 12, fontFamily: monoFont },
});
