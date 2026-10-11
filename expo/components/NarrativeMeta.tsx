import { useEffect, useReducer } from "react";
import { View, Text, StyleSheet } from "react-native";
import type { StyleProp, ViewStyle, TextStyle } from "react-native";
import CopyButton from "@/components/CopyButton";
import { relPart, formatActivitySpan } from "@shared/narrative-format";

// The span wording itself lives in `src/shared/narrative-format.ts` so the
// server-side HTML export words it identically. Re-exported here because this
// module is where the app has always imported it from.
export { formatActivitySpan };

// ── Live updates ────────────────────────────────────────────────────────────
// Duration strings re-render on a shared ticker so they stay current. Efficiency
// comes from tiering: there is ONE interval per period (1s / 1m / 1h), and each
// string subscribes only to the period matching its finest visible unit — so a
// "30s" string ticks every second, a "3h" string hourly, and a >7d absolute
// date never. Ticks are skipped while the tab is hidden; on re-show, all
// subscribers fire once to catch up. (Off-screen rows are unmounted by the list,
// so they unsubscribe automatically.)

const SECOND = 1000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

type Bucket = { timer: ReturnType<typeof setInterval> | null; subs: Set<() => void> };
const tickBuckets = new Map<number, Bucket>();
let visListenerAttached = false;

function ensureVisibilityListener(): void {
  if (visListenerAttached || typeof document === "undefined") return;
  visListenerAttached = true;
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      for (const b of tickBuckets.values()) for (const cb of b.subs) cb();
    }
  });
}

function subscribeTick(period: number, cb: () => void): () => void {
  ensureVisibilityListener();
  let b = tickBuckets.get(period);
  if (!b) {
    b = { timer: null, subs: new Set() };
    tickBuckets.set(period, b);
  }
  const bucket = b;
  bucket.subs.add(cb);
  if (!bucket.timer) {
    bucket.timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      for (const fn of bucket.subs) fn();
    }, period);
  }
  return () => {
    bucket.subs.delete(cb);
    if (bucket.subs.size === 0 && bucket.timer) {
      clearInterval(bucket.timer);
      bucket.timer = null;
      tickBuckets.delete(period);
    }
  };
}

/** How often a timestamp's displayed unit changes: 1s/1m/1h while in the
 *  seconds/minutes/hours tier, hourly through the days tier (cheap, and catches
 *  the 7d→absolute-date flip), null once it's a static absolute date. */
function tierPeriod(ms: number): number | null {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return SECOND;
  if (sec < 3600) return MINUTE;
  if (sec < 7 * 86400) return HOUR;
  return null;
}

/** The refresh period for a span = the finest (smallest) of its visible ends. */
function spanRefreshPeriod(createdMs: number, lastMs?: number | null): number | null {
  const hasSpan = typeof lastMs === "number" && lastMs - createdMs > 60_000;
  const periods = [tierPeriod(createdMs), hasSpan ? tierPeriod(lastMs as number) : null].filter(
    (p): p is number => p != null,
  );
  return periods.length ? Math.min(...periods) : null;
}

/** Live-updating activity span: recomputes `formatActivitySpan` on the shared
 *  ticker at the cadence its current resolution needs. Returns null when there
 *  is no timestamp to show. */
export function useActivitySpan(createdMs?: number, lastMs?: number | null): string | null {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const period = createdMs == null ? null : spanRefreshPeriod(createdMs, lastMs);
  useEffect(() => {
    if (period == null) return;
    return subscribeTick(period, force);
  }, [period, createdMs, lastMs]);
  return createdMs == null ? null : formatActivitySpan(createdMs, lastMs);
}

/** The shared narrative meta line: a status dot followed by a single-`Text`
 *  run of `cost` · `role` · "from" activity-span — one font size, so the parts
 *  share a baseline. The fold moved up to the identity row (NarrativeIdentity),
 *  so this line carries *state*: leading cost, then role, then "from <span>"
 *  recency. Used by the list card, the page header, and the switcher so they
 *  read alike. `dimmed` swaps to a muted palette (ended narratives). */
