import { useCallback, useEffect, useRef, useState } from "react";
import { isSharedSlug, resolveWikiLink } from "@shared/wiki-links";
import { neighborColumns } from "@shared/wiki-window";
import {
  View,
  Text,
  Pressable,
  Modal,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Animated,
  Easing,
  useWindowDimensions,
} from "react-native";
import { MarkdownContent } from "@/components/Markdown";
import { readWikiSection, wikiAssetUrl, type ConnectionParams, type WikiSectionRead } from "@/lib/api";

/** Where the reader is pointed. `source: "protocols"` reads the protocol
 *  library, which the daemon exposes as a wiki source. */
export type WikiTarget = { source: string; slug: string; anchor?: string };

/** Sections preloaded on each side of the one being read, and how many of those
 *  speculative fetches may be in flight at once. The window we ask the server
 *  for is the same depth, so one response names everything we preload from it. */
const PRELOAD_DEPTH = 3;
const PRELOAD_CONCURRENCY = 2;

/** How long the sheet takes to travel in; leaving is a touch quicker. */
const SHEET_IN_MS = 220;
const SHEET_OUT_MS = 160;

/** Cache key for a section. Normalized so the two ways of naming the same
 *  section — `foo` vs `foo.md`, `#intro` vs `intro` — share one entry. */
