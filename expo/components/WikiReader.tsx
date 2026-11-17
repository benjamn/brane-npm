import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useMarkdownLinks } from "@/components/MarkdownLinks";
import { protocolReaderTarget, type ProtocolNamespace } from "@shared/protocol-names";
import {
  approveProtocolFile,
  listPendingProtocols,
  readWikiSection,
  wikiAssetUrl,
  type ConnectionParams,
  type WikiSectionRead,
} from "@/lib/api";
import { formatLineDiff, lineDiff, visibleText } from "@shared/line-diff";
import { APPROVE_GUARD_MS, approvalStep, approvalSummary, approveGuarded, type Settled } from "@shared/approval-queue";

/** Where the reader is pointed. `source: "protocols"` reads brane's built-in
 *  protocols, which the daemon exposes as a wiki source; `protocols:home` and
 *  `protocols:fold` read the operator's and the narrative's fold's. */
export type WikiTarget = {
  source: string;
  slug: string;
  anchor?: string;
  /** A protocol file awaiting the operator's approval: the reader shows its
   *  raw text and offers to approve it (docs/protocols.md#approval).
   *  `queue` is every pending file to walk, this one included, in order;
   *  without it the reader shows `path` alone. */
  pending?: { path: string; queue?: string[] };
};

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
    <Pressable onPress={onPress} role="button" style={styles.wikiNavItem}>
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

/** Who wrote the protocol on screen, when it isn't one of brane's built-ins,
 *  and what it shadows or is shadowed by: an operator reading a fold's
 *  `/review` should never take it for brane's. Null for wiki pages and for a
 *  built-in nothing shadows. */
function protocolNote(nav: WikiTarget, layers: Record<string, ProtocolNamespace[]> | undefined): string | null {
  if (nav.source !== "protocols" && !nav.source.startsWith("protocols:")) return null;
  const from = (nav.source === "protocols" ? "brane" : nav.source.slice("protocols:".length)) as ProtocolNamespace;
  const name = nav.slug.replace(/\.md$/, "");
  const froms = layers?.[name] ?? [from];
  const others = froms.filter((f) => f !== from).map((f) => `/${f}.${name}`);
  const whose =
    from === "fold" ? "This project's protocol" : from === "home" ? "Your protocol (~/.brane/protocols)" : "Brane's built-in";
  if (froms[0] !== from) return `${whose}, shadowed by /${froms[0]}.${name}, which is the one in force.`;
  if (others.length > 0) return `${whose}. It shadows ${others.join(", ")}.`;
  return from === "brane" ? null : `${whose}, not one of brane's built-ins.`;
}

/** Protocol files awaiting approval, one at a time, each shown as what is
 *  approved: the file's raw text, whole (and, if an earlier version was
 *  approved, the diff), from the same `/api/protocols/pending` row whose
 *  hash Approve sends, as `brane protocol approve` does. Not the reader's
 *  rendered sections: those come from another request, one section at a
 *  time, and an agent could swap the file between the two. A 409 (the file
 *  changed) fetches the rows again and asks the operator to look again.
 *
 *  `paths` is the queue (`src/shared/approval-queue.ts`). Approving a file
 *  moves straight to the next, with Approve held back for a moment so the
 *  tap that approved one can't land on the next unread. Skip leaves a file
 *  pending and moves on. Nothing here declines a file: closing the reader
 *  approves nothing, and an unapproved file is one agents ignore. */