export function NarrativeMetaLine({
  role,
  cost,
  createdAt,
  lastActivity,
  status,
  mcpConnected,
  dimmed = false,
  style,
}: {
  role?: string | null;
  /** Preformatted cost (e.g. "$6.81", "1,200 AIC") from `formatCost`, woven in
   *  tersely after the role. Omit/null → skipped. */
  cost?: string | null;
  /** When provided, an activity span is appended. Omit (e.g. the page header,
   *  which lacks the timestamps) to render just role·cost. */
  createdAt?: number;
  lastActivity?: number | null;
  status?: string | null;
  mcpConnected?: boolean | null;
  dimmed?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const isEnded = status === "ended" && !mcpConnected;
  const dotColor = isEnded ? "#666" : mcpConnected ? "#66d9a0" : "#5b9bd5";
  const roleColor = dimmed ? "#666" : "#d8d8dd";
  const labelColor = dimmed ? "#555" : "#888";
  const costColor = dimmed ? "#5a6a60" : "#7bb894";
  const span = useActivitySpan(createdAt, lastActivity);
  return (
    <View style={[styles.row, style]}>
      <View style={[styles.dot, { backgroundColor: dotColor }]} />
      <Text style={styles.meta} numberOfLines={1}>
        {cost ? <Text style={{ color: costColor }}>{cost}</Text> : null}
        {role ? <Text style={{ color: roleColor }}>{cost ? " " : ""}/{role}</Text> : null}
        {span != null ? (
          <Text style={{ color: labelColor }}>{(cost || role) ? " " : ""}from {span}</Text>
        ) : null}
      </Text>
    </View>
  );
}

/** The shared narrative identity row: the narrative id, its copy button, and —
 *  when present — the fold it lives in ("in ~/fold"), on one row. This is the
 *  single source of truth for how a narrative announces itself (who + where);
 *  the list card, the page header, and the switcher all render it, so both the
 *  id typography (`styles.nid`) and the fold are wired once and read alike in
 *  all three. `titleStyle` is an *override layered on top of* that shared base —
 *  reach for it only for genuine per-surface deltas (e.g. dimming an ended
 *  narrative), not to re-declare the font. The fold truncates before the id.
 *  Pure props — adds no listeners. */
export function NarrativeIdentity({
  id,
  foldPath,
  titleStyle,
  align = "baseline",
  copyMarginLeft = 6,
  dimmed = false,
  style,
}: {
  id: string;
  /** The fold, rendered as "in <fold>" after the copy button. Omit/null → skipped. */
  foldPath?: string | null;
  titleStyle?: StyleProp<TextStyle>;
  /** Baseline for the cards (id + fold share a baseline); center for the header. */
  align?: "baseline" | "center";
  copyMarginLeft?: number;
  dimmed?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[{ flexDirection: "row", alignItems: align, minWidth: 0 }, style]}>
      <Text style={[styles.nid, titleStyle]} numberOfLines={1}>{id}</Text>
      <CopyButton text={id} size={13} padding={0} marginLeft={copyMarginLeft} />
      {foldPath ? (
        <Text style={styles.fold} numberOfLines={1}>
          <Text style={{ color: dimmed ? "#555" : "#888" }}>in </Text>
          <Text style={{ color: dimmed ? "#4a5a50" : "#5e8a72" }}>{foldPath}</Text>
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 10 },
  // The single source of truth for NID typography across all three surfaces
  // (list card, page header, switcher). It's deliberately larger/heavier than
  // the 13px meta line and fold so the id reads as the card's headline. Because
  // it's the tallest run on a baseline-aligned row, its cap-height would read as
  // floating high next to the smaller copy button / fold / meta text — so nudge
  // it down ~1px to sit visually level (imperceptible under center alignment in
  // the header). Change prominence here and all three surfaces move together.
  nid: {
    color: "#d8d8dd",
    fontSize: 15,
    fontWeight: "600",
    fontFamily: "monospace",
    flexShrink: 1,
    minWidth: 0,
    transform: [{ translateY: 1 }],
  } as any,
  meta: { fontSize: 13, fontFamily: "monospace", flexShrink: 1, minWidth: 0 } as any,
  // The fold on the identity row, right of the 📋 copy button; truncates before
  // the id. 13px monospace — one size across both lines (id, fold, meta) so
  // nothing sits on a different baseline.
  fold: { marginLeft: 8, fontSize: 13, fontFamily: "monospace", flexShrink: 1, minWidth: 0 } as any,
});
