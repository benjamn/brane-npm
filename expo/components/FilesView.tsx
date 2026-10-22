import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { ActivityIndicator, Dimensions, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import {
  fetchFileList,
  fetchFiles,
  filesRawUrl,
  type ConnectionParams,
  type FilesEntry,
  type FilesResponse,
} from "@/lib/api";
import { buildFuzzyIndex, fuzzyFilterIndex, type FuzzyMatch } from "@/lib/fuzzy";
import { downloadUrl, downloadNameFor } from "@/lib/download";
import { ejectTrack, useJukeboxEntry } from "@/lib/jukebox";
import NowPlayingDial, { UI_FONT } from "./NowPlayingDial";
import { formatClock } from "@shared/audio-dial";
import { sameTrack, trackTitle } from "@shared/now-playing";
import { MarkdownContent } from "@/components/Markdown";
import { CodeView } from "@/components/CodeView";
import { HexView } from "@/components/HexView";
import PdfView from "@/components/PdfView";
import { RECYCLE_STEP, RecycleGlyph, useDetentSpin } from "@/components/RecycleSpinner";
import { findInFileSupported, useFindInFile, type FindState } from "@/lib/findInFile";
import { HexDoc } from "@/lib/hexDoc";
import { useHexFind } from "@/lib/hexFind";
import { HitDrum, type HitDrumHandle } from "@/components/HitDrum";

export interface FilesViewHandle {
  scrollToTop: () => void;
  scrollToBottom: () => void;
}

const monoFont = Platform.select({ ios: "Menlo", default: "monospace" });

function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(p);
}

function isImagePath(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(p);
}

function isPdfPath(p: string): boolean {
  return /\.pdf$/i.test(p);
}

/** Keep in step with the audio entries of MIME_TYPES in src/daemon/server.ts. */
function isAudioPath(p: string): boolean {
  return /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|aiff?)$/i.test(p);
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

/** Audio plays in place, in the browser's own `<audio>`. The daemon serves it
 *  with `Range` support, which is what makes it seekable and what Safari needs
 *  before it plays anything. The element lives in this pane, and the pane
 *  stays mounted when its tab is hidden or another narrative is pushed on top
 *  (see docs/view-urls.md), so the music carries on under the rest of the app
 *  until this view opens another path. Media Session metadata puts the track
 *  name where the OS shows what's playing and wires the earbuds' buttons. */
/** An audio file's card: a dial that puts the file on the jukebox, the
 *  title, and the clock while it is the track in this narrative's slot. The
 *  dial is the control; the element lives in `@/lib/jukebox`, outside every
 *  screen, which is what lets the track keep playing wherever you go. */
function AudioCard({ conn, nid, path }: { conn: ConnectionParams; nid: string; path: string }) {
  const track = useMemo(() => ({ nid, path, url: filesRawUrl(conn, nid, path) }), [conn, nid, path]);
  const entry = useJukeboxEntry(nid);
  const live = entry && sameTrack(entry.track, track) ? entry : null;
  const held = entry && !live ? trackTitle(entry.track.path) : null;
  const line = live
    ? (live.status === "error" ? "Couldn't play this file." : `${formatClock(live.position)} / ${formatClock(live.duration)}`)
    : held
      ? `Tap ▶ to play; it takes ${held}'s place in this narrative's slot.`
      : "Tap ▶ to play. It keeps playing wherever you go in the app.";
  return (
    <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 14, padding: 12 }}>
      <NowPlayingDial nid={nid} track={track} size={56} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.audioTitle} numberOfLines={2}>{trackTitle(path)}</Text>
        <Text style={styles.audioLine}>{line}</Text>
      </div>
      {live && (
        // Stop lives here, not on the list card: the card shows only the dial.
        <button
          onClick={() => ejectTrack(nid)}
          title="Stop and take it off the jukebox"
          style={{ background: "none", border: "none", color: "#8a9590", fontFamily: UI_FONT, fontSize: 14, padding: "6px 8px", cursor: "pointer" }}
        >
          ✕ Stop
        </button>
      )}
    </div>
  );
}

