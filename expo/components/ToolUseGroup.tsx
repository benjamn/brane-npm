import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ToolUse } from "@/lib/api";
import { useHorizontalPanGuard } from "@/lib/panGuard";
import { inAppLinkProps, narrativeHref } from "@/lib/routes";

/**
 * A run of tool calls anchored between two chat events, collapsed to one line.
 *
 * Design contract (claude-xlolbv6l:61/:69): completed calls collapse; the
 * expanded rows are full-bleed, one line each, no bubble — visually quieter
 * than any message. One row shape for every agent, with gaps where a vendor
 * can't fill them in: a missing field leaves its slot empty and NEVER changes
 * the layout, so the eye can't learn "short row = agent X". Failures are the
 * only thing that gets color, and a group containing one starts expanded.
 * `unknown` (started, will never resolve — e.g. a PreToolUse-only agent)
 * renders a dash, never a spinner.
 *
 * The loop's own calls are captured too, and this is where they're sorted out
 * (claude-mvpe4t45:3/:6/:7): a self-`narrate` is dropped, since the bubble it
 * produced is already on screen; a foreign `narrate` renders as a link to the
 * `nid:seq` it created, never its text; a `listen` is an ordinary row whose
 * time is excluded from the group total, because the total means execution
 * and a listen is the agent standing still.
 *
 * Two gestures reach a row, and they divide by what they are for
 * (claude-n1izig04:7). **Pan** reads across the run at a shared offset: one
 * scroll container for the whole group, so the columns stay in register at
 * every offset — the property the fixed-slot layout above is paying for.
 * **Tap** goes deep on one row: full input, output, error, decision. Panning
 * each line separately would be a worse version of the second, so the rows
 * scroll as a block or not at all.
 */