function sectionKey(source: string, slug: string, anchor?: string | null): string {
  return [source, slug.replace(/\.md$/, ""), (anchor ?? "").replace(/^#/, "")].join("\u0000");
}

function WikiNavRow({
  heading,
  preview,
  direction,
  onPress,
}: {
  heading: string | null;
  preview: string;
  direction: "up" | "down";
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.wikiNavItem}>
      <Text style={styles.wikiNavArrow}>{direction === "up" ? "↑" : "↓"}</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.wikiNavHeading} numberOfLines={1}>
          {heading ?? "(intro)"}
        </Text>
        {!!preview && (
          <Text style={styles.wikiNavPreview} numberOfLines={1}>
            {preview}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

/** A modal wiki reader fed by /api/wiki/read: shows one section's fully
 *  rendered, interactive markdown plus tappable prev/next neighbors. Intra-wiki
 *  links re-target the modal (walk the wiki graph); `/protocol` commands do too,
 *  jumping into the protocol library; narrative citations jump to the narrative;
 *  relative images load from the wiki source; external links open in the
 *  browser. */
export default function WikiReader({
  conn,
  target,
  onClose,
}: {
  conn: ConnectionParams;
  target: WikiTarget;
  onClose: () => void;
}) {
  const [nav, setNav] = useState(target);
  const [data, setData] = useState<WikiSectionRead | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Sections already fetched, and fetches still in flight. Both live for as
  // long as the sheet is mounted — the reader is a walk around one neighborhood
  // of the graph, and re-walking it on a slow link is what makes it feel bad.
  const cacheRef = useRef(new Map<string, WikiSectionRead>());
  const inflightRef = useRef(new Map<string, Promise<WikiSectionRead>>());

  // Only the sheet travels. Modal's own `animationType="slide"` translates the
  // whole tree — the full-screen dim included — so the backdrop's top edge
  // sweeps up the screen on open. With the modal itself un-animated, the dim is
  // simply there, all at once, and the sheet rises through it.
  const { height: windowHeight } = useWindowDimensions();
  const sheetAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(sheetAnim, {
      toValue: 1,
      duration: SHEET_IN_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [sheetAnim]);

  // Run the arrival backwards before handing control back to the parent, which
  // unmounts us — otherwise closing is a jump cut.
  const dismiss = useCallback(() => {
    Animated.timing(sheetAnim, {
      toValue: 0,
      duration: SHEET_OUT_MS,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(() => onClose());
  }, [sheetAnim, onClose]);

  // Another daemon is another wiki; never serve it a previous one's sections.
  useEffect(() => {
    cacheRef.current.clear();
    inflightRef.current.clear();
  }, [conn]);

  // A new target (different search hit, different `/command`) resets where we
  // are in the graph.
  useEffect(() => {
    setNav(target);
  }, [target.source, target.slug, target.anchor]);

  // Fetch a section, or hand back the copy we already have. Concurrent callers
  // for the same key share one request, so a preload the operator taps into
  // mid-flight is joined rather than duplicated.
  const load = useCallback(
    (t: WikiTarget): Promise<WikiSectionRead> => {
      const key = sectionKey(t.source, t.slug, t.anchor);
      const hit = cacheRef.current.get(key);
      if (hit) return Promise.resolve(hit);
      const pending = inflightRef.current.get(key);
      if (pending) return pending;
      const req = readWikiSection(conn, {
        source: t.source,
        slug: t.slug,
        anchor: t.anchor,
        window: PRELOAD_DEPTH,
      })
        .then((d) => {
          cacheRef.current.set(key, d);
          // The response also names itself canonically. Cache it under that key
          // too, so arriving at a section by anchor and arriving at it as a
          // page's first section aren't two fetches for one body of text.
          cacheRef.current.set(sectionKey(d.source, d.slug, d.current.anchor), d);
          return d;
        })
        .finally(() => {
          inflightRef.current.delete(key);
        });
      inflightRef.current.set(key, req);
      return req;
    },
    [conn],
  );

  // Warm the sections a tap away in both directions. `prev`/`next` arrive
  // nearest-first, so interleaving them fetches ±1 before ±2 — and each warmed
  // section carries its own window, so a walk stays a hop ahead of the reader.
  const preloadAround = useCallback(
    async (d: WikiSectionRead, cancelled: () => boolean) => {
      const queue: WikiTarget[] = [];
      for (let i = 0; i < PRELOAD_DEPTH; i++) {
        if (d.next[i]) queue.push({ source: d.source, slug: d.slug, anchor: d.next[i].anchor });
        if (d.prev[i]) queue.push({ source: d.source, slug: d.slug, anchor: d.prev[i].anchor });
      }
      let cursor = 0;
      // Bounded: speculative fetches must never queue ahead of a section the
      // operator actually asked for, which is the whole problem on a slow link.
      const worker = async () => {
        while (!cancelled()) {
          const next = queue[cursor++];
          if (!next) return;
          await load(next).catch(() => {});
        }
      };
      await Promise.all(Array.from({ length: PRELOAD_CONCURRENCY }, worker));
    },
    [load],
  );

  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    const cached = cacheRef.current.get(sectionKey(nav.source, nav.slug, nav.anchor));
    if (cached) {
      // Straight to rendered text: no spinner, no flash, no round trip.
      setData(cached);
      setError(null);
      setLoading(false);
      void preloadAround(cached, isCancelled);
    } else {
      setLoading(true);
      setError(null);
      load(nav)
        .then((d) => {
          if (cancelled) return;
          setData(d);
          setLoading(false);
          void preloadAround(d, isCancelled);
        })
        .catch((e) => {
          if (cancelled) return;
          setError(String(e?.message ?? e));
          setLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [load, preloadAround, nav.source, nav.slug, nav.anchor]);

  // Intra-wiki link → re-target the modal, resolved relative to the page
  // being read (a page's slug is its path under wiki/, so `../c.md` from
  // `shared/a.md` is the local `c.md`). The same resolver runs daemon-side, so
  // the reader and `read_wiki` agree. `#anchor` jumps within the page; links
  // that escape the wiki dir, or carry a scheme, are left inert.
  const handleFilePress = useCallback(
    (href: string) => {
      const target = resolveWikiLink(nav.slug, href);
      if (!target) return;
      const slug = target.slug.replace(/\.md$/, "");
      setNav((n) => ({ source: n.source, slug, anchor: target.anchor }));
    },
    [nav.slug],
  );

  // A `/command` inside a page opens that protocol here rather than anywhere
  // else — protocols cite each other constantly, so this is the graph walk
  // again, one source over.
  const handleProtocolPress = useCallback((name: string) => {
    setNav({ source: "protocols", slug: name });
  }, []);

  // Relative images load from the current page's wiki source; external/escaping
  // srcs pass through or drop to alt text.
  const resolveImage = useCallback(
    (src: string) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return src;
      if (src.startsWith("/") || src.split("/").includes("..")) return null;
      return wikiAssetUrl(conn, nav.source, src);
    },
    [conn, nav.source],
  );

  const columns = neighborColumns(data?.prev ?? [], data?.next ?? []);

  return (
    <Modal visible animationType="none" transparent onRequestClose={dismiss}>
      <View style={styles.wikiReaderOverlay}>
        {/* The dim above the sheet is a tap target that closes it — a sibling
            laid *behind* the sheet, not a parent wrapped around it, so a tap on
            the sheet's own content never reaches it and nothing has to stop
            propagation. Same escape as the ✕, one gesture instead of a hunt. */}
        <Pressable
          onPress={dismiss}
          accessibilityLabel="Close wiki"
          style={StyleSheet.absoluteFill}
        />
        <Animated.View
          style={[
            styles.wikiReaderSheet,
            {
              transform: [
                {
                  translateY: sheetAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [windowHeight, 0],
                  }),
                },
              ],
            },
          ]}
        >
          <View style={styles.wikiReaderTopBar}>
            <Text style={styles.wikiReaderTitle} numberOfLines={1}>
              {nav.slug.replace(/\.md$/, "")}{" "}
              <Text style={styles.wikiSource}>
                {nav.source}
                {isSharedSlug(nav.slug) ? " · shared" : ""}
              </Text>
            </Text>
            {loading && data && <ActivityIndicator size="small" color="#8fd4b4" style={styles.wikiReaderBusy} />}
            <Pressable onPress={dismiss} style={styles.wikiReaderClose}>
              <Text style={styles.wikiReaderCloseText}>{"✕"}</Text>
            </Pressable>
          </View>
          {loading && !data ? (
            <View style={styles.center}>
              <ActivityIndicator color="#8fd4b4" />
            </View>
          ) : error && !data ? (
            <View style={styles.center}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : data ? (
            // A section we haven't got yet dims what's on screen rather than
            // replacing it with a spinner: a slow hop reads as "stale for a
            // moment", not as an empty sheet.
            <ScrollView
              style={[{ flex: 1 }, loading && styles.wikiStale]}
              contentContainerStyle={{ padding: 14 }}
            >
              {/* Naming the target matters here: the header already points at
                  the section we failed to fetch, while the body below is still
                  the last one that loaded. */}
              {!!error && (
                <Text style={styles.wikiErrorBanner}>
                  {`Couldn't load ${nav.slug.replace(/\.md$/, "")}${nav.anchor ? `#${nav.anchor}` : ""} — ${error}`}
                </Text>
              )}
              {/* `prev`/`next` arrive nearest-first (right for the preloader
                  above, wrong for a column): `neighborColumns` puts the rows
                  above the section in document order, so the page reads
                  1 → 2 → 3 → [4] → 5 rather than 3 → 2 → 1 → [4] → 5. */}
              {columns.above.length > 0 && (
                <View style={styles.wikiNavGroup}>
                  {columns.above.map((n) => (
                    <WikiNavRow
                      key={n.anchor}
                      heading={n.heading}
                      preview={n.preview}
                      direction="up"
                      onPress={() => setNav((cur) => ({ ...cur, anchor: n.anchor }))}
                    />
                  ))}
                </View>
              )}
              <Text style={styles.wikiPosition}>
                {data.position.index + 1} / {data.position.total}
              </Text>
              <MarkdownContent
                content={data.current.content}
                onFilePress={handleFilePress}
                onProtocolPress={handleProtocolPress}
                imageSrcResolver={resolveImage}
              />
              {columns.below.length > 0 && (
                <View style={styles.wikiNavGroup}>
                  {columns.below.map((n) => (
                    <WikiNavRow
                      key={n.anchor}
                      heading={n.heading}
                      preview={n.preview}
                      direction="down"
                      onPress={() => setNav((cur) => ({ ...cur, anchor: n.anchor }))}
                    />
                  ))}
                </View>
              )}
            </ScrollView>
          ) : null}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  errorText: {
    color: "#e07070",
    fontSize: 14,
    textAlign: "center",
  },
  wikiSource: {
    color: "#7a8a9a",
    fontSize: 11,
    fontFamily: "monospace",
    backgroundColor: "#2a2a32",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: "hidden",
  },
  wikiReaderOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  wikiReaderSheet: {
    backgroundColor: "#16161a",
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    maxHeight: "88%",
    minHeight: "55%",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(143, 212, 180, 0.3)",
  },
  wikiReaderTopBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#2a2a32",
  },
  wikiReaderTitle: {
    color: "#d8d8dd",
    fontSize: 15,
    fontWeight: "600",
    fontFamily: "monospace",
    flex: 1,
  },
  wikiReaderClose: {
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  wikiReaderBusy: {
    marginRight: 6,
  },
  wikiStale: {
    opacity: 0.45,
  },
  wikiErrorBanner: {
    color: "#e07070",
    fontSize: 12,
    marginBottom: 10,
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: "rgba(224, 112, 112, 0.1)",
    borderRadius: 6,
  },
  wikiReaderCloseText: {
    color: "#888",
    fontSize: 18,
  },
  wikiPosition: {
    color: "#667",
    fontSize: 11,
    fontFamily: "monospace",
    marginBottom: 6,
  },
  wikiNavGroup: {
    gap: 4,
    marginVertical: 10,
  },
  wikiNavItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: "rgba(143, 212, 180, 0.06)",
    borderRadius: 6,
  },
  wikiNavArrow: {
    color: "#8fd4b4",
    fontSize: 14,
    width: 14,
    textAlign: "center",
  },
  wikiNavHeading: {
    color: "#bcd",
    fontSize: 13,
    fontWeight: "600",
  },
  wikiNavPreview: {
    color: "#778",
    fontSize: 11,
  },
});