// Collapse `.`, empty (`//`), and `..` segments into a clean relative path.
// Shared by joinRel and the breadcrumb's currentDir fallback so a path like
// `fold/./blah` never reaches the display, even before the server responds.
function normalizeRel(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function joinRel(base: string, rel: string): string {
  return normalizeRel(`${base}/${rel}`);
}

// Extracts path + line range from a relative link. Supports `foo.md#L10`,
// `foo.md#L10-L15`, `foo.md#L10-15`, and `foo.md?line=10-15`.
export function parseRelLink(rel: string): { path: string; line?: number; lineEnd?: number } {
  const [pathPart, hash] = rel.split("#");
  const [cleanPath, query] = pathPart.split("?");
  if (hash) {
    const m = hash.match(/^L(\d+)(?:-L?(\d+))?/);
    if (m) {
      const line = Number(m[1]);
      const end = m[2] ? Number(m[2]) : undefined;
      return { path: cleanPath, line, lineEnd: end !== undefined && end >= line ? end : undefined };
    }
  } else if (query) {
    const m = query.match(/(?:^|&)line=(\d+)(?:-(\d+))?/);
    if (m) {
      const line = Number(m[1]);
      const end = m[2] ? Number(m[2]) : undefined;
      return { path: cleanPath, line, lineEnd: end !== undefined && end >= line ? end : undefined };
    }
  }
  return { path: cleanPath };
}

interface FilesViewProps {
  conn: ConnectionParams;
  nid: string;
  path: string;
  line?: number;
  lineEnd?: number;
  active: boolean;
  onPathChange: (path: string, line?: number, lineEnd?: number) => void;
  onImagePress?: (uri: string) => void;
  onAtBottomChange?: (atBottom: boolean) => void;
}

const FilesView = forwardRef<FilesViewHandle, FilesViewProps>(function FilesView({
  conn,
  nid,
  path,
  line,
  lineEnd,
  active,
  onPathChange,
  onImagePress,
  onAtBottomChange,
}, ref) {
  const [data, setData] = useState<FilesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Manual refresh: bumping `reloadNonce` re-runs the fetch effect; `refreshing`
  // (set on press, cleared when that fetch settles) drives the ♻️ spin.
  const [refreshing, setRefreshing] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [spinAngle, setSpinAngle] = useDetentSpin(refreshing);
  const [fileList, setFileList] = useState<string[] | null>(null);
  const [fileListTruncated, setFileListTruncated] = useState(false);
  const [query, setQuery] = useState("");
  const fileBodyRef = useRef<View>(null);

  // While any file is open, suppress the browser's native pinch-zoom
  // document-wide. iOS/WebKit (incl. Chrome iOS) delivers pinch as the
  // gesture* events; preventing them stops a pinch from zooming/navigating the
  // whole page. The PDF viewer handles its own in-frame zoom; other file types
  // simply don't page-zoom while open.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!data || data.type !== "file") return;
    const prevent = (e: Event) => e.preventDefault();
    document.addEventListener("gesturestart", prevent, { passive: false });
    document.addEventListener("gesturechange", prevent, { passive: false });
    document.addEventListener("gestureend", prevent, { passive: false });
    return () => {
      document.removeEventListener("gesturestart", prevent);
      document.removeEventListener("gesturechange", prevent);
      document.removeEventListener("gestureend", prevent);
    };
  }, [data]);
  const scrollRef = useRef<ScrollView>(null);
  const pendingLineRef = useRef<number | undefined>(line);
  const atBottomRef = useRef(true);
  const layoutHRef = useRef(0);
  const contentHRef = useRef(0);
  const offsetYRef = useRef(0);

  useImperativeHandle(ref, () => ({
    scrollToTop: () => {
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    },
    scrollToBottom: () => {
      scrollRef.current?.scrollToEnd({ animated: true });
    },
  }), []);

  const recomputeAtBottom = useCallback(() => {
    const dist = contentHRef.current - offsetYRef.current - layoutHRef.current;
    const atBottom = dist < 50;
    if (atBottom !== atBottomRef.current) {
      atBottomRef.current = atBottom;
      onAtBottomChange?.(atBottom);
    }
  }, [onAtBottomChange]);

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    offsetYRef.current = e.nativeEvent.contentOffset.y;
    recomputeAtBottom();
  }, [recomputeAtBottom]);

  const handleLayout = useCallback((e: { nativeEvent: { layout: { height: number } } }) => {
    layoutHRef.current = e.nativeEvent.layout.height;
    recomputeAtBottom();
  }, [recomputeAtBottom]);

  const handleContentSizeChange = useCallback((_w: number, h: number) => {
    contentHRef.current = h;
    recomputeAtBottom();
  }, [recomputeAtBottom]);

  useEffect(() => {
    pendingLineRef.current = line;
  }, [line, path]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
    offsetYRef.current = 0;
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchFiles(conn, nid, path)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
        setRefreshing(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err.message ?? err));
        setLoading(false);
        setRefreshing(false);
        setData(null);
      });
    return () => { cancelled = true; };
  }, [conn, nid, path, reloadNonce]);

  // Load the flat file list for fuzzy search — once per (conn, nid), when the
  // pane becomes active for the first time.
  useEffect(() => {
    if (!active || fileList !== null) return;
    let cancelled = false;
    fetchFileList(conn, nid).then((res) => {
      if (cancelled) return;
      setFileList(res.files);
      setFileListTruncated(res.truncated);
    }).catch(() => {
      if (cancelled) return;
      setFileList([]);
    });
    return () => { cancelled = true; };
  }, [active, conn, nid, fileList]);

  // Built once per fileList; reused across keystrokes so lowercasing and
  // char-bitmap construction don't rerun per query.
  const fuzzyIndex = useMemo(
    () => (fileList ? buildFuzzyIndex(fileList) : null),
    [fileList],
  );

  // Cache the previous query's survivor set. When the new query extends the
  // old one (the common case while typing), we only rescore those survivors
  // instead of the whole list — subsequence monotonicity guarantees nothing
  // outside the prior survivors can match the longer query.
  const prevFilterRef = useRef<{ query: string; survivors: Int32Array } | null>(null);

  // Reset incremental cache when the underlying index changes.
  useEffect(() => {
    prevFilterRef.current = null;
  }, [fuzzyIndex]);

  // 🔎 is offered for a file brane renders as text — code or markdown — and
  // nowhere else: an image, a PDF (pdf.js paints canvas; its text layer would
  // need its own find), or a file too large to display has nothing to search.
  // The hex view is searched by the daemon, over every byte: text, or a run of
  // hex pairs as the bytes they spell.
  const canFind = !!data && data.type === "file" && !data.truncated && (!data.binary || !!data.hex)
    && !isImagePath(data.path) && !isPdfPath(data.path) && !isAudioPath(data.path) && findInFileSupported();
  // The view decides the mode; there is no switch. The query survives
  // navigation, so it re-runs in whatever mode the next view dictates —
  // "the same word in the next file" is one navigation.
  const mode: SearchMode = canFind ? "find" : "files";
  const viewKey = data ? `${data.type}:${data.path}` : null;

  // A hex file's pages and search, one per file shown. Its 🔎 is the
  // daemon's, over every byte; everything else's is the DOM's, over what is
  // rendered.
  const hexDoc = useMemo(
    () => (data?.type === "file" && data.hex ? new HexDoc(conn, nid, data.path, data.size, data.hex, data.notice) : null),
    [data, conn, nid],
  );
  useEffect(() => () => hexDoc?.dispose(), [hexDoc]);

  const textFind = useFindInFile({
    container: fileBodyRef as unknown as RefObject<HTMLElement | null>,
    query,
    enabled: mode === "find" && !hexDoc && !loading && !error,
    contentKey: viewKey,
  });
  const hexFind = useHexFind({
    doc: hexDoc,
    query,
    enabled: mode === "find" && !!hexDoc && !loading && !error,
  });
  const find = hexDoc ? hexFind : textFind;

  const matches = useMemo<FuzzyMatch[]>(() => {
    const q = query.trim();
    if (!q || !fuzzyIndex || mode !== "files") {
      prevFilterRef.current = null;
      return [];
    }
    const prev = prevFilterRef.current;
    const narrow =
      prev && q.toLowerCase().startsWith(prev.query.toLowerCase())
        ? prev.survivors
        : null;
    const result = fuzzyFilterIndex(fuzzyIndex, q, 200, narrow);
    prevFilterRef.current = { query: q, survivors: result.survivors };
    return result.matches;
  }, [query, fuzzyIndex, mode]);

  const handleMatchPress = useCallback((matchPath: string) => {
    setQuery("");
    onPathChange(matchPath);
  }, [onPathChange]);

  const handleSubmitFiles = useCallback(() => {
    if (matches.length > 0) handleMatchPress(matches[0].value);
  }, [matches, handleMatchPress]);

  // Leaving 🔎 on a hit writes its line into the URL, so Meld and Isolate
  // carry the reader to the same place (and CodeView tints it). Only on
  // close — per keystroke would churn router.setParams — and only for files
  // with numbered lines.
  const findLine = find.currentLine;
  // The line search itself wrote, so clearing the query can take it back.
  const searchLineRef = useRef<number | undefined>(undefined);
  const handleSearchClose = useCallback(() => {
    if (mode !== "find" || !query) return;
    const l = findLine();
    if (l !== undefined && l !== line) {
      searchLineRef.current = l;
      onPathChange(path, l);
    }
  }, [mode, query, findLine, line, path, onPathChange]);

  // Clearing the query ends the search, and with it everything the search
  // painted — the hits, and CodeView's tint on the line it parked on. A line
  // that came from anywhere else (a deep link, a click) is not ours to drop.
  useEffect(() => {
    if (query || searchLineRef.current === undefined) return;
    const l = searchLineRef.current;
    searchLineRef.current = undefined;
    if (line === l) onPathChange(path);
  }, [query, line, path, onPathChange]);

  // Scroll to ?line=N after render (web only; uses element ID anchor)
  useEffect(() => {
    if (!active || Platform.OS !== "web" || !data || data.type !== "file") return;
    const target = pendingLineRef.current;
    if (!target) return;
    const tryScroll = () => {
      const el = document.getElementById(`L${target}`);
      if (el) {
        el.scrollIntoView({ block: "center" });
        pendingLineRef.current = undefined;
        return true;
      }
      return false;
    };
    if (tryScroll()) return;
    const t1 = setTimeout(tryScroll, 50);
    const t2 = setTimeout(tryScroll, 300);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [active, data]);

  const currentDir = useMemo(() => {
    if (!data) return normalizeRel(path);
    return data.type === "directory" ? data.path : dirname(data.path);
  }, [data, path]);

  const handleEntryPress = useCallback((entry: FilesEntry) => {
    const newPath = joinRel(path, entry.name);
    onPathChange(newPath);
  }, [path, onPathChange]);

  const imageSrcResolver = useCallback((src: string): string | null => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return src;
    if (src.startsWith("/")) return null;
    const resolved = joinRel(currentDir, src);
    return filesRawUrl(conn, nid, resolved);
  }, [conn, nid, currentDir]);

  const handleFileLinkPress = useCallback((rel: string) => {
    const { path: cleanPath, line: targetLine, lineEnd: targetLineEnd } = parseRelLink(rel);
    onPathChange(joinRel(currentDir, cleanPath), targetLine, targetLineEnd);
  }, [currentDir, onPathChange]);

  // Inside an archive, the crumb that is the archive wears its 📦, so the
  // path reads as "these folders are in that file".
  const archiveRoot = data?.archive?.root ?? null;
  const breadcrumbs = useMemo(() => {
    const crumbs: Array<{ label: string; path: string }> = [{ label: "fold", path: "" }];
    if (currentDir) {
      const segs = currentDir.split("/").filter(Boolean);
      let acc = "";
      for (const seg of segs) {
        acc = acc ? `${acc}/${seg}` : seg;
        crumbs.push({ label: acc === archiveRoot ? `📦 ${seg}` : seg, path: acc });
      }
    }
    return crumbs;
  }, [currentDir, archiveRoot]);

  const searching = mode === "files" && query.trim().length > 0;

  const handleRefresh = useCallback(() => {
    if (refreshing) return;
    // One immediate detent so the press always shows a visible click, even when
    // the re-fetch resolves before the spin interval can fire.
    setSpinAngle((a) => a + RECYCLE_STEP);
    setRefreshing(true);
    setReloadNonce((n) => n + 1);
  }, [refreshing, setSpinAngle]);

  return (
    <View style={styles.container}>
      <View style={styles.breadcrumbBar}>
        <RefreshButton angle={spinAngle} onPress={handleRefresh} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.breadcrumbScroll} contentContainerStyle={styles.breadcrumbRow}>
          {breadcrumbs.map((c, i) => (
            <View key={`${c.path}-${i}`} style={styles.breadcrumbItem}>
              {i > 0 && <Text style={styles.breadcrumbSep}>/</Text>}
              <Pressable role="button" onPress={() => onPathChange(c.path)}>
                <Text style={styles.breadcrumbText}>{c.label}</Text>
              </Pressable>
            </View>
          ))}
          {data && data.type === "file" && (
            <View style={styles.breadcrumbItem}>
              <Text style={styles.breadcrumbSep}>/</Text>
              <Text style={[styles.breadcrumbText, styles.breadcrumbActive]}>
                {data.path.split("/").pop() ?? data.path}
              </Text>
            </View>
          )}
        </ScrollView>
      </View>
      {searching ? (
        <MatchResults
          matches={matches}
          fileListReady={fileList !== null}
          fileListCount={fileList?.length ?? 0}
          truncated={fileListTruncated}
          onPress={handleMatchPress}
        />
      ) : !loading && !error && data && data.type === "file" && isPdfPath(data.path) ? (
        // PDFs render full-bleed: PdfView scrolls itself, so it bypasses the
        // padded outer ScrollView (no gutter, no nested scrolling).
        <View style={styles.body}>
          <PdfView url={filesRawUrl(conn, nid, data.path)} />
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={styles.body}
          contentContainerStyle={styles.bodyContent}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          onLayout={handleLayout}
          onContentSizeChange={handleContentSizeChange}
        >
          {loading && <ActivityIndicator style={{ marginTop: 20 }} color="#888" />}
          {error && <Text style={styles.error}>{error}</Text>}
          {!loading && !error && data && data.type === "directory" && data.archive && (
            <ArchiveBanner conn={conn} nid={nid} path={data.path} archive={data.archive} />
          )}
          {!loading && !error && data && data.type === "directory" && (
            <DirectoryListing entries={data.entries} onEntryPress={handleEntryPress} path={data.path} />
          )}
          {!loading && !error && data && data.type === "file" && (
            // While 🔎 has a query, half a screen of room below the file lets
            // the last hits reach the middle line the drum snaps them to.
            <View ref={fileBodyRef} style={mode === "find" && query ? { paddingBottom: Math.round(Dimensions.get("window").height / 2) } : undefined}>
            <FileView
              data={data}
              hexDoc={hexDoc}
              conn={conn}
              nid={nid}
              line={line}
              lineEnd={lineEnd}
              imageSrcResolver={imageSrcResolver}
              onFilePress={handleFileLinkPress}
              onImagePress={onImagePress}
            />
            </View>
          )}
        </ScrollView>
      )}
      <SearchBar
        query={query}
        onChange={setQuery}
        mode={mode}
        fileLabel={data && data.type === "file" ? (data.path.split("/").pop() ?? data.path) : ""}
        find={mode === "find" ? find : null}
        onNext={find.next}
        onPrev={find.prev}
        onSeek={find.seek}
        onSubmitFiles={handleSubmitFiles}
        onClose={handleSearchClose}
      />
    </View>
  );
});