/** `mcp__brane__whoami` → `brane:whoami`; ordinary names pass through. */
function displayName(name: string): string {
  const m = name.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  return m ? `${m[1]}:${m[2]}` : name;
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A tool's result, as the object the tool actually returned.
 *
 *  MCP results reach the hook either already parsed or wrapped in the
 *  `{ content: [{ type: "text", text }] }` envelope, depending on the vendor.
 *  Unwrap one layer of envelope if it's there; give up quietly otherwise,
 *  since every caller here treats a missing result as "just less to show". */
function toolResult(row: ToolUse): Record<string, unknown> | null {
  const parsed = asObject(parseJson(row.output));
  if (!parsed) return null;
  if (Array.isArray(parsed.content)) {
    const text = (parsed.content as Array<Record<string, unknown>>).find(
      (part) => typeof part?.text === "string",
    )?.text;
    return asObject(parseJson(typeof text === "string" ? text : null));
  }
  return parsed;
}

/** What a row is, once the loop's own calls are told apart from work.
 *
 *  - `self_narrate` — a narration into this narrative. Dropped: the bubble it
 *    produced is the row's own content, sitting directly above it.
 *  - `foreign_narrate` — a narration into *another* narrative, which leaves no
 *    trace on this side at all (it lands there as an `agent_signal`). The link
 *    is the whole point: the text belongs to the narrative that received it,
 *    and inlining it here would make an outgoing aside look like something
 *    said in this room.
 *  - `listen` — an ordinary row, excluded only from the duration total.
 *  - `work` — everything else. */
type RowKind =
  | { kind: "self_narrate" }
  | { kind: "foreign_narrate"; nid: string; seq?: number }
  | { kind: "listen" }
  | { kind: "work" };

function classify(row: ToolUse): RowKind {
  const name = displayName(row.name);
  if (name === "brane:listen") return { kind: "listen" };
  if (name !== "brane:narrate") return { kind: "work" };
  const nid = asObject(parseJson(row.input))?.nid;
  if (typeof nid !== "string" || nid === row.narrative_id) return { kind: "self_narrate" };
  // The seq is only in the result, and the result may be missing (a failed
  // call, a vendor that reports no output). A bare nid still navigates.
  const seq = toolResult(row)?.seq;
  return { kind: "foreign_narrate", nid, seq: typeof seq === "number" ? seq : undefined };
}

/** How far a collapsed arg line may run before it is cut.
 *
 *  Panning is for reading across the run, not for crawling to the end of a 4KB
 *  JSON blob — that is what tap-to-expand is for. Cutting the *string* rather
 *  than clamping a pixel width keeps the group's scroll extent bounded and
 *  predictable without measuring anything. */
const ARG_LINE_CHARS = 240;

/** Ceiling on any one detail section. The daemon truncates only what it pushes
 *  over the WebSocket (16KB); a row fetched by GET carries the full value,
 *  which can run to megabytes. Render a readable slice and say what was left. */
const DETAIL_CHARS = 8_000;

/** One-line human summary of a tool's input, per-tool where the shape is
 *  known, first string value otherwise. Purely cosmetic — the full input is
 *  one tap away in the row's detail. */
function argSummary(row: ToolUse): string {
  if (!row.input) return "";
  let input: unknown;
  try {
    input = JSON.parse(row.input);
  } catch {
    return row.input;
  }
  if (typeof input !== "object" || input === null) return String(input);
  const obj = input as Record<string, unknown>;
  const preferred =
    obj.command ?? obj.file_path ?? obj.pattern ?? obj.url ?? obj.query ?? obj.path;
  if (typeof preferred === "string") return preferred;
  const firstString = Object.values(obj).find((v) => typeof v === "string");
  if (typeof firstString === "string") return firstString;
  return row.input;
}

/** The arg line as drawn: newlines flattened, since a row is one line and a
 *  heredoc would otherwise blow its height open, then cut to a bounded width. */
function argLine(row: ToolUse): string {
  const text = argSummary(row).replace(/\s*\n\s*/g, " ⏎ ");
  return text.length > ARG_LINE_CHARS ? `${text.slice(0, ARG_LINE_CHARS)}…` : text;
}

/** JSON re-indented for reading, or the raw text when it is not JSON — a
 *  tool's `input` is JSON, but a hook's `error` is prose. */
function pretty(text: string | null): string | null {
  if (!text) return null;
  const parsed = parseJson(text);
  return parsed === null ? text : JSON.stringify(parsed, null, 2);
}

function clip(text: string): { body: string; note: string | null } {
  if (text.length <= DETAIL_CHARS) return { body: text, note: null };
  return {
    body: text.slice(0, DETAIL_CHARS),
    note: `+${(text.length - DETAIL_CHARS).toLocaleString()} more characters`,
  };
}

interface DetailSection {
  label: string;
  body: string;
  note: string | null;
  failed?: boolean;
}

/** Whether a stored payload is bookkeeping rather than the call's own content:
 *  the `{}` left where a narration's text sat before the log took custody of
 *  it. An empty box is worse than no box. */
function isBookkeeping(pretty: string): boolean {
  const value = asObject(parseJson(pretty));
  return !!value && Object.keys(value).length === 0;
}

/** Everything the row knows, in reading order. An absent field is simply a
 *  missing section — the same "a gap is a gap" rule the compact row follows,
 *  since a vendor that reports no output should not render an empty box.
 *
 *  A truncation flag and a clip are different facts and both get said: the
 *  flag means the *push* was an excerpt and the daemon still holds the rest,
 *  the clip means this view stopped drawing. */
function detailSections(row: ToolUse): DetailSection[] {
  const out: DetailSection[] = [];
  // What the daemon keeps for the loop's own calls is provenance, not reading
  // matter: a listen's watched-narrative list, and `{}` where a narration's
  // text used to sit before the log took custody of it. Neither is worth a
  // section (claude-n1izig04:47).
  const loopCall = displayName(row.name).startsWith("brane:");
  const push = (label: string, text: string | null, opts?: { failed?: boolean; note?: string }) => {
    if (!text) return;
    if (loopCall && (label === "input" || label === "output") && isBookkeeping(text)) return;
    const { body, note } = clip(text);
    out.push({
      label,
      body,
      note: [opts?.note, note].filter(Boolean).join(" · ") || null,
      failed: opts?.failed,
    });
  };
  push("input", pretty(row.input), {
    note: row.input_truncated ? "excerpt — the daemon holds the full value" : undefined,
  });
  push("output", pretty(row.output), {
    note: row.output_truncated ? "excerpt — the daemon holds the full value" : undefined,
  });
  push("error", row.error, { failed: true });
  if (row.decided_by || row.decision_note) {
    push("decision", [row.decided_by, row.decision_note].filter(Boolean).join(" — "));
  }
  return out;
}

/** The provenance line under a row's detail. `source` earns its place: a
 *  `hook` row was watched live, a `session_log` row was reconstructed after
 *  the fact, and which one you are reading changes how much it proves. */
function provenance(row: ToolUse): string {
  return [row.status, row.source, row.agent_type].filter(Boolean).join(" · ");
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function isFailure(row: ToolUse): boolean {
  return row.status === "failed" || row.status === "denied";
}

function statusGlyph(row: ToolUse): { glyph: string; failed: boolean } | null {
  if (isFailure(row)) return { glyph: "✗", failed: true };
  if (row.status === "unknown") return { glyph: "–", failed: false };
  if (row.status === "pending" || row.status === "allowed") return { glyph: "…", failed: false };
  return null;
}

/** The group's rows, scrollable sideways as one block.
 *
 *  On web that is a plain overflow container plus the pan guard, which keeps a
 *  horizontal drag from reaching the chat pane's tab-swipe handler while
 *  letting vertical drags bubble, so the chat list still scrolls under a touch
 *  that happened to start on a tool row. */
function PanArea({ children }: { children: React.ReactNode }) {
  const panGuard = useHorizontalPanGuard();
  if (Platform.OS !== "web") {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>{children}</View>
      </ScrollView>
    );
  }
  return (
    <div style={{ overflowX: "auto", overflowY: "hidden" }} {...panGuard}>
      {/* Every row stretches to the *widest* row rather than to its own
          content. That is what keeps the trailing status column at one x for
          the whole group at every scroll offset — sticky pins an element
          within its containing block, so ragged row widths would strand each
          ✗ at its own row's edge the moment you panned. `min-width: 100%`
          resolves against the scrollport, so a group of short rows still
          fills the width it was given. */}
      <div style={{ display: "flex", flexDirection: "column", width: "max-content", minWidth: "100%" }}>
        {children}
      </div>
    </div>
  );
}

/** Fetches one row whole, by `dedup_key`. Supplied by the screen that knows the
 *  connection; absent in contexts (like a static export) that have none, where
 *  the excerpt is simply all there is. */
export type FetchFull = (dedupKey: string) => Promise<ToolUse>;

export default function ToolUseGroup({
  rows,
  onNarrativePress,
  onFetchFull,
}: {
  rows: ToolUse[];
  onNarrativePress?: (nid: string, seq?: number) => void;
  onFetchFull?: FetchFull;
}) {
  // Classify once. Everything downstream — what renders, what the counts say,
  // what the total means — reads from this, so a row can't be one kind in the
  // summary and another in the list.
  const visible = useMemo(
    () =>
      rows
        .map((row) => ({ row, kind: classify(row) }))
        .filter(({ kind }) => kind.kind !== "self_narrate"),
    [rows],
  );

  const hasFailure = visible.some(({ row }) => isFailure(row));
  const [expanded, setExpanded] = useState(hasFailure);
  // `useState` reads its initializer once, so a failure that arrives *after*
  // first render left the group collapsed and grey — reachable today, since
  // coalescing flushes at max_batch and a burst sharing one anchor arrives in
  // several frames (claude-8fkbabsx:9, finding 2). Follow hasFailure, but only
  // until the operator has an opinion: once they've toggled, a late row must
  // not reopen a group they deliberately closed.
  const userToggledRef = useRef(false);
  useEffect(() => {
    if (hasFailure && !userToggledRef.current) setExpanded(true);
  }, [hasFailure]);

  // Which rows are showing full detail, keyed by `dedup_key` — the identity
  // the list already keys on, so a row that re-renders with a new status
  // (pending → completed) stays open under the operator's finger.
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(EMPTY_ROWS);
  const toggleRow = useCallback((key: string) => {
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  // Detail blocks sit *inside* the horizontal scroller so each one stays under
  // its own row, but they must not contribute to its width — a pretty-printed
  // 8KB payload would make the whole group scroll for a mile. They pin to the
  // scrollport's left edge and wrap at the group's own width, which only a
  // measurement can supply.
  const [paneWidth, setPaneWidth] = useState(0);

  const summary = useMemo(() => {
    const counts = new Map<string, number>();
    let totalMs = 0;
    for (const { row, kind } of visible) {
      const name = displayName(row.name);
      counts.set(name, (counts.get(name) ?? 0) + 1);
      // A listen counts as a call but contributes no time: the total measures
      // execution, and a listen is the agent standing still — one 108s hold
      // would otherwise dwarf every real tool in the group and read as work
      // (claude-mvpe4t45:6). Its own row still shows how long it held.
      if (kind.kind !== "listen") totalMs += row.duration_ms ?? 0;
    }
    const names = [...counts.entries()]
      .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
      .join(", ");
    // Format per claude-vhkt2ogz:28: `11 tools (556ms): Bash ×7, Read ×4`
    const count = visible.length === 1 ? "1 tool" : `${visible.length} tools`;
    const dur = totalMs > 0 ? ` (${fmtDuration(totalMs)})` : "";
    return `${count}${dur}: ${names}`;
  }, [visible]);

  // A group of nothing but self-narrations has nothing to say.
  if (visible.length === 0) return null;

  return (
    // `data-chrome` opts this group out of the chat's tap-in-negative-space
    // deselect: expanding a tool row is interacting with the list, not
    // dismissing what you had selected.
    <View style={styles.container} dataSet={{ chrome: "tools" }} onLayout={(e) => setPaneWidth(e.nativeEvent.layout.width)}>
      <Pressable
        role="button"
        aria-expanded={expanded}
        onPress={() => {
          userToggledRef.current = true;
          setExpanded((wasOpen) => {
            // Collapsing the group collapses the rows inside it, so the
            // summary line is a single way back to quiet — reopening shows the
            // one-line rows again rather than whatever was left standing open
            // (claude-n1izig04:27).
            if (wasOpen) setOpenRows(EMPTY_ROWS);
            return !wasOpen;
          });
        }}
        style={styles.summaryRow}
      >
        <Text style={styles.gear}>⚙</Text>
        <Text style={[styles.summaryText, hasFailure && styles.failText]} numberOfLines={1}>
          {summary}
        </Text>
      </Pressable>
      {expanded && (
        <PanArea>
          {visible.map(({ row, kind }) => {
            const status = statusGlyph(row);
            const open = openRows.has(row.dedup_key);
            return (
              <Fragment key={row.dedup_key}>
                <Pressable
                  style={styles.row}
                  onPress={() => toggleRow(row.dedup_key)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: open }}
                >
                  {/* The gear stays a gear when the row is open. The detail
                      block below it is disclosure enough, and swapping the
                      glyph made the row twitch under the finger that opened it
                      (claude-n1izig04:27). */}
                  <Text style={styles.gear}>⚙</Text>
                  <Text style={[styles.name, status?.failed && styles.failText]} numberOfLines={1}>
                    {displayName(row.name)}
                  </Text>
                  {/* A foreign narrate spends its argument slot on the reference it
                      created — the destination is the only part of an outgoing
                      message this narrative should carry. */}
                  {kind.kind === "foreign_narrate" ? (
                    <Text style={[styles.args, nowrap]} numberOfLines={web ? undefined : 1}>
                      <Text
                        style={styles.link}
                        {...rowLinkProps(narrativeHref(kind.nid, kind.seq), () =>
                          onNarrativePress?.(kind.nid, kind.seq),
                        )}
                      >
                        →&nbsp;{kind.seq ? `${kind.nid}:${kind.seq}` : kind.nid}
                      </Text>
                    </Text>
                  ) : (
                    <Text style={[styles.args, nowrap]} numberOfLines={web ? undefined : 1}>
                      {argLine(row)}
                    </Text>
                  )}
                  {/* Takes up the slack when a row is stretched past its own
                      content, so the trailing cell lands at the right edge
                      without the arg text being asked to stretch. */}
                  <View style={styles.slack} />
                  {/* Duration and status ride the scrollport's right edge rather
                      than the row's, so the ✗ column stays scannable however far
                      the args have been panned. Opaque, because the arg line
                      passes underneath them rather than around. */}
                  <View style={[styles.trailing, stickyRight]}>
                    <Text style={styles.duration}>{fmtDuration(row.duration_ms)}</Text>
                    {/* Fixed-width status slot: empty for completed, never collapsed,
                        so outcome-less agents render the same silhouette. */}
                    <Text style={[styles.status, status?.failed && styles.failText]}>
                      {status?.glyph ?? " "}
                    </Text>
                  </View>
                </Pressable>
                {open && (
                  <Pressable
                    tabIndex={-1}
                    style={[
                      styles.detail,
                      stickyLeft,
                      // Pinned to the scrollport's left edge and sized to it,
                      // so opening a row adds height to the group but never
                      // width: the detail wraps where the chat wraps, however
                      // far the rows above it can be panned.
                      paneWidth > 0 ? { width: paneWidth - CONTAINER_PAD * 2 } : null,
                    ]}
                    // The body closes what it opened: a tap anywhere in it
                    // shuts the row, so a long payload doesn't send you back up
                    // to the line that opened it. A tap that ends a text
                    // selection isn't one — reading a value out of the detail
                    // is the other reason to be in here.
                    onPress={() => {
                      if (!hasTextSelection()) toggleRow(row.dedup_key);
                    }}
                  >
                    <RowDetail row={row} onFetchFull={onFetchFull} />
                  </Pressable>
                )}
              </Fragment>
            );
          })}
        </PanArea>
      )}
      {expanded &&
        visible.map(({ row }) => row).filter(isFailure).map((row) =>
          row.error ? (
            <Text key={`${row.dedup_key}-err`} style={[styles.errorLine, styles.failText]} numberOfLines={2}>
              {row.error}
            </Text>
          ) : null,
        )}
    </View>
  );
}

/** One row's full detail. Selectable, because the reason to open a row is
 *  usually to take something out of it.
 *
 *  The row arrived excerpted — lists carry 1KB of each field, which is all a
 *  collapsed line draws. Opening it is the moment the rest is worth paying for,
 *  so a row flagged truncated fetches itself whole and re-renders in place. The
 *  excerpt shows meanwhile: something readable immediately beats a spinner over
 *  content that is already partly here (claude-n1izig04:73). */
function RowDetail({ row, onFetchFull }: { row: ToolUse; onFetchFull?: FetchFull }) {
  const [full, setFull] = useState<ToolUse | null>(null);
  const [failed, setFailed] = useState(false);
  const clipped = !!(row.input_truncated || row.output_truncated);

  useEffect(() => {
    if (!clipped || !onFetchFull || full) return;
    let live = true;
    onFetchFull(row.dedup_key)
      .then((fetched) => {
        if (live) setFull(fetched);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [clipped, onFetchFull, full, row.dedup_key]);

  const shown = full ?? row;
  const sections = useMemo(() => detailSections(shown), [shown]);
  const pending = clipped && !full && !failed;
  return (
    <>
      {pending && <Text style={styles.detailNote}>excerpt — fetching the rest…</Text>}
      {failed && (
        <Text style={[styles.detailNote, styles.failText]}>
          excerpt — the full value could not be fetched
        </Text>
      )}
      {sections.length === 0 ? (
        <Text style={styles.detailNote}>nothing recorded beyond the row itself</Text>
      ) : (
        sections.map((section) => (
          <View key={section.label} style={styles.detailSection}>
            <Text style={styles.detailLabel}>{section.label}</Text>
            <Text style={[styles.detailBody, section.failed && styles.failText]} selectable>
              {section.body}
            </Text>
            {section.note && <Text style={styles.detailNote}>{section.note}</Text>}
          </View>
        ))
      )}
      <Text style={styles.detailNote}>{provenance(shown)}</Text>
    </>
  );
}

/** One shared empty set, so "nothing is open" is the same value every time and
 *  collapsing a group that was already quiet doesn't re-render it. */
const EMPTY_ROWS: ReadonlySet<string> = new Set<string>();

/** Whether the gesture that just ended was a drag through text rather than a
 *  tap. Brane is web-only, so the DOM Selection API is the right (and only)
 *  signal — the same one the pane's tab-swipe consults ([nid].tsx). */
function hasTextSelection(): boolean {
  return typeof window !== "undefined" && !!window.getSelection()?.toString();
}

/** A link inside a pressable row. The row's tap opens the detail, the link's
 *  tap navigates, and one gesture must not do both — on web that means
 *  stopping the click before it reaches the row, since RNW's `onClick` and the
 *  Pressable's handler are both real DOM listeners on one propagation path.
 *  Native needs nothing: the responder system already gives a touch to the
 *  innermost handler. */
function rowLinkProps(href: string, activate: () => void): Record<string, unknown> {
  const props = inAppLinkProps(href, activate);
  if (Platform.OS !== "web") return props;
  const onClick = props.onClick as ((e: any) => void) | undefined;
  return {
    ...props,
    onClick: (e: any) => {
      e.stopPropagation?.();
      onClick?.(e);
    },
  };
}

// Web-only layout that React Native's style types don't model. The group is
// one horizontal scroller and two cells escape it — the trailing status pinned
// right, the detail block pinned left.
//
// `nowrap` is what lets an arg line run past the scrollport at all. RNW turns
// `numberOfLines={1}` into `overflow: hidden` + an ellipsis, which clips the
// line to the row instead of extending it, so on web the row asks for nowrap
// and relies on ARG_LINE_CHARS for its bound.
const web = Platform.OS === "web";
const nowrap = web ? ({ whiteSpace: "nowrap", textOverflow: "clip" } as any) : null;
const stickyRight = web ? ({ position: "sticky", right: 0 } as any) : null;
const stickyLeft = web ? ({ position: "sticky", left: 0 } as any) : null;

// The chat pane's background ([nid].tsx paneStyles), repeated because the
// sticky trailing cell has to be opaque against it.
const PANE_BG = "#111";

// The group's own horizontal padding, subtracted when sizing a detail block:
// what `onLayout` measures is the container, and what a detail block has to
// match is the scrollport inside it.
const CONTAINER_PAD = 12;

const styles = StyleSheet.create({
  // Vertical padding tuned for VISUAL symmetry (claude-vhkt2ogz:29/:36), not
  // numeric symmetry: the bubble above contributes its own marginBottom (6)
  // while the label below contributes nothing, so equal paddings render
  // top-heavy. 4/10 makes the rendered gaps match.
  container: {
    paddingHorizontal: CONTAINER_PAD,
    paddingTop: 4,
    paddingBottom: 10,
  },
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 2,
    paddingLeft: 18,
  },
  gear: {
    color: "#666",
    fontSize: 11,
    width: 18,
    textAlign: "center",
  },
  summaryText: {
    color: "#8a8a8e",
    fontSize: 12,
    flexShrink: 1,
  },
  name: {
    color: "#9a9aa0",
    fontSize: 12,
    fontFamily: "monospace",
    minWidth: 64,
    paddingRight: 8,
  },
  // Sized to its text, not to the row: the arg line is what makes a row wide
  // enough to be worth panning, so it must contribute its natural width rather
  // than absorb whatever is left over.
  args: {
    color: "#666",
    fontSize: 12,
    fontFamily: "monospace",
  },
  slack: {
    flex: 1,
    minWidth: 8,
  },
  // Same blue as prose references (Markdown's `link`), so a narrate target
  // reads as the same kind of thing wherever it appears.
  link: {
    color: "#6cb6ff",
    textDecorationLine: "underline",
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: PANE_BG,
    paddingLeft: 10,
  },
  duration: {
    color: "#666",
    fontSize: 11,
    paddingLeft: 8,
    textAlign: "right",
  },
  status: {
    fontSize: 11,
    width: 14,
    textAlign: "center",
    color: "#666",
  },
  detail: {
    alignSelf: "flex-start",
    backgroundColor: "#17171b",
    borderLeftWidth: 2,
    borderLeftColor: "#333",
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 4,
  },
  detailSection: {
    paddingBottom: 6,
  },
  detailLabel: {
    color: "#8a8a8e",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingBottom: 2,
  },
  detailBody: {
    color: "#c8c8cc",
    fontSize: 11,
    fontFamily: "monospace",
    lineHeight: 15,
  },
  detailNote: {
    color: "#666",
    fontSize: 10,
    fontStyle: "italic",
  },
  errorLine: {
    fontSize: 11,
    fontFamily: "monospace",
    paddingLeft: 36,
    paddingVertical: 1,
  },
  failText: {
    color: "#e57373",
  },
});