function ApprovalView({
  conn,
  paths,
  onApproved,
  onCurrent,
}: {
  conn: ConnectionParams;
  paths: readonly string[];
  onApproved?: () => void;
  /** The file on screen and its namespace, for the reader's title; null
   *  once the queue is done (or while its row hasn't loaded). */
  onCurrent?: (current: { path: string; from: ProtocolNamespace } | null) => void;
}) {
  type Row = Awaited<ReturnType<typeof listPendingProtocols>>[number];
  const [rows, setRows] = useState<Map<string, Row> | undefined>(undefined);
  const [settled, setSettled] = useState<ReadonlyMap<string, Settled>>(() => new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [whole, setWhole] = useState(false);
  const settle = useCallback((path: string, what: Settled) => {
    setSettled((prev) => new Map(prev).set(path, what));
  }, []);
  const load = useCallback(() => {
    setRows(undefined);
    listPendingProtocols(conn)
      .then((list) => setRows(new Map(list.map((r) => [r.path, r]))))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [conn]);
  useEffect(load, [load]);

  const step = approvalStep(paths, settled);
  const current = step.path;
  const row = current !== null ? rows?.get(current) : undefined;
  // A queued file the daemon no longer lists was approved elsewhere or is
  // gone: nothing to show, so pass over it.
  useEffect(() => {
    if (current !== null && rows !== undefined && !rows.has(current)) settle(current, "gone");
  }, [current, rows, settle]);
  const from = row?.from;
  useEffect(() => {
    onCurrent?.(current !== null && from ? { path: current, from } : null);
  }, [current, from, onCurrent]);
  // An error belongs to the file it was raised on: a failed Approve whose
  // reload finds that file gone must not sit above the next one.
  useEffect(() => {
    setError(null);
  }, [current]);

  // Approve is held back briefly each time a file (or a changed version of
  // one) appears. The time it appeared is noted during render, in a ref, so
  // the handler refuses a tap from the very first frame; `guarded` is state
  // only so the button dims and comes back by itself.
  const shown = row ? `${row.path}\n${row.sha256}` : null;
  const shownRef = useRef<{ key: string | null; at: number }>({ key: null, at: 0 });
  if (shownRef.current.key !== shown) shownRef.current = { key: shown, at: Date.now() };
  const [guarded, setGuarded] = useState(true);
  useEffect(() => {
    if (shown === null) return;
    setGuarded(true);
    setWhole(false);
    const timer = setTimeout(() => setGuarded(false), APPROVE_GUARD_MS);
    return () => clearTimeout(timer);
  }, [shown]);

  const approve = useCallback(() => {
    if (!row || busy || approveGuarded(shownRef.current.at, Date.now())) return;
    setBusy(true);
    setError(null);
    approveProtocolFile(conn, row.path, row.sha256)
      .then(() => {
        setBusy(false);
        settle(row.path, "approved");
        onApproved?.();
      })
      .catch((e) => {
        setBusy(false);
        setError(`${e instanceof Error ? e.message : String(e)}. Showing the file as it is now.`);
        load();
      });
  }, [conn, row, busy, settle, onApproved, load]);

  if (current === null) return <Text style={styles.approvalText}>{approvalSummary(step)}</Text>;
  if (rows === undefined || !row) {
    return error ? <Text style={styles.wikiErrorBanner}>{error}</Text> : <ActivityIndicator color="#8fd4b4" />;
  }
  const changed = row.approved_content !== undefined;
  return (
    <View style={styles.approvalBar}>
      {step.total > 1 && <Text style={styles.approvalCount}>{`${step.position} of ${step.total}`}</Text>}
      <Text style={styles.approvalText}>
        {`${changed ? "Changed since you approved it" : "Not approved"}: agents ignore ${row.path} until you approve it. Approve approves exactly the text below.`}
      </Text>
      {!!error && <Text style={styles.wikiErrorBanner}>{error}</Text>}
      {changed && !whole && (
        <Text style={styles.approvalDiff}>{visibleText(formatLineDiff(lineDiff(row.approved_content!, row.content)))}</Text>
      )}
      {(!changed || whole) && <Text style={styles.approvalDiff}>{visibleText(row.content)}</Text>}
      <View style={styles.approvalButtons}>
        {changed && (
          <Pressable role="button" onPress={() => setWhole((w) => !w)} style={styles.approvalButton}>
            <Text style={styles.approvalButtonText}>{whole ? "Show changes" : "Show whole file"}</Text>
          </Pressable>
        )}
        {step.total > 1 && (
          <Pressable
            role="button"
            onPress={() => {
              // Held back like Approve: the file that appears next must not
              // be skipped, unseen, by the same double tap.
              if (approveGuarded(shownRef.current.at, Date.now())) return;
              settle(row.path, "skipped");
            }}
            disabled={busy || guarded}
            style={[styles.approvalButton, (busy || guarded) && styles.approvalHeld]}
          >
            <Text style={styles.approvalButtonText}>Skip</Text>
          </Pressable>
        )}
        <Pressable
          role="button"
          onPress={approve}
          disabled={busy || guarded}
          style={[styles.approvalButton, styles.approvalPrimary, (busy || guarded) && styles.approvalHeld]}
        >
          <Text style={styles.approvalButtonText}>{busy ? "Approving…" : "Approve"}</Text>
        </Pressable>
      </View>
      <Text style={styles.approvalHint}>
        {step.total > 1
          ? "Skip leaves this file pending and shows the next. Closing approves nothing: agents ignore a file until you approve it."
          : "Closing approves nothing: agents ignore this file until you approve it."}
      </Text>
    </View>
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
  nid,
  onClose,
  onApproved,
}: {
  conn: ConnectionParams;
  target: WikiTarget;
  /** The narrative the reader was opened from: its fold's protocols are the
   *  `protocols:fold` source. */
  nid?: string;
  onClose: () => void;
  /** Called after the operator approves a pending protocol here, so the
   *  screen can fetch its protocol list again. */
  onApproved?: () => void;
}) {
  const { protocolLayers } = useMarkdownLinks();
  const [nav, setNav] = useState(target);
  // The pending files to walk, and the one on screen now (for the title).
  const pendingPaths = useMemo(() => (nav.pending ? nav.pending.queue ?? [nav.pending.path] : []), [nav.pending]);
  const [pendingNow, setPendingNow] = useState<{ path: string; from: ProtocolNamespace } | null>(null);
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
        nid,
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
    [conn, nid],
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
  // It opens what that name resolves to for this narrative, the same file its
  // agent's `read_protocol` would return.
  const handleProtocolPress = useCallback((name: string) => {
    const t = protocolReaderTarget(name, protocolLayers ?? {});
    if (t) setNav(t);
  }, [protocolLayers]);

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
          tabIndex={-1}
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
            {nav.pending ? (
              <Text style={styles.wikiReaderTitle} numberOfLines={1}>
                {pendingNow ? (pendingNow.path.split("/").pop() ?? pendingNow.path).replace(/\.md$/, "") : "Protocols"}
                {/* The namespace, since a home and a fold file can share a
                    name; nothing once the walk is done. */}
                {pendingNow && <>{" "}<Text style={styles.wikiSource}>{`${pendingNow.from} · awaiting approval`}</Text></>}
              </Text>
            ) : (
              <Text style={styles.wikiReaderTitle} numberOfLines={1}>
                {nav.slug.replace(/\.md$/, "")}{" "}
                <Text style={styles.wikiSource}>
                  {nav.source}
                  {isSharedSlug(nav.slug) ? " · shared" : ""}
                </Text>
              </Text>
            )}
            {loading && data && <ActivityIndicator size="small" color="#8fd4b4" style={styles.wikiReaderBusy} />}
            <Pressable onPress={dismiss} role="button" aria-label="Close wiki" style={styles.wikiReaderClose}>
              <Text style={styles.wikiReaderCloseText}>{"✕"}</Text>
            </Pressable>
          </View>
          {nav.pending ? (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14 }}>
              <ApprovalView conn={conn} paths={pendingPaths} onApproved={onApproved} onCurrent={setPendingNow} />
            </ScrollView>
          ) : loading && !data ? (
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
              {!!protocolNote(nav, protocolLayers) && (
                <Text style={styles.wikiProtocolNote}>{protocolNote(nav, protocolLayers)}</Text>
              )}
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
  approvalBar: {
    marginBottom: 12,
    padding: 10,
    borderRadius: 6,
    backgroundColor: "rgba(201, 179, 122, 0.12)",
  },
  approvalText: {
    color: "#c9b37a",
    fontSize: 13,
  },
  approvalCount: {
    color: "#8a7d55",
    fontSize: 11,
    marginBottom: 4,
  },
  approvalHint: {
    color: "#8a7d55",
    fontSize: 11,
    marginTop: 8,
  },
  approvalHeld: {
    opacity: 0.5,
  },
  approvalButtons: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
  },
  approvalButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#c9b37a",
  },
  approvalPrimary: {
    backgroundColor: "rgba(201, 179, 122, 0.25)",
  },
  approvalButtonText: {
    color: "#e8d9a8",
    fontSize: 13,
  },
  approvalDiff: {
    marginTop: 8,
    color: "#ccc",
    fontSize: 12,
    fontFamily: "monospace",
  },
  wikiProtocolNote: {
    color: "#c9b37a",
    fontSize: 12,
    marginBottom: 10,
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