export default memo(FilesView);

// Shared pink/magenta "active" glow — matches the microscope search UI in
// expo/app/index.tsx so both feel like the same affordance.
const GLOW_BORDER = "rgba(255, 130, 180, 0.4)";
const GLOW_EMOJI_WEB = [
  "0 0 10px rgba(255, 130, 180, 0.9)",
  "0 0 25px rgba(255, 110, 165, 0.7)",
  "0 0 50px rgba(255, 100, 155, 0.4)",
  "0 2px 15px rgba(255, 120, 170, 0.6)",
].join(", ");

/** 🔎 finds in the open file; 🔮 fuzzy-searches paths. Which one is showing
 * is decided by the view, not by the operator. */
type SearchMode = "find" | "files";
const GLOW_INPUT_WEB = [
  "0 0 6px rgba(255, 130, 180, 0.5)",
  "0 0 14px rgba(255, 110, 165, 0.35)",
  "0 0 28px rgba(255, 100, 155, 0.2)",
].join(", ");

// Leading (left) ♻️ in the breadcrumb bar. Re-fetches the current file/directory
// and spins through 120° detents (shared with the main page's pull-to-refresh
// via RecycleGlyph) while the load is in flight.
function RefreshButton({ angle, onPress }: { angle: number; onPress: () => void }) {
  if (Platform.OS === "web") {
    return (
      <button
        type="button"
        aria-label="Refresh"
        onClick={onPress}
        style={{
          // No fixed width: the glyph sizes the button so the ♻️→`fold` gap
          // is supplied by breadcrumbBar's `gap`, exactly mirroring a folder
          // row (📁 dirIcon@15 + dirItem gap 8 → name). fontSize matches dirIcon.
          height: 36,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
        }}
      >
        <RecycleGlyph angle={angle} fontSize={15} />
      </button>
    );
  }
  return (
    <Pressable onPress={onPress} style={styles.refreshSlot} hitSlop={10} role="button" accessibilityLabel="Refresh">
      <RecycleGlyph angle={angle} fontSize={15} />
    </Pressable>
  );
}

function SearchBar({
  query,
  onChange,
  mode,
  fileLabel,
  find,
  onNext,
  onPrev,
  onSeek,
  onSubmitFiles,
  onClose,
}: {
  query: string;
  onChange: (v: string) => void;
  mode: SearchMode;
  /** The open file's name, for the 🔎 placeholder. */
  fileLabel: string;
  find: FindState | null;
  onNext: () => void;
  onPrev: () => void;
  /** The hit drum moved (hit units); `settled` when it has come to rest. */
  onSeek: (pos: number, settled: boolean) => void;
  /** Enter in 🔮 mode: open the top match. */
  onSubmitFiles: () => void;
  /** The input lost focus (keyboard dismissed, Esc, tap away). */
  onClose: () => void;
}) {
  // Glow/active state mirrors DOM focus directly — when the keyboard dismisses
  // (swipe-down, system), the input blurs and the UI should stop glowing.
  // The emoji toggle blurs/focuses explicitly; preventDefault on its mousedown
  // keeps it from stealing focus, so the toggle runs synchronously with the
  // pre-blur focus state.
  const [focused, setFocused] = useState(false);
  const active = focused;
  const webInputRef = useRef<HTMLInputElement>(null);
  const nativeInputRef = useRef<TextInput>(null);
  const drumRef = useRef<HitDrumHandle>(null);
  const finding = mode === "find";

  // A drum that comes to rest with the keyboard down is the reader parking on
  // a hit, as closing search is: carry its line into the URL the same way.
  const handleSeek = useCallback((pos: number, settled: boolean) => {
    onSeek(pos, settled);
    if (settled && document.activeElement !== webInputRef.current) onClose();
  }, [onSeek, onClose]);
  const handleStaticStep = useCallback((dir: 1 | -1) => (dir > 0 ? onNext : onPrev)(), [onNext, onPrev]);

  const toggleFocus = useCallback(() => {
    if (focused) {
      if (Platform.OS === "web") webInputRef.current?.blur();
      else nativeInputRef.current?.blur();
      if (query.length > 0) onChange("");
    } else {
      if (Platform.OS === "web") webInputRef.current?.focus({ preventScroll: true });
      else nativeInputRef.current?.focus();
    }
  }, [focused, query, onChange]);

  // iOS doesn't blur the input when the user swipes the keyboard down — the
  // DOM input stays "focused" while the keyboard is hidden. Watch the
  // VisualViewport and explicitly blur when the keyboard-height delta drops
  // back to 0, so the glow/active state tracks keyboard visibility.
  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    let kbWasOpen = false;
    const check = () => {
      // What the keyboard took, pan or no pan (see expo/lib/noPan.ts).
      const delta = window.innerHeight - vv.height;
      const kbOpen = delta > 1;
      if (kbWasOpen && !kbOpen && document.activeElement === webInputRef.current) {
        webInputRef.current?.blur();
      }
      kbWasOpen = kbOpen;
    };
    vv.addEventListener("resize", check);
    return () => vv.removeEventListener("resize", check);
  }, []);

  const placeholder = finding ? `Find in ${fileLabel}…` : "Fuzzy-search files…";
  const glyph = finding ? "🔎" : "🔮";

  if (Platform.OS === "web") {
    // In 🔎 mode the drum is always there, reading 0/0 until there is a
    // query, so typing never shoves the input sideways to make room.
    const showFind = finding && find !== null;
    // A drum only when there are hits to roll through; otherwise one static
    // reading — a line jump, or the miss.
    const drumLabel = !find ? undefined : query.length === 0 ? "0/0" : find.lineJump !== null
      ? (find.lineFound ? `L${find.lineJump}` : `no L${find.lineJump}`)
      : find.count > 0 ? undefined : "0/0";
    const miss = !!find && query.length > 0 && (find.lineJump !== null ? !find.lineFound : find.count === 0);
    // The × must not take focus either, or clearing would drop the keyboard.
    const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();
    return (
      <div style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        padding: "8px 8px",
        minHeight: 53,
        borderTop: "1px solid rgb(216, 216, 216)",
        backgroundColor: "#1a1a1a",
        flexShrink: 0,
        boxSizing: "border-box",
      }}>
        <button
          type="button"
          aria-label={active ? "Close search" : "Open search"}
          // Fire on press-DOWN (mousedown), not click. preventDefault keeps
          // the button from stealing focus from the input, so `focused` still
          // reflects the pre-tap state when toggleFocus runs.
          onMouseDown={(e) => {
            e.preventDefault();
            toggleFocus();
          }}
          style={{
            width: 36,
            height: 36,
            marginRight: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
          }}
        >
          <span style={{
            fontSize: 20,
            lineHeight: "20px",
            textShadow: active ? GLOW_EMOJI_WEB : undefined,
            transition: "text-shadow 160ms ease",
            pointerEvents: "none",
          }}>{glyph}</span>
        </button>
        <div style={{ position: "relative", flex: 1, minWidth: 0, display: "flex" }}>
        <input
          ref={webInputRef}
          type="search"
          value={query}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            onClose();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (finding) {
                const dir = e.shiftKey ? -1 : 1;
                if (drumRef.current) drumRef.current.step(dir);
                else (dir > 0 ? onNext : onPrev)();
              }
              else onSubmitFiles();
            } else if (e.key === "Escape") {
              e.preventDefault();
              webInputRef.current?.blur();
              onChange("");
            }
          }}
          placeholder={placeholder}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          style={{
            flex: 1,
            minWidth: 0,
            backgroundColor: "#111",
            color: "#e0e0e0",
            border: `1px solid ${active ? GLOW_BORDER : "#555"}`,
            borderRadius: 20,
            paddingLeft: 16,
            // Room for the × when there is something to clear.
            paddingRight: query.length > 0 ? 36 : 16,
            paddingTop: 6,
            paddingBottom: 6,
            fontSize: 16,
            lineHeight: "22px",
            fontFamily: "system-ui, -apple-system, sans-serif",
            outline: "none",
            boxSizing: "border-box",
            boxShadow: active ? GLOW_INPUT_WEB : undefined,
            transition: "border-color 160ms ease, box-shadow 160ms ease",
          }}
        />
        {query.length > 0 && (
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={() => onChange("")}
            style={{
              position: "absolute",
              right: 4,
              top: "50%",
              transform: "translateY(-50%)",
              width: 28,
              height: 28,
              borderRadius: 14,
              background: "transparent",
              border: "none",
              color: "#888",
              fontSize: 18,
              lineHeight: "28px",
              cursor: "pointer",
              padding: 0,
            }}
            aria-label="Clear search"
          >
            ×
          </button>
        )}
        </div>
        {showFind && find && (
          <HitDrum
            ref={drumRef}
            count={find.count}
            current={find.current}
            capped={find.capped}
            label={drumLabel}
            miss={miss}
            onSeek={handleSeek}
            onStaticStep={handleStaticStep}
          />
        )}
      </div>
    );
  }
  return (
    <View style={styles.searchBar}>
      <Pressable onPressIn={toggleFocus} style={styles.searchIconSlot} hitSlop={4} role="button" accessibilityLabel={active ? "Close search" : "Open search"}>
        <Text style={[
          { fontSize: 20 },
          active && {
            textShadowColor: "rgba(255, 130, 180, 0.8)",
            textShadowOffset: { width: 0, height: 0 },
            textShadowRadius: 16,
          },
        ]}>{glyph}</Text>
      </Pressable>
      <TextInput
        ref={nativeInputRef}
        value={query}
        onChangeText={onChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        placeholderTextColor="#556"
        style={[styles.searchInput, active && { borderColor: GLOW_BORDER }]}
        autoCorrect={false}
        autoCapitalize="none"
      />
    </View>
  );
}

function MatchResults({
  matches,
  fileListReady,
  fileListCount,
  truncated,
  onPress,
}: {
  matches: FuzzyMatch[];
  fileListReady: boolean;
  fileListCount: number;
  truncated: boolean;
  onPress: (path: string) => void;
}) {
  if (!fileListReady) {
    return (
      <View style={styles.body}>
        <ActivityIndicator style={{ marginTop: 20 }} color="#888" />
        <Text style={styles.searchHint}>Loading file index…</Text>
      </View>
    );
  }
  if (matches.length === 0) {
    return (
      <View style={styles.body}>
        <Text style={styles.searchHint}>No matches.</Text>
      </View>
    );
  }
  return (
    <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
      <Text style={styles.searchMeta}>
        {matches.length} match{matches.length === 1 ? "" : "es"}
        {truncated ? ` · searching ${fileListCount.toLocaleString()} indexed files (truncated)` : ""}
      </Text>
      <View style={styles.dirList}>
        {matches.map((m) => (
          <MatchRow key={m.value} match={m} onPress={() => onPress(m.value)} />
        ))}
      </View>
    </ScrollView>
  );
}

function MatchRow({ match, onPress }: { match: FuzzyMatch; onPress: () => void }) {
  const slash = match.value.lastIndexOf("/");
  const dir = slash >= 0 ? match.value.slice(0, slash + 1) : "";
  const base = slash >= 0 ? match.value.slice(slash + 1) : match.value;
  const baseStart = slash >= 0 ? slash + 1 : 0;
  const dirChars = renderHighlighted(dir, match.indices, 0, "#888");
  const baseChars = renderHighlighted(base, match.indices, baseStart, "#e0e0e0");
  return (
    <Pressable style={styles.dirItem} role="button" onPress={onPress}>
      <Text style={styles.dirIcon}>📄</Text>
      <Text style={styles.dirName} numberOfLines={1}>
        <Text style={{ color: "#888" }}>{dirChars}</Text>
        <Text>{baseChars}</Text>
      </Text>
    </Pressable>
  );
}

// Render a substring with highlight markers for indices that fall inside it.
function renderHighlighted(
  substr: string,
  indices: number[],
  offset: number,
  baseColor: string,
): ReactNode[] {
  const out: ReactNode[] = [];
  const set = new Set(indices.map((i) => i - offset).filter((i) => i >= 0 && i < substr.length));
  for (let i = 0; i < substr.length; i++) {
    const ch = substr[i];
    if (set.has(i)) {
      out.push(
        <Text key={i} style={{ color: "#ffd966", fontWeight: "700" }}>{ch}</Text>,
      );
    } else {
      out.push(
        <Text key={i} style={{ color: baseColor }}>{ch}</Text>,
      );
    }
  }
  return out;
}

function DirectoryListing({
  entries,
  onEntryPress,
  path,
}: {
  entries: FilesEntry[];
  onEntryPress: (entry: FilesEntry) => void;
  path: string;
}) {
  if (entries.length === 0) {
    return <Text style={styles.empty}>Empty directory</Text>;
  }
  return (
    <View style={styles.dirList}>
      {entries.map((entry) => (
        <Pressable
          key={entry.name}
          style={styles.dirItem}
          role="button"
          onPress={() => onEntryPress(entry)}
        >
          <Text style={styles.dirIcon}>{entry.is_dir ? "📁" : entry.link !== undefined ? "🔗" : entry.archive ? "📦" : "📄"}</Text>
          <Text style={styles.dirName}>
            {entry.name}{entry.is_dir ? "/" : ""}
            {entry.link !== undefined && <Text style={styles.linkTarget}> → {entry.link}</Text>}
          </Text>
          {!entry.is_dir && entry.size !== null && (
            <Text style={styles.dirSize}>{formatSize(entry.size)}</Text>
          )}
        </Pressable>
      ))}
    </View>
  );
}

function FileView({
  data,
  hexDoc,
  conn,
  nid,
  line,
  lineEnd,
  imageSrcResolver,
  onFilePress,
  onImagePress,
}: {
  data: Extract<FilesResponse, { type: "file" }>;
  hexDoc: HexDoc | null;
  conn: ConnectionParams;
  nid: string;
  line?: number;
  lineEnd?: number;
  imageSrcResolver: (src: string) => string | null;
  onFilePress: (relativePath: string) => void;
  onImagePress?: (uri: string) => void;
}) {
  if (data.link !== undefined) {
    // A link inside an archive: shown, never followed.
    return <Text style={styles.notice}>🔗 A link to <Text style={styles.linkTarget}>{data.link || "(nothing)"}</Text></Text>;
  }

  if (hexDoc) {
    return <HexView doc={hexDoc} />;
  }

  if (data.notice) {
    return <Text style={styles.notice}>{data.notice}</Text>;
  }

  if (isAudioPath(data.path)) {
    // Before the size check: a song is past the inline limit by nature, and
    // it streams rather than loads.
    if (Platform.OS === "web") return <AudioCard conn={conn} nid={nid} path={data.path} />;
    return <Text style={styles.notice}>Audio: {data.path}</Text>;
  }

  if (data.truncated) {
    return (
      <View>
        <Text style={styles.notice}>File too large to display inline ({data.size === null ? "over 2 MB" : formatSize(data.size)}).</Text>
        {Platform.OS === "web" && (
          // Downloaded rather than opened, for the reason in `lib/download.ts`:
          // the raw URL carries `?token=`, and a tab navigated to it hands the
          // token to the address bar and to anything saved from that page.
          <Pressable
            role="button"
            onPress={() => {
              downloadUrl(filesRawUrl(conn, nid, data.path), downloadNameFor(data.path))
                .catch((err) => console.error("Download failed:", err));
            }}
          >
            <Text style={styles.link}>Download</Text>
          </Pressable>
        )}
      </View>
    );
  }

  if (isImagePath(data.path)) {
    const url = filesRawUrl(conn, nid, data.path);
    if (Platform.OS === "web") {
      return (
        <Pressable role="button" aria-label="Open image" onPress={() => onImagePress?.(url)}>
          <img src={url} alt={data.path} style={{ maxWidth: "100%", borderRadius: 4, display: "block" }} />
        </Pressable>
      );
    }
    return <Text style={styles.notice}>Image: {data.path}</Text>;
  }

  if (isPdfPath(data.path)) {
    // PdfView is platform-split: the .web implementation lazy-imports pdf.js and
    // paints pages to canvas (scroll + zoom); native gets a stub.
    return <PdfView url={filesRawUrl(conn, nid, data.path)} />;
  }

  // `notes.md.gz` opens as its content, so it renders as the markdown it is.
  if (isMarkdownPath(data.path.replace(/\.(gz|br|zst)$/i, ""))) {
    return (
      <MarkdownContent
        content={data.content}
        onFilePress={onFilePress}
        imageSrcResolver={imageSrcResolver}
      />
    );
  }

  // Plain text / code: render with line numbers + anchors
  return <CodeView content={data.content} highlight={data.highlight ?? null} line={line} lineEnd={lineEnd} />;
}


/** What the operator should know about an archive's listing, and, at its
 *  root, the archive itself to download (the 📦 row opens it as a folder, so
 *  this is the one place its bytes are offered). */
function ArchiveBanner({ conn, nid, path, archive }: {
  conn: ConnectionParams;
  nid: string;
  path: string;
  archive: NonNullable<Extract<FilesResponse, { type: "directory" }>["archive"]>;
}) {
  const atRoot = path === archive.root;
  const notes: string[] = [];
  if (archive.skipped) {
    notes.push(`${archive.skipped} member${archive.skipped === 1 ? "" : "s"} hidden: ${archive.skipped === 1 ? "its name climbs" : "their names climb"} out of the archive.`);
  }
  if (archive.partial) notes.push("This listing is incomplete: the archive is cut short, or larger than brane will scan.");
  if (!atRoot && notes.length === 0) return null;
  return (
    <View style={styles.archiveBanner}>
      {notes.map((n) => <Text key={n} style={styles.archiveNote}>{n}</Text>)}
      {atRoot && Platform.OS === "web" && (
        <Pressable
          role="button"
          onPress={() => {
            downloadUrl(filesRawUrl(conn, nid, archive.root), downloadNameFor(archive.root))
              .catch((err) => console.error("Download failed:", err));
          }}
        >
          <Text style={styles.archiveDownload}>Download {archive.root.split("/").pop()}</Text>
        </Pressable>
      )}
    </View>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#111" },
  breadcrumbBar: {
    flexDirection: "row",
    alignItems: "center",
    // Mirror a folder row's left geometry so the ♻️ sits in the same column
    // as the 📁 icons (bodyContent pad 12 + dirItem pad 8 = 20) and the gap
    // to `fold` equals the dirItem icon→name gap (8).
    paddingLeft: 20,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#555",
    backgroundColor: "#1a1a1a",
  },
  breadcrumbScroll: { flex: 1 },
  refreshSlot: {
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  breadcrumbRow: {
    flexDirection: "row",
    alignItems: "center",
    // Left inset + ♻️→`fold` gap come from breadcrumbBar (paddingLeft + gap).
    paddingRight: 12,
    paddingVertical: 8,
  },
  breadcrumbItem: {
    flexDirection: "row",
    alignItems: "center",
  },
  breadcrumbSep: { color: "#555", fontSize: 14, marginHorizontal: 4 },
  // Size/weight match the folder rows' dirName (14, normal); only the color
  // differs (blue) to keep the breadcrumb reading as navigable links.
  breadcrumbText: { color: "#6cb6ff", fontSize: 14, fontWeight: "normal", fontFamily: monoFont },
  breadcrumbActive: { color: "#e0e0e0" },
  body: { flex: 1 },
  bodyContent: { padding: 12 },
  dirList: {},
  dirItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 4,
    gap: 8,
  },
  dirIcon: { fontSize: 15 },
  dirName: { color: "#e0e0e0", fontSize: 14, flex: 1, fontFamily: monoFont },
  dirSize: { color: "#666", fontSize: 12, fontFamily: monoFont },
  error: { color: "#ff6b6b", fontSize: 14, padding: 12 },
  empty: { color: "#666", fontSize: 14, fontStyle: "italic", padding: 12 },
  notice: { color: "#888", fontSize: 14, padding: 12 },
  audioTitle: { color: "#ddd", fontSize: 15, lineHeight: 20 },
  audioLine: { color: "#8a9590", fontSize: 13, marginTop: 4, fontVariant: ["tabular-nums"] },
  link: { color: "#6cb6ff", fontSize: 14, padding: 12, textDecorationLine: "underline" },
  linkTarget: { color: "#888", fontFamily: monoFont },
  archiveBanner: { paddingHorizontal: 8, paddingBottom: 8, gap: 4 },
  archiveNote: { color: "#d8a657", fontSize: 13 },
  archiveDownload: { color: "#6cb6ff", fontSize: 13, textDecorationLine: "underline" },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    padding: 8,
    paddingBottom: Platform.OS === "web" ? 8 : 24,
    minHeight: 53,
    borderTopWidth: 1,
    borderTopColor: "rgb(216, 216, 216)",
    backgroundColor: "#1a1a1a",
  },
  searchIconSlot: {
    width: 36,
    height: 36,
    marginRight: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  searchInput: {
    flex: 1,
    backgroundColor: "#111",
    color: "#e0e0e0",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    fontSize: 15,
    minHeight: 36,
    borderWidth: 1,
    borderColor: "#555",
  },
  searchHint: { color: "#666", fontSize: 13, padding: 12, fontStyle: "italic" },
  searchMeta: { color: "#666", fontSize: 12, paddingHorizontal: 4, paddingBottom: 6, fontFamily: monoFont },
});
