import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  Modal,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TextInput,
} from "react-native";
import { useRouter, Stack } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { Platform } from "react-native";
import { useBrane } from "./_layout";
import ContextMenu, { type ContextMenuItem } from "@/components/ContextMenu";
import { narrativeMenuItems, openNarrativeExport, revivesAsTwin } from "@/components/NarrativeMenu";
import { bumpRecolorSalt } from "@/lib/recolor";
import { glowHueFor, recolorGlowHue } from "@/lib/glow-hues";
import { menuHueRgb, type MenuHue } from "@/components/MenuPanel";
import { NarrativeMetaLine, NarrativeIdentity, SUMMARY_LINE_HEIGHT, SUMMARY_MARGIN_TOP } from "@/components/NarrativeMeta";
import {
  fetchNarratives,
  fetchFolds,
  fetchBranes,
  archiveBrane,
  fetchSpawnHistory,
  spawnAgent,
  archiveNarrative,
  reviveNarrative,
  searchNarratives,
  searchWiki,
  formatCost,
  type NarrativeInfo,
  type FoldInfo,
  type BraneInfo,
  type SearchHit,
  type SpawnHistoryEntry,
  type WikiSearchArticle,
  type ConnectionParams,
} from "@/lib/api";
import WikiReader, { type WikiTarget } from "@/components/WikiReader";
import { MarkdownLinksProvider } from "@/components/MarkdownLinks";
import type { DaemonEntry } from "@/lib/registry";
import { RECYCLE_STEP, RecycleGlyph, useDetentSpin } from "@/components/RecycleSpinner";
import SpawnDialog from "@/components/SpawnDialog";
import MembraneEmpty from "@/components/MembraneEmpty";
import QrModal from "@/components/QrModal";
import NowPlayingDial from "@/components/NowPlayingDial";
import type { JukeboxTrack } from "@shared/now-playing";
import { fileHref } from "@/lib/routes";
import DevicesLayer from "@/components/DevicesLayer";
import { buildIsolateUrl, isIsolated, terminalOnlyHref } from "@shared/view-url";
import { useAppHost } from "@/lib/appHost";
import { sortNarratives } from "@shared/narrative-sort";
import { isAwaiting, awaitingGlow, AWAITING_STATUS, NOT_AWAITING_STATUS } from "@shared/narrative-status";
import { isListScrollKey, listScrollTarget } from "@shared/list-scroll-keys";
import { buildHitSnippet, type MatchRange, type SnippetOptions } from "@shared/hit-snippet";
import { interruptSession } from "@/lib/terminal";

// How long a keyed smooth scroll counts as still under way, for stacking the
// next key onto its target. Chromium's keyboard smooth scroll settles in
// about 300 ms.
const KEYED_SCROLL_SETTLE_MS = 400;

// Each cell gets a descending zIndex so an earlier card always stacks above the
// cards below it. Without this, a card's context menu (which extends past the
// card's own bounds) is painted over by the next FlatList cell — this keeps the
// menu on the card without a portal.
//
// Declared at module scope on purpose. Inline, it is a *new component type* on
// every render of the list screen, so React unmounts and remounts every cell —
// and an open menu, whose state lives in the cell, disappears. The list
// re-renders on every live update, which made menus close by themselves.
function NarrativeCell({ index, style, ...cellProps }: { index: number; style?: any; [k: string]: any }) {
  return <View {...cellProps} style={[style, { zIndex: 100000 - index, position: "relative" }]} />;
}

// How wide the fade over a card's overflowing summary is.
const SUMMARY_FADE_PX = 40;

// The card's summary sits 6px under its meta line, not the header's and
// switcher's SUMMARY_MARGIN_TOP: the card's identity row also holds the
// status <button> (12px text, 4px of padding above and below), which makes
// that row 22–23px tall around 17px id glyphs, so the id→meta *text* gap on
// a card is 5.5px (Chromium) / 6px (WebKit) rather than 3. Measured in both
// engines on a copy of the card DOM: 6 here puts the summary's text the same
// distance under the meta's as the meta's is under the id's.
const CARD_SUMMARY_MARGIN_TOP = SUMMARY_MARGIN_TOP + 3;

function NarrativeCard({
  item,
  conn,
  onPress,
  onArchive,
  onMeld,
  onTwin,
  onUtility,
  onOpenTrack,
  onRevive,
  onEnd,
  menuVisible,
  setMenuVisible,
  hits,
  onHitPress,
  isolated,
  appHost,
}: {
  item: NarrativeInfo;
  conn: ConnectionParams | null;
  onPress: () => void;
  onArchive: () => void;
  /** Meld, Twin, Utility, Revive and End all end somewhere the screen has to
   *  take you (a modal, or the narrative's terminal), so they live up there;
   *  Isolate and Export stay here because they end where they started. */
  onMeld: () => void;
  onTwin: () => void;
  onUtility: () => void;
  /** A long-press on the card's dial: the track's file, in its narrative. */
  onOpenTrack: (track: JukeboxTrack) => void;
  onRevive: () => void;
  onEnd: () => void;
  /** Whether this card's status menu is open. Owned by the screen, not the
   *  card: a list that reorders itself on live updates will move a row out
   *  from under an open menu, and row-local state doesn't survive that. It
   *  also means only one menu is open at a time, which is what you'd want
   *  anyway. */
  menuVisible: boolean;
  setMenuVisible: (open: boolean) => void;
  hits?: SearchHit[];
  onHitPress?: (nid: string, seq: number) => void;
  /** Whether this page is the daemon's own bundle, and if so where Isolate
   *  hops out to. Decided once by the screen, not per card: a row renders
   *  hundreds of times and must not each probe the daemon. */
  isolated: boolean;
  appHost: string | null;
}) {

  // The three words name what the narrative is *doing*, not what a column
  // says. "LIVE" rather than CONNECTED: the badge tracks `mcp_connected`,
  // which is the agent sitting in its LIVE loop, not merely that a socket
  // exists. "IDLE" rather than ACTIVE: the session is up but nobody is reaching
  // for MCP tools on it — which is exactly what ACTIVE failed to distinguish
  // from LIVE. That reading is deliberate rather than incidental, so a utility
  // session (lazygit, htop — no bridge to connect) reads IDLE while its TUI
  // runs, and correctly so. "DEAD" rather than ENDED, because dead is already
  // brane's own word for this: the revive API restarts a *dead* session, and
  // the 🐦‍🔥 in the menu right here is a phoenix. It also makes the ladder read
  // as one — LIVE and DEAD are opposites with IDLE between them, where ENDED
  // was a claim about the work rather than the session. Four letters apiece,
  // so the column is one shape. The `status` column itself is untouched
  // throughout; this is vocabulary.
  const statusText =
    item.status === "ended"
      ? "dead"
      : item.mcp_connected
        ? "live"
        : "idle";
  const statusColor =
    item.status === "ended"
      ? "#666"
      : item.mcp_connected
        ? "#66d9a0"
        : "#5b9bd5";
  // Waiting on the operator lights the whole card from the inside, in the hue
  // this device allocated the narrative (src/shared/glow-hues.ts). It is read
  // on every render rather than held, so a Recolor made inside the narrative
  // is worn here on return; the card's own Recolor bumps `recolors` to repaint.
  const [, setRecolors] = useState(0);
  const glow = isAwaiting({ mcpConnected: item.mcp_connected, awaiting: item.awaiting })
    ? awaitingGlow(glowHueFor(item.id))
    : undefined;
  // The badge is a menu trigger, so it lights up while its menu is open the way
  // every other trigger here does (the 🦠's `reloadTextActive`, the BRANE
  // wordmark) — but in its *own* status color rather than the menu's green: a
  // neon sign takes the color of its own tube. The panel takes that same hue,
  // so the word and the menu hanging off it are one sign rather than two.
  // Deriving both from `menuHueRgb` is what makes that true and keeps it true
  // — a second hand-written palette here would drift from the panel's within a
  // change or two. Radii are scaled to the 12px label; the 🦠's suit 20px.
  const menuHue: MenuHue =
    item.status === "ended" ? "grey" : item.mcp_connected ? "green" : "blue";
  const glowRgb = menuHueRgb(menuHue);
  const statusGlow = [
    `0 0 8px rgba(${glowRgb}, 0.9)`,
    `0 0 18px rgba(${glowRgb}, 0.7)`,
    `0 0 36px rgba(${glowRgb}, 0.4)`,
    `0 1px 12px rgba(${glowRgb}, 0.6)`,
  ].join(", ");

  return (
    <div
      style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#555", borderBottomStyle: "solid", backgroundColor: "#121214", cursor: "pointer", boxShadow: glow, transition: "box-shadow 400ms ease" }}
      role="link"
      tabIndex={0}
      onClick={() => onPress()}
      onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) onPress(); }}
    >
      <div style={{ padding: 16 }}>
        <div style={{ display: "flex", flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <NarrativeIdentity
            id={item.id}
            foldPath={item.fold_path}
            style={{ flex: 1, minWidth: 0 }}
          />
          <div style={{ position: "relative" }}>
            {/* The status badge is the list's 🦠 button: tapping it opens the
                same menu the narrative's own header offers, for every status
                rather than only for ended ones. */}
            <button
              onClick={(e) => { e.stopPropagation(); setMenuVisible(!menuVisible); }}
              style={{
                background: "none",
                border: "none",
                color: statusColor,
                fontSize: 12,
                textTransform: "uppercase",
                cursor: "pointer",
                padding: "4px 8px",
                // Pull the word out to the header 🔬's right edge (~15px in):
                // the padding stays for the tap target, the margin cancels it.
                marginRight: -9,
                borderRadius: 4,
                transition: "text-shadow 160ms ease",
                textShadow: menuVisible ? statusGlow : undefined,
              }}
            >
              {statusText}
            </button>
            {/* The jukebox's dial for this narrative's track, while it holds
                one, hung under the status word and out of the flow: the card
                is where you find what's playing from anywhere, and it grows
                by nothing. Tap plays or pauses, a drag scrubs, a long-press
                opens the file; stop is on the Files card. Above the rows
                beneath it, under the menu. */}
            <NowPlayingDial
              nid={item.id}
              size={22}
              onOpen={onOpenTrack}
              style={{ position: "absolute", right: -1, top: "100%", marginTop: 5, zIndex: 1 }}
            />
            {menuVisible && (
              <ContextMenu
                hue={menuHue}
                items={narrativeMenuItems({
                  role: item.role,
                  status: item.status,
                  mcpConnected: item.mcp_connected,
                  archived: !!item.archived,
                  isIsolated: isolated,
                  canIsolate: !isolated || !!appHost,
                  onMeld: () => { setMenuVisible(false); onMeld(); },
                  onIsolate: () => {
                    setMenuVisible(false);
                    if (!conn || typeof window === "undefined") return;
                    // No view to carry from a list row — the link travels as
                    // the bare narrative and opens on its default tab.
                    const url = buildIsolateUrl({
                      host: window.location.host,
                      protocol: window.location.protocol,
                      search: window.location.search,
                      path: `/${item.id}`,
                      conn,
                      appHost,
                      view: {},
                    });
                    if (url) window.open(url, "_blank", "noopener,noreferrer");
                  },
                  onExport: () => {
                    setMenuVisible(false);
                    if (conn) openNarrativeExport(conn, item.id);
                  },
                  // Advances the stored salt the narrative screen reads when
                  // opened, and moves this card's awaiting glow to the widest
                  // gap among the other glows.
                  onRecolor: () => { setMenuVisible(false); bumpRecolorSalt(item.id); recolorGlowHue(item.id); setRecolors((n) => n + 1); },
                  onTwin: () => { setMenuVisible(false); onTwin(); },
                  onUtility: () => { setMenuVisible(false); onUtility(); },
                  onRevive: () => { setMenuVisible(false); onRevive(); },
                  onEnd: () => { setMenuVisible(false); onEnd(); },
                  onArchiveToggle: () => { setMenuVisible(false); onArchive(); },
                })}
                onClose={() => setMenuVisible(false)}
              />
            )}
          </div>
        </div>
        {/* Meta row carries the status dot, role·fold, and the recency
            timestamp tail. Always rendered so the timestamp has a home even
            when role/fold are absent; the role·fold text shrinks/truncates
            while the timestamp stays pinned and visible. */}
        <NarrativeMetaLine
          role={item.role}
          cost={formatCost(item.cost_amount, item.cost_unit)}
          createdAt={item.created_at}
          lastActivity={item.last_activity}
          status={item.status}
          mcpConnected={item.mcp_connected}
          style={{ marginTop: 4 }}
        />
        {item.summary && (
          <div style={{ position: "relative", marginTop: CARD_SUMMARY_MARGIN_TOP }}>
            <div className="no-scrollbar" style={{
              overflowX: "auto",
              overflowY: "hidden",
              scrollbarWidth: "none",
              WebkitOverflowScrolling: "touch",
              // A flex container, so the row is the Text's lineHeight and not
              // a strut from the font this card inherits (see the narrative
              // header's summary scroller in [nid].tsx).
              display: "flex",
              // Fade the overflow by masking the text, not by painting the
              // background over it, so a glow behind the row shows through.
              maskImage: `linear-gradient(to right, #000 calc(100% - ${SUMMARY_FADE_PX}px), transparent)`,
              WebkitMaskImage: `linear-gradient(to right, #000 calc(100% - ${SUMMARY_FADE_PX}px), transparent)`,
            }}>
              {/* The fade is on the scroller's box, not its content, so the
                  text ends in padding as wide as the fade: scrolled to the
                  end, the last character clears it. */}
              <Text style={[styles.summary, { marginTop: 0, whiteSpace: "nowrap", paddingRight: SUMMARY_FADE_PX }]}>{item.summary}</Text>
            </div>
          </div>
        )}
        {hits && hits.length > 0 && (
          <View style={styles.hitsContainer}>
            {hits.slice(0, 3).map((hit, i) => (
              <div
                key={i}
                role="link"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); onHitPress?.(item.id, hit.seq); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onHitPress?.(item.id, hit.seq); } }}
                style={{ cursor: "pointer" }}
              >
                <HitSnippet content={hit.content} matches={hit.matches} lines={2} />
              </div>
            ))}
          </View>
        )}
      </div>
    </div>
  );
}

/** A search hit's text, windowed onto where the query matched and with the
 *  matches painted (see src/shared/hit-snippet.ts). The daemon says what
 *  matched, from the index's own tokenizer; nothing here re-scans the text. */
function HitSnippet({
  content,
  matches,
  lines,
  ...opts
}: { content: string; matches?: readonly MatchRange[]; lines: number } & SnippetOptions) {
  const segments = useMemo(
    () => buildHitSnippet(content, matches, opts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [content, matches, opts.stripHeading, opts.window, opts.lead],
  );
  return (
    // The box carries the padding, not the clamped Text: a line clamp cuts at
    // the padding edge, so vertical padding on the Text would leave the top
    // of the next (hidden) line showing — invisible for plain text, a pink
    // strip when that line holds a painted match.
    <View style={styles.hitSnippetBox}>
      <Text style={styles.hitSnippet} numberOfLines={lines}>
        {segments.map((s, j) =>
          s.match ? (
            <Text key={j} style={styles.hitMatch}>
              {s.text}
            </Text>
          ) : (
            s.text
          ),
        )}
      </Text>
    </View>
  );
}

/** Result ordering for a search section: by semantic relevance (best match
 *  first) or by recency (newest first). */
type SearchOrder = "relevance" | "recent";

/** Wiki search results, grouped by article (page), shown as a section above
 *  the narrative list when searching. Each hit opens the wiki reader at its
 *  section. */
/** A full-width tappable section heading bar with explicit toggle states,
 *  shared by the Wiki and Narratives search sections so they read alike.
 *  When `order`/`onToggleOrder` are supplied, it also renders an emoji order
 *  toggle (🎯 relevance ↔ 🕘 recent) to the right of the leftmost label. */
function SectionBar({
  icon,
  label,
  count,
  collapsed,
  onToggle,
  order,
  onToggleOrder,
}: {
  icon: string;
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  order?: SearchOrder;
  onToggleOrder?: () => void;
}) {
  return (
    // The bar itself is inert; only the Show/Hide chip (right) toggles collapse,
    // so barely missing the 🧲/🕰️ order control can't accidentally hide results.
    <View style={[styles.wikiBar, collapsed && styles.wikiBarCollapsed]}>
      <Text style={styles.wikiBarIcon}>{icon}</Text>
      <Text style={styles.wikiBarLabel} numberOfLines={1}>{label}</Text>
      <Text style={styles.wikiBarCount} numberOfLines={1}>{count}</Text>
      <View style={{ flex: 1 }} />
      {order && onToggleOrder && !collapsed && (
        // Purely textual — the emoji weren't earning their pixels. Sizes to
        // fit its label (HIDE stays pinned right, so only this pill's left
        // edge shifts as the word changes).
        <Pressable
          onPress={onToggleOrder}
          role="button"
          hitSlop={6}
          style={({ pressed }) => [styles.wikiBarPill, pressed && styles.wikiBarPillPressed]}
        >
          <Text style={styles.wikiBarOrderLabel}>
            {order === "recent" ? "Recency" : "Relevance"}
          </Text>
        </Pressable>
      )}
      {/* Same pill style as the order toggle. The verb names the action; the
          chevron was redundant chrome, so it's gone. */}
      <Pressable
        onPress={onToggle}
        role="button"
        aria-expanded={!collapsed}
        hitSlop={6}
        style={({ pressed }) => [styles.wikiBarPill, pressed && styles.wikiBarPillPressed]}
      >
        <Text style={styles.wikiBarToggle}>{collapsed ? "Show" : "Hide"}</Text>
      </Pressable>
    </View>
  );
}

function WikiResultsHeader({
  results,
  collapsed,
  onToggle,
  onOpen,
}: {
  results: WikiSearchArticle[];
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (source: string, slug: string, anchor?: string) => void;
}) {
  if (results.length === 0) return null;
  return (
    <View style={styles.wikiSection}>
      {/* No order toggle: wiki results are always relevance-gated (the
          MIN_WIKI_SCORE floor on the server), so there's no recency mode. */}
      <SectionBar
        icon={"📖"}
        label="Wiki"
        count={results.length}
        collapsed={collapsed}
        onToggle={onToggle}
      />
      {!collapsed && results.map((a) => (
        <View key={`${a.source}\u0000${a.slug}`} style={styles.wikiCard}>
          <Pressable role="button" onPress={() => onOpen(a.source, a.slug, a.hits[0]?.anchor)}>
            <View style={styles.wikiCardHeader}>
              <Text style={styles.wikiSlug} numberOfLines={1}>
                {a.slug.replace(/\.md$/, "")}
              </Text>
              <Text style={styles.wikiSource}>{a.source}</Text>
            </View>
          </Pressable>
          <View style={styles.hitsContainer}>
            {a.hits.slice(0, 3).map((h, i) => (
              <Pressable key={i} role="button" onPress={() => onOpen(a.source, a.slug, h.anchor)}>
                {!!h.anchor && <Text style={styles.wikiHitCitation}>#{h.anchor}</Text>}
                <HitSnippet content={h.content} matches={h.matches} lines={3} stripHeading />
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

type BraneCost = NonNullable<BraneInfo["cost"]>;

/** Add per-unit totals across branes. Units are kept apart: a USD entry and
 *  an AIC entry stay two entries. */
function sumBraneCosts(branes: BraneInfo[]): BraneCost {
  const byUnit = new Map<string, { unit: string; amount: number; metered: number }>();
  for (const b of branes) {
    for (const c of b.cost ?? []) {
      const cur = byUnit.get(c.unit) ?? { unit: c.unit, amount: 0, metered: 0 };
      cur.amount += c.amount;
      cur.metered += c.metered;
      byUnit.set(c.unit, cur);
    }
  }
  return [...byUnit.values()].sort((a, b) => b.metered - a.metered);
}


const NBSP = "\u00a0";

/** The switcher's cost line: "$2441.72 (138) + 100.2 AIC (1)" — each unit's
 *  total with the number of sessions it covers, so the per-session figure
 *  can be read off in the head without the line asserting one. Units are
 *  joined, never added. Atoms are held together with non-breaking spaces so
 *  a wrap falls at a "+". */
function braneCostLine(cost?: BraneCost | null): string | null {
  if (!cost?.length) return null;
  const nb = (t: string | null) => (t ?? "").replace(/(\d) ([A-Za-z])/g, `$1${NBSP}$2`);
  return cost.map((c) => `${nb(formatCost(c.amount, c.unit))}${NBSP}(${c.metered})`).join(" + ");
}

/** A switcher row's ⋯: the same trigger and menu as a fold row's in the
 *  spawn dialog. `id` names the row; one menu is open at a time. */
function RowMenu({
  id,
  openId,
  setOpenId,
  items,
  label,
}: {
  id: string;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  items: ContextMenuItem[];
  label: string;
}) {
  return (
    <div style={{ position: "relative", display: "flex" }}>
      <Pressable
        style={styles.rowMenuButton}
        onPress={() => setOpenId(openId === id ? null : id)}
        role="button"
        accessibilityLabel={label}
      >
        <Text style={styles.rowMenuIcon}>⋯</Text>
      </Pressable>
      {openId === id && <ContextMenu items={items} onClose={() => setOpenId(null)} align="beside" />}
    </div>
  );
}

function BraneSwitcher({
  branes,
  activeBraneId,
  daemons,
  activeDaemon,
  connected,
  onSwitchBrane,
  onSwitchDaemon,
  onAdd,
  onArchiveDaemon,
  onReconnectDaemon,
  onForgetDaemon,
  onArchiveBrane,
  onSignOutOthers,
  conn,
}: {
  branes: BraneInfo[];
  activeBraneId: string | null;
  daemons: DaemonEntry[];
  activeDaemon: DaemonEntry | null;
  connected: boolean;
  onSwitchBrane: (braneId: string | null) => void;
  onSwitchDaemon: (id: string) => void;
  onAdd: (host: string, token: string) => Promise<void>;
  onArchiveDaemon: (id: string) => void;
  onReconnectDaemon: (id: string) => void;
  onForgetDaemon: (id: string, opts: { revoke: boolean }) => Promise<void>;
  onArchiveBrane: (braneId: string, archived: boolean) => Promise<void>;
  onSignOutOthers: () => Promise<void>;
  conn: ConnectionParams | null;
}) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  // "Sign out other devices" — a confirm step, because it reaches every
  // other device the operator owns. Opened from the foot of the Devices
  // layer, and stacked over it.
  const [showSignOut, setShowSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  // The Devices layer: every token on the active daemon, revocable one by one.
  const [showDevices, setShowDevices] = useState(false);
  const [newHost, setNewHost] = useState("");
  const [newToken, setNewToken] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signedOutOthers, setSignedOutOthers] = useState(false);
  // Archiving. Daemons are archived on this device (the registry), branes on
  // the daemon (src/db/branes.ts); both are listed behind "Show N archived".
  // Deleting a daemon is the one step with a confirm, since it signs this
  // device out of it and only a fresh meld undoes that.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState<DaemonEntry | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [forgetError, setForgetError] = useState<string | null>(null);
  const closeDropdown = () => {
    setShowDropdown(false);
    setShowAddForm(false);
    setShowSignOut(false);
    setShowDevices(false);
    setSignOutError(null);
    setSignedOutOthers(false);
    setMenuFor(null);
    setArchiveError(null);
  };
  const cancelForget = () => {
    if (forgetting) return;
    setConfirmForget(null);
    setForgetError(null);
  };
  const handleForget = async () => {
    if (!confirmForget) return;
    setForgetting(true);
    try {
      // After a failed revoke the button reads "Forget anyway": the second
      // press forgets without telling the daemon.
      await onForgetDaemon(confirmForget.id, { revoke: forgetError === null });
      setConfirmForget(null);
      setForgetError(null);
    } catch (err) {
      setForgetError(err instanceof Error ? err.message : String(err));
    } finally {
      setForgetting(false);
    }
  };
  const archiveBrane = (b: BraneInfo, archived: boolean) => {
    setMenuFor(null);
    setArchiveError(null);
    if (archived && b.brane_id === activeBraneId) onSwitchBrane(null);
    onArchiveBrane(b.brane_id, archived).catch((err) =>
      setArchiveError(err instanceof Error ? err.message : String(err)),
    );
  };
  // The add-daemon form and the sign-out confirm are each their own modal
  // *layer* over the switcher, not panels inside its card. That is what
  // makes their dismissal unambiguous: the backdrop is everything outside
  // the layer's card — including the switcher underneath, which is inert
  // while a layer is up — and tapping it, or Cancel, or the back gesture,
  // closes that layer only and leaves the switcher where it was. A panel
  // inside the card could never get this right, because a tap on the card
  // around it (the title, a brane row) still belonged to the switcher.
  const cancelSignOut = () => {
    if (signingOut) return;
    setShowSignOut(false);
    setSignOutError(null);
  };
  const cancelAdd = () => {
    if (adding) return;
    setShowAddForm(false);
    setAddError(null);
  };
  const handleSignOutOthers = async () => {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await onSignOutOthers();
      setSignedOutOthers(true);
      setShowSignOut(false);
    } catch (err) {
      setSignOutError(String(err));
    } finally {
      setSigningOut(false);
    }
  };
  const handleAdd = async () => {
    if (!newHost || !newToken) return;
    setAdding(true);
    setAddError(null);
    try {
      await onAdd(newHost, newToken);
      setShowAddForm(false);
      setShowDropdown(false);
      setNewHost("");
      setNewToken("");
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  };

  const visibleBranes = useMemo(() => branes.filter((b) => !b.archived), [branes]);
  const archivedBranes = useMemo(() => branes.filter((b) => b.archived), [branes]);
  const otherDaemons = daemons.filter((d) => d.id !== activeDaemon?.id && !d.archived);
  const archivedDaemons = daemons.filter((d) => d.archived);
  const archivedCount = archivedBranes.length + archivedDaemons.length;

  // Every brane's totals folded together, still one entry per unit. All
  // branes leaves archived ones out, so its total does too.
  const allBranesCost = useMemo(() => sumBraneCosts(visibleBranes), [visibleBranes]);

  // Chip label: active brane or "All branes"
  const chipLabel = activeBraneId
    ? branes.find((b) => b.brane_id === activeBraneId)?.is_home
      ? `${activeBraneId} (home)`
      : activeBraneId
    : activeDaemon?.id ?? "No daemon";

  return (
    <>
      <Pressable
        style={styles.daemonChip}
        onPress={() => setShowDropdown(true)}
        role="button"
        aria-label={`Switch brane: ${chipLabel}`}
      >
        <View
          style={[
            styles.chipDot,
            { backgroundColor: connected ? "#66d9a0" : "#e07070" },
          ]}
        />
        <Text style={styles.chipText} numberOfLines={1}>
          {chipLabel}
        </Text>
        <Text style={styles.chipChevron}>{"\u25BC"}</Text>
      </Pressable>

      <Modal
        visible={showDropdown}
        transparent
        animationType="fade"
        onRequestClose={closeDropdown}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={closeDropdown}
          tabIndex={-1}
        >
          <Pressable style={styles.modalContent} onPress={() => {}} tabIndex={-1}>
            <Text style={styles.modalTitle}>Branes</Text>

            <ScrollView style={{ flexGrow: 0 }}>
            {archiveError && <Text style={styles.addError}>{archiveError}</Text>}
            {/* "All" option: the active daemon's own row, so its ⋯ is where
                the active daemon is archived. */}
            {activeDaemon && (
            <View
              style={[
                styles.daemonOption,
                styles.switcherRow,
                activeBraneId === null && styles.daemonOptionActive,
                menuFor === "active" && styles.rowMenuOpen,
              ]}
            >
            <Pressable
              style={styles.switcherRowMain}
              role="button"
              onPress={() => {
                onSwitchBrane(null);
                setShowDropdown(false);
              }}
            >
              <View style={styles.daemonOptionRow}>
                <View
                  style={[
                    styles.daemonDot,
                    { backgroundColor: connected ? "#66d9a0" : "#555" },
                  ]}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.daemonName}>All branes</Text>
                  <Text style={styles.daemonHost}>{activeDaemon.id}</Text>
                  {braneCostLine(allBranesCost) && (
                    <Text style={styles.daemonCost}>{braneCostLine(allBranesCost)}</Text>
                  )}
                </View>
              </View>
            </Pressable>
            <RowMenu
              id="active"
              openId={menuFor}
              setOpenId={setMenuFor}
              label={`Actions for ${activeDaemon.id}`}
              items={[{
                label: "Archive this daemon",
                icon: "🗄️",
                onPress: () => { setMenuFor(null); onArchiveDaemon(activeDaemon.id); },
              }]}
            />
            </View>
            )}

            {/* Branes from current daemon. The home brane, and the last one
                showing, have no Archive: the daemon refuses both. */}
            {visibleBranes.map((b) => (
              <View
                key={b.brane_id}
                style={[
                  styles.daemonOption,
                  styles.switcherRow,
                  b.brane_id === activeBraneId && styles.daemonOptionActive,
                  menuFor === `brane:${b.brane_id}` && styles.rowMenuOpen,
                ]}
              >
              <Pressable
                style={styles.switcherRowMain}
                role="button"
                onPress={() => {
                  onSwitchBrane(b.brane_id);
                  setShowDropdown(false);
                }}
              >
                <View style={styles.daemonOptionRow}>
                  <View
                    style={[
                      styles.daemonDot,
                      {
                        backgroundColor:
                          b.active_count > 0 ? "#66d9a0" : "#555",
                      },
                    ]}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.daemonName}>
                      {b.brane_id}{b.is_home ? " (home)" : ""}
                    </Text>
                    <Text style={styles.daemonHost}>
                      {b.active_count} active, {b.narrative_count} total
                      {b.absorbed_count > 0 ? ` (${b.absorbed_count} absorbed)` : ""}
                    </Text>
                    {braneCostLine(b.cost) && (
                      <Text style={styles.daemonCost}>{braneCostLine(b.cost)}</Text>
                    )}
                  </View>
                </View>
              </Pressable>
              {!b.is_home && visibleBranes.length > 1 && (
                <RowMenu
                  id={`brane:${b.brane_id}`}
                  openId={menuFor}
                  setOpenId={setMenuFor}
                  label={`Actions for ${b.brane_id}`}
                  items={[{ label: "Archive", icon: "🗄️", onPress: () => archiveBrane(b, true) }]}
                />
              )}
              </View>
            ))}

            {branes.length === 0 && daemons.length === 0 && (
              <Text style={styles.emptyDaemons}>No daemons configured</Text>
            )}

            {/* Other daemons (not currently active) */}
            {otherDaemons.map((d) => (
              <View
                key={d.id}
                style={[styles.daemonOption, styles.switcherRow, menuFor === `daemon:${d.id}` && styles.rowMenuOpen]}
              >
              <Pressable
                style={styles.switcherRowMain}
                role="button"
                onPress={() => {
                  onSwitchDaemon(d.id);
                  setShowDropdown(false);
                }}
              >
                <View style={styles.daemonOptionRow}>
                  <View style={[styles.daemonDot, { backgroundColor: "#555" }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.daemonName}>{d.id}</Text>
                    <Text style={styles.daemonHost}>{d.host} (switch daemon)</Text>
                  </View>
                </View>
              </Pressable>
              <RowMenu
                id={`daemon:${d.id}`}
                openId={menuFor}
                setOpenId={setMenuFor}
                label={`Actions for ${d.id}`}
                items={[{
                  label: "Archive",
                  icon: "🗄️",
                  onPress: () => { setMenuFor(null); onArchiveDaemon(d.id); },
                }]}
              />
              </View>
            ))}

            {/* Archived: this daemon's hidden branes, then this device's
                archived daemons. Kept, never shown unasked. */}
            {showArchived && archivedBranes.map((b) => (
              <View key={b.brane_id} style={[styles.daemonOption, styles.switcherRow, styles.switcherRowArchived]}>
                <View style={styles.switcherRowMain}>
                  <Text style={styles.daemonName}>{b.brane_id}</Text>
                  <Text style={styles.daemonHost}>
                    archived brane, {b.narrative_count} narrative{b.narrative_count === 1 ? "" : "s"}
                  </Text>
                </View>
                <View style={styles.archivedActions}>
                  <Pressable style={styles.archivedAction} role="button" onPress={() => archiveBrane(b, false)}>
                    <Text style={styles.archivedActionText}>Unarchive</Text>
                  </Pressable>
                </View>
              </View>
            ))}
            {showArchived && archivedDaemons.map((d) => (
              <View key={d.id} style={[styles.daemonOption, styles.switcherRow, styles.switcherRowArchived]}>
                <View style={styles.switcherRowMain}>
                  <Text style={styles.daemonName}>{d.id}</Text>
                  <Text style={styles.daemonHost}>{d.host}{d.revoked ? " (signed out)" : ""}</Text>
                </View>
                <View style={styles.archivedActions}>
                  <Pressable
                    style={styles.archivedAction}
                    role="button"
                    onPress={() => {
                      onReconnectDaemon(d.id);
                      setShowDropdown(false);
                    }}
                  >
                    <Text style={styles.archivedActionText}>Reconnect</Text>
                  </Pressable>
                  <Pressable style={styles.archivedAction} role="button" onPress={() => setConfirmForget(d)}>
                    <Text style={[styles.archivedActionText, styles.archivedActionDanger]}>Delete…</Text>
                  </Pressable>
                </View>
              </View>
            ))}
            {archivedCount > 0 && (
              <Pressable onPress={() => setShowArchived((v) => !v)} role="button" aria-expanded={showArchived} style={styles.archivedToggle}>
                <Text style={styles.archivedToggleText}>
                  {showArchived ? "Hide archived" : `Show ${archivedCount} archived`}
                </Text>
              </Pressable>
            )}
            </ScrollView>

            <Pressable
              style={styles.addDaemonButton}
              role="button"
              onPress={() => setShowAddForm(true)}
            >
              <Text style={styles.addDaemonButtonText}>+ Add Daemon</Text>
            </Pressable>
            {activeDaemon && !activeDaemon.revoked && (
              <Pressable
                style={styles.addDaemonButton}
                role="button"
                onPress={() => setShowDevices(true)}
                disabled={!connected}
              >
                <Text style={[styles.addDaemonButtonText, !connected && { opacity: 0.5 }]}>Devices</Text>
              </Pressable>
            )}

            <Pressable
              style={styles.modalCancel}
              role="button"
              onPress={closeDropdown}
            >
              <Text style={styles.modalCancelText}>Close</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Add-daemon layer. Mounted after the switcher so it stacks above it. */}
      <Modal
        visible={showDropdown && showAddForm}
        transparent
        animationType="fade"
        onRequestClose={cancelAdd}
      >
        <Pressable style={styles.modalOverlay} onPress={cancelAdd} tabIndex={-1}>
          <Pressable style={styles.layerCard} onPress={(e) => e.stopPropagation()} tabIndex={-1}>
            <Text style={styles.layerTitle}>Add a daemon</Text>
            <View style={styles.addForm}>
              <TextInput
                style={styles.addInput}
                placeholder="host:port"
                placeholderTextColor="#666"
                value={newHost}
                onChangeText={setNewHost}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
              />
              <TextInput
                style={styles.addInput}
                placeholder="token"
                placeholderTextColor="#666"
                value={newToken}
                onChangeText={setNewToken}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />
              {addError && (
                <Text style={styles.addError}>{addError}</Text>
              )}
              <View style={styles.layerButtonRow}>
                <Pressable
                  style={[styles.layerCancel, adding && { opacity: 0.5 }]}
                  role="button"
                  onPress={cancelAdd}
                  disabled={adding}
                >
                  <Text style={styles.layerCancelText}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={[styles.addButton, styles.layerConfirm, (adding || !newHost || !newToken) && { opacity: 0.5 }]}
                  onPress={handleAdd}
                  role="button"
                  aria-label="Connect"
                  aria-busy={adding}
                  disabled={adding || !newHost || !newToken}
                >
                  {adding ? (
                    <ActivityIndicator size="small" color="#111" />
                  ) : (
                    <Text style={styles.addButtonText}>Connect</Text>
                  )}
                </Pressable>
              </View>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Devices layer. */}
      <DevicesLayer
        visible={showDropdown && showDevices}
        conn={conn}
        daemonName={activeDaemon?.id ?? "this daemon"}
        onClose={() => setShowDevices(false)}
        onSignOutOthers={() => setShowSignOut(true)}
        signedOutOthers={signedOutOthers}
        connected={connected}
      />

      {/* Sign-out-other-devices layer. */}
      <Modal
        visible={showDropdown && showSignOut}
        transparent
        animationType="fade"
        onRequestClose={cancelSignOut}
      >
        <Pressable style={styles.modalOverlay} onPress={cancelSignOut} tabIndex={-1}>
          <Pressable style={styles.layerCard} onPress={(e) => e.stopPropagation()} tabIndex={-1}>
            <Text style={styles.layerTitle}>Sign out other devices?</Text>
            <Text style={styles.signOutBody}>
              {activeDaemon?.id} will issue a new token. This device keeps
              its access; every other phone and browser paired with it is
              signed out until it scans a fresh Meld QR. Running agents and
              your shell are unaffected.
            </Text>
            {signOutError && (
              <Text style={styles.addError}>{signOutError}</Text>
            )}
            <View style={styles.layerButtonRow}>
              <Pressable
                style={[styles.layerCancel, signingOut && { opacity: 0.5 }]}
                role="button"
                onPress={cancelSignOut}
                disabled={signingOut}
              >
                <Text style={styles.layerCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.signOutButton, styles.layerConfirm, signingOut && { opacity: 0.5 }]}
                onPress={handleSignOutOthers}
                role="button"
                aria-label="Sign out other devices"
                aria-busy={signingOut}
                disabled={signingOut}
              >
                {signingOut ? (
                  <ActivityIndicator size="small" color="#111" />
                ) : (
                  <Text style={styles.addButtonText}>Sign out other devices</Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Delete-a-daemon layer. */}
      <Modal
        visible={showDropdown && confirmForget !== null}
        transparent
        animationType="fade"
        onRequestClose={cancelForget}
      >
        <Pressable style={styles.modalOverlay} onPress={cancelForget} tabIndex={-1}>
          <Pressable style={styles.layerCard} onPress={(e) => e.stopPropagation()} tabIndex={-1}>
            <Text style={styles.layerTitle}>Delete {confirmForget?.id}?</Text>
            <Text style={styles.signOutBody}>
              {forgetError === null
                ? "This browser signs itself out of it, so its token stops working on the daemon, and then forgets it. To use it here again, scan a fresh Meld QR."
                : "It could not be reached to sign this browser out, so its token still works. Forget it anyway? The token can be revoked later from the Devices list on another device."}
            </Text>
            {forgetError && <Text style={styles.addError}>{forgetError}</Text>}
            <View style={styles.layerButtonRow}>
              <Pressable
                style={[styles.layerCancel, forgetting && { opacity: 0.5 }]}
                role="button"
                onPress={cancelForget}
                disabled={forgetting}
              >
                <Text style={styles.layerCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.signOutButton, styles.layerConfirm, forgetting && { opacity: 0.5 }]}
                onPress={handleForget}
                role="button"
                aria-label={forgetError === null ? "Delete" : "Forget anyway"}
                aria-busy={forgetting}
                disabled={forgetting}
              >
                {forgetting ? (
                  <ActivityIndicator size="small" color="#111" />
                ) : (
                  <Text style={styles.addButtonText}>{forgetError === null ? "Delete" : "Forget anyway"}</Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const ENDED_PAGE_SIZE = 30;


// Pull-to-refresh tuning (px of post-resistance travel).
const PULL_RESIST = 0.5; // finger travel → list travel ratio
const PULL_TRIGGER = 64; // pull past this on release to fire a refresh
const PULL_MAX = 96; // visual clamp on how far the list can be dragged
const PULL_REST = 52; // where the list rests while the refresh is in flight

// The ♻️ is 3-fold symmetric, so it only looks "upright" at multiples of 120°.
// A full pull winds it a complete -360° turn (counterclockwise); since the
// trigger threshold sits at 2/3 of full pull that lands on exactly -240°, both
// the commit point and full extension rest upright. Winding tracks the pull
// linearly (no transition lag) so the rotation feels directly coupled to the
// drag. On release we snap to the nearest 120° detent and step back clockwise.
const WIND_FULL = 360;

/** Counterclockwise wind-up angle (negative degrees) for a given pull. */
function windAngle(pull: number): number {
  return -(Math.min(pull, PULL_MAX) / PULL_MAX) * WIND_FULL;
}

/** Nearest upright orientation (multiple of 120°) to a given angle. */
function snapTo120(deg: number): number {
  return Math.round(deg / RECYCLE_STEP) * RECYCLE_STEP;
}

/**
 * Familiar pull-down-to-refresh affordance for the (web) narrative list.
 * RN's RefreshControl is a no-op on react-native-web, so we drive the gesture
 * ourselves: a non-passive touchmove listener takes over the overscroll when
 * the list is already at the top and translates the content down with
 * resistance. The ♻️ winds counterclockwise as you pull (directly tracking the
 * drag) and then steps back clockwise through distinct 120° detents while the
 * refresh is in flight.
 */
function PullToRefresh({
  refreshing,
  onRefresh,
  scrollOffsetRef,
  children,
}: {
  refreshing: boolean;
  onRefresh: () => void;
  scrollOffsetRef: React.MutableRefObject<number>;
  children: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pull, setPull] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [angle, setAngle] = useDetentSpin(refreshing);
  const [glyphTransition, setGlyphTransition] = useState("none");
  const pullRef = useRef(0);
  const startYRef = useRef<number | null>(null);
  const engagedRef = useRef(false);

  const setPullBoth = useCallback((v: number) => {
    pullRef.current = v;
    setPull(v);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const atTop = () => (scrollOffsetRef.current ?? 0) <= 0;

    const onStart = (e: TouchEvent) => {
      if (refreshing || e.touches.length !== 1 || !atTop()) {
        engagedRef.current = false;
        startYRef.current = null;
        return;
      }
      startYRef.current = e.touches[0].clientY;
      engagedRef.current = true;
    };

    const onMove = (e: TouchEvent) => {
      if (!engagedRef.current || startYRef.current === null || refreshing) return;
      const dy = e.touches[0].clientY - startYRef.current;
      // Bail if the user scrolled away from the top or is dragging upward.
      if (dy <= 0 || !atTop()) {
        if (!atTop()) engagedRef.current = false;
        if (pullRef.current !== 0) {
          setPullBoth(0);
          setAngle(0);
        }
        setDragging(false);
        return;
      }
      e.preventDefault(); // take over the browser's overscroll
      const next = Math.min(PULL_MAX, dy * PULL_RESIST); // resistance
      setDragging(true);
      setGlyphTransition("none"); // 1:1 with the finger — no lag
      setPullBoth(next);
      setAngle(windAngle(next)); // wind CCW, directly tracking the drag
    };

    const onEnd = () => {
      if (!engagedRef.current) return;
      engagedRef.current = false;
      startYRef.current = null;
      setDragging(false);
      if (pullRef.current >= PULL_TRIGGER && !refreshing) {
        // Snap to an upright detent so the clockwise spin reads cleanly.
        setAngle(snapTo120(windAngle(pullRef.current)));
        setPullBoth(PULL_REST);
        onRefresh();
      } else {
        // Aborted pull: unwind clockwise back to rest.
        setGlyphTransition("transform 0.4s ease");
        setAngle(0);
        setPullBoth(0);
      }
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [refreshing, onRefresh, scrollOffsetRef, setPullBoth]);

  // `useDetentSpin` steps the ♻️ clockwise one 120° detent at a time while
  // refreshing. Here we just set the transition that makes each step visible
  // (despite the glyph's symmetry) and, when the refresh finishes, retract the
  // list and reset to rest without a visible backspin.
  useEffect(() => {
    if (!refreshing) {
      if (pullRef.current !== 0) setPullBoth(0);
      setGlyphTransition("none");
      setAngle(0);
      return;
    }
    setGlyphTransition("transform 0.18s ease");
  }, [refreshing, setPullBoth, setAngle]);

  const glide = dragging ? "none" : "transform 0.25s ease";

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        minHeight: 0,
        position: "relative",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: PULL_REST,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transform: `translateY(${pull - PULL_REST}px)`,
          transition: glide,
          pointerEvents: "none",
          zIndex: 1,
        }}
      >
        <RecycleGlyph
          angle={angle}
          transition={glyphTransition}
          fontSize={26}
          opacity={refreshing ? 1 : Math.min(1, pull / PULL_TRIGGER)}
        />
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          transform: `translateY(${pull}px)`,
          transition: glide,
        }}
      >
        {children}
      </div>
    </div>
  );
}

export default function NarrativeList() {
  const {
    conn,
    connected,
    daemons,
    activeDaemon,
    activeBraneId,
    switchDaemon,
    switchBrane,
    addDaemon,
    archiveDaemon,
    reconnectDaemon,
    forgetDaemon,
    rotateActiveToken,
    onStatus,
    onMeta,
    onActivity,
    subscribeActivity,
    unsubscribeActivity,
  } = useBrane();
  // Whether this page is the daemon's own bundle, and if so where Isolate
  // hops out to: the host the daemon reports, never one the app knows. Asked
  // once here and handed to every card.
  const isolated = typeof window !== "undefined" && !!conn && isIsolated(window.location.host, conn.host);
  const appHost = useAppHost(conn, isolated);
  const [narratives, setNarratives] = useState<NarrativeInfo[]>([]);
  const [branes, setBranes] = useState<BraneInfo[]>([]);
  const braneRefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [folds, setFolds] = useState<FoldInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showSpawn, setShowSpawn] = useState(false);
  // Meld, Twin and Utility from a list row: the target narrative, or null when closed.
  // Which card's status menu is open, by nid — see NarrativeCard's props.
  const [openMenuNid, setOpenMenuNid] = useState<string | null>(null);
  const [meldTarget, setMeldTarget] = useState<NarrativeInfo | null>(null);
  const [twinTarget, setTwinTarget] = useState<NarrativeInfo | null>(null);
  const [utilityTarget, setUtilityTarget] = useState<NarrativeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [endedLimit, setEndedLimit] = useState(ENDED_PAGE_SIZE);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [wikiResults, setWikiResults] = useState<WikiSearchArticle[]>([]);
  const [wikiCollapsed, setWikiCollapsed] = useState(false);
  const [narrativesCollapsed, setNarrativesCollapsed] = useState(false);
  // Narrative result ordering. Default relevance (best match first); the "most
  // recent narrative containing a word" case is one tap away (🧲 → 🕰️). Wiki has
  // no such toggle — it's always relevance-gated.
  const [narrativesOrder, setNarrativesOrder] = useState<SearchOrder>("relevance");
  const [wikiReader, setWikiReader] = useState<WikiTarget | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList>(null);
  const scrollOffsetRef = useRef(0);
  const router = useRouter();

  // Scroll keys with nothing in the list focused (web, desktop). The browser
  // gives PageUp/PageDown, Home/End and ↑/↓ to the focused scroller, or to the
  // document when nothing is focused, and this screen's document has nothing to
  // scroll, so on a fresh load those keys went nowhere. This listener moves the
  // list instead. It stays out of the way of anyone who already owns the key:
  // a route stacked on top (Expo Router keeps this screen mounted underneath,
  // as with [nid]'s listeners), an open modal, an editable, and focus inside
  // the list, where the browser scrolls natively. Chat and terminal handle
  // these keys themselves.
  const isFocused = useIsFocused();
  const listOwnsKeysRef = useRef(false);
  listOwnsKeysRef.current = isFocused;
  // Where the last keyed smooth scroll is headed, so a key pressed mid-glide
  // adds to that target instead of to the half-finished scrollTop.
  const keyedScrollRef = useRef<{ target: number; at: number } | null>(null);
  useEffect(() => {
    if (Platform.OS !== "web" || !isFocused) return;
    const handleListKey = (e: KeyboardEvent) => {
      if (!listOwnsKeysRef.current) return;
      if (e.defaultPrevented || e.isComposing || !isListScrollKey(e)) return;
      const node = listRef.current?.getScrollableNode() as HTMLElement | null;
      if (!node) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      if (target && node.contains(target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const now = performance.now();
      const pending = keyedScrollRef.current;
      const from = pending && now - pending.at < KEYED_SCROLL_SETTLE_MS ? pending.target : node.scrollTop;
      const to = listScrollTarget(e.key, from, node);
      if (to === null) return;
      e.preventDefault();
      keyedScrollRef.current = { target: to, at: now };
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      // `scroll`, not `scrollTo`: react-native-web replaces the host node's
      // `scrollTo` with ScrollView's `({ x, y, animated })` method, which reads
      // `{ top }` as y = undefined and scrolls to the top.
      node.scroll({ top: to, behavior: e.repeat || reduceMotion ? "auto" : "smooth" });
    };
    document.addEventListener("keydown", handleListKey);
    return () => document.removeEventListener("keydown", handleListKey);
  }, [isFocused]);

  const loadData = useCallback(async () => {
    if (!conn) return;
    setError(null);
    setEndedLimit(ENDED_PAGE_SIZE);
    try {
      // When filtering to a specific brane, include archived — non-home
      // branes (e.g. from `brane absorb`) often only contain archived rows.
      const narrativeOpts = activeBraneId
        ? { archived: true, braneIds: [activeBraneId] }
        : undefined;
      const [narrs, flds, brns] = await Promise.all([
        fetchNarratives(conn, narrativeOpts),
        fetchFolds(conn),
        fetchBranes(conn, true).catch(() => [] as BraneInfo[]),
      ]);
      setNarratives(sortNarratives(narrs));
      setFolds(flds);
      setBranes(brns);
      setTimeout(() => {
        listRef.current?.scrollToOffset({ offset: 0, animated: false });
      }, 50);
    } catch (err) {
      setError(String(err));
      setNarratives([]);
      setFolds([]);
      setBranes([]);
    } finally {
      setLoading(false);
    }
  }, [conn, activeBraneId]);

  // Pull-to-refresh: reuse loadData but keep the list visible (the big center
  // spinner only shows on the very first load). loadData swallows its own
  // errors, so this always resolves.
  const handleRefresh = useCallback(async () => {
    if (!conn || refreshing) return;
    setRefreshing(true);
    try {
      await loadData();
    } finally {
      setRefreshing(false);
    }
  }, [conn, refreshing, loadData]);

  useEffect(() => {
    if (!conn) {
      setNarratives([]);
      setFolds([]);
      setBranes([]);
      setLoading(false);
      // Only show error if no daemons at all
      if (daemons.length === 0) {
        const timeout = setTimeout(() => {
          setError(null); // No error — show empty state with "Add Daemon"
          setLoading(false);
        }, 100);
        return () => clearTimeout(timeout);
      }
      return;
    }

    // Clear stale data from previous daemon immediately before fetching
    setNarratives([]);
    setFolds([]);
    setBranes([]);
    setLoading(true);
    loadData();
  }, [conn, loadData, daemons.length]);

  const handleSpawnPress = useCallback(() => {
    // Open even with zero folds — the dialog's "Add folder" form is how a
    // fresh (e.g. mobile-only) install registers its first spawn point.
    if (!conn) return;
    setShowSpawn(true);
  }, [conn]);

  const handleSpawned = useCallback((narrative: NarrativeInfo) => {
    setNarratives((prev) => [narrative, ...prev]);
    // A utility session has no chat to read — its whole life is the terminal.
    router.push(narrative.role === "utility" ? `/${narrative.id}?tab=terminal` : `/${narrative.id}`);
  }, [router]);

  // Revive, like Spawn and Twin, ends in a narrative you want to be looking at.
  // Which one is the daemon's call, not ours: a session that can't resume in
  // place comes back as a twin under a *different* id (`status: "continued"`),
  // so we navigate to the id it returns rather than the one we asked for.
  const handleRevive = useCallback(async (narrative: NarrativeInfo) => {
    if (!conn) return;
    // Roles with nothing to resume twin instead — and twinning is a choice
    // (which agent, which fold), so it gets the dialog here exactly as it does
    // from the narrative's own 🦠 menu. Posting straight through would twin
    // with defaults and never ask.
    if (revivesAsTwin(narrative.role)) {
      setTwinTarget(narrative);
      return;
    }
    const nid = narrative.id;
    try {
      const revived = await reviveNarrative(conn, nid);
      const target = revived.nid ?? nid;
      // A continued revive minted a narrative this list has never seen — there
      // is no broadcast for that, so refetch (as Spawn does by prepending) or
      // it stays missing until the next load.
      if (target !== nid) loadData();
      // Terminal, alone — a resumed agent may be sitting on a prompt.
      router.push(terminalOnlyHref(target));
    } catch (err) {
      setError(String(err));
    }
  }, [conn, router, loadData]);

  // End, like Revive, lands you in the terminal: an interrupt is frequently
  // *blocked* by a prompt ("Do you want to stop?"), and that prompt is only
  // answerable there. The keys go out first so they're already on the wire by
  // the time the pane paints.
  const handleEnd = useCallback((nid: string) => {
    if (!conn) return;
    interruptSession(conn, nid);
    router.push(terminalOnlyHref(nid));
  }, [conn, router]);

  const handleArchive = useCallback(async (nid: string, currentlyArchived: boolean) => {
    if (!conn) return;
    const next = !currentlyArchived;
    try {
      await archiveNarrative(conn, nid, next);
      if (next) {
        setNarratives((prev) => prev.filter((n) => n.id !== nid));
      } else {
        setNarratives((prev) =>
          prev.map((n) => (n.id === nid ? { ...n, archived: false } : n)),
        );
      }
    } catch (err) {
      setError(String(err));
    }
  }, [conn]);

  const handleAddDaemon = useCallback(async (host: string, token: string) => {
    await addDaemon(host, token);
  }, [addDaemon]);

  // Archiving a brane changes what All branes lists, so the narratives are
  // read again with the branes.
  const handleArchiveBrane = useCallback(async (braneId: string, archived: boolean) => {
    if (!conn) return;
    await archiveBrane(conn, braneId, archived);
    await loadData();
  }, [conn, loadData]);

  // Live status updates from control WebSocket
  useEffect(() => {
    return onStatus((nid, status) => {
      setNarratives((prev) =>
        sortNarratives(prev.map((n) => {
          if (n.id !== nid) return n;
          if (status === "mcp_connected") return { ...n, mcp_connected: true };
          // A parked call cannot outlive its bridge, so a disconnect ends the glow too.
          if (status === "mcp_disconnected") return { ...n, mcp_connected: false, awaiting: false };
          if (status === AWAITING_STATUS) return { ...n, awaiting: true };
          if (status === NOT_AWAITING_STATUS) return { ...n, awaiting: false };
          return { ...n, status };
        })),
      );
    });
  }, [onStatus]);

  // Live metadata updates from control WebSocket
  useEffect(() => {
    return onMeta((nid, _title, summary, cost) => {
      // A brane's running total includes archived narratives this screen
      // never loads, so it can't be adjusted from here — re-read it from the
      // daemon instead. Cost metas arrive at most every 20s per connected
      // narrative; one coalesced fetch per burst is plenty.
      if (cost != null && conn) {
        if (braneRefetchTimer.current) clearTimeout(braneRefetchTimer.current);
        braneRefetchTimer.current = setTimeout(() => {
          braneRefetchTimer.current = null;
          fetchBranes(conn, true).then(setBranes).catch(() => {});
        }, 2000);
      }
      setNarratives((prev) =>
        prev.map((n) => {
          if (n.id !== nid) return n;
          if (summary === undefined && cost == null) return n;
          const next = { ...n };
          if (summary !== undefined) next.summary = summary;
          if (cost != null) {
            next.cost_amount = cost.amount;
            next.cost_unit = cost.unit;
          }
          return next;
        }),
      );
    });
  }, [onMeta, conn]);

  // Ambient activity: one subscription to the brane-wide activity stream (not a
  // control-WS subscription per card). Each ping means a new event landed on
  // some narrative, so stamp that card's last_activity to the server's time;
  // the live ticker then restarts its timestamp from 0s as a visible pulse.
  useEffect(() => {
    subscribeActivity();
    const off = onActivity((nid, _seq, time) => {
      setNarratives((prev) => {
        const i = prev.findIndex((n) => n.id === nid);
        if (i < 0) return prev;
        const next = prev.slice();
        next[i] = { ...next[i], last_activity: time };
        return next;
      });
    });
    return () => {
      off();
      unsubscribeActivity();
    };
  }, [onActivity, subscribeActivity, unsubscribeActivity]);

  const showEmptyNoDaemons = !conn && daemons.length === 0;

  // Brane filtering is server-side via fetchNarratives — narratives is
  // already scoped to the active brane (and includes archived in that case).

  // Debounced server-side search
  const [searchNarrs, setSearchNarrs] = useState<NarrativeInfo[]>([]);
  useEffect(() => {
    if (!conn || !searchQuery.trim()) {
      setSearchHits([]);
      setSearchNarrs([]);
      setWikiResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      searchNarratives(conn, searchQuery.trim(), 30, activeBraneId ? [activeBraneId] : undefined)
        .then((data) => {
          setSearchHits(data.results);
          setSearchNarrs(data.narratives || []);
          setSearching(false);
        })
        .catch(() => {
          setSearchHits([]);
          setSearchNarrs([]);
          setSearching(false);
        });
      // Wiki search runs in parallel. No brane filter → all folds + the
      // package wiki (global discovery from the fold-agnostic main page).
      searchWiki(conn, searchQuery.trim(), 10)
        .then((data) => setWikiResults(data.results))
        .catch(() => setWikiResults([]));
    }, 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [conn, searchQuery, activeBraneId]);

  // Known narrative IDs let the wiki reader linkify `nid:seq` citations.
  const knownNarrativeIds = useMemo(() => new Set(narratives.map((n) => n.id)), [narratives]);

  // Group search hits by narrative for snippet display
  const hitsByNarrative = useMemo(() => {
    const map = new Map<string, SearchHit[]>();
    for (const hit of searchHits) {
      const existing = map.get(hit.narrative_id);
      if (existing) existing.push(hit);
      else map.set(hit.narrative_id, [hit]);
    }
    return map;
  }, [searchHits]);

  const searchFiltered = useMemo(() => {
    if (!searchQuery.trim()) return narratives;
    // Local metadata filter
    const q = searchQuery.toLowerCase();
    const localMatches = new Set(
      narratives
        .filter((n) =>
          n.id.toLowerCase().includes(q) ||
          n.summary?.toLowerCase().includes(q) ||
          n.agent_type?.toLowerCase().includes(q) ||
          n.role?.toLowerCase().includes(q) ||
          n.fold_path?.toLowerCase().includes(q) ||
          hitsByNarrative.has(n.id)
        )
        .map((n) => n.id)
    );
    // Merge: local matches + server-surfaced narratives (e.g. archived)
    const localById = new Map(narratives.map((n) => [n.id, n]));
    const merged = new Map<string, NarrativeInfo>();
    for (const id of localMatches) merged.set(id, localById.get(id)!);
    for (const n of searchNarrs) {
      if (!merged.has(n.id)) merged.set(n.id, n);
    }
    return [...merged.values()];
  }, [narratives, searchQuery, hitsByNarrative, searchNarrs]);

  // Best (max) relevance score per narrative, from the server's hit list.
  const scoreByNarrative = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of searchHits) {
      const cur = m.get(h.narrative_id);
      if (cur === undefined || h.score > cur) m.set(h.narrative_id, h.score);
    }
    return m;
  }, [searchHits]);

  const visibleNarratives = useMemo(() => {
    // While searching, honor the chosen order across *all* matches (no status
    // grouping) — pure recency is the point of the toggle, and the result set
    // is already bounded by the search limit + local matches.
    if (searchQuery.trim()) {
      return [...searchFiltered].sort((a, b) => {
        if (narrativesOrder === "recent") return b.created_at - a.created_at;
        // Relevance: best-hit score desc. Pure metadata matches (no hit) have
        // no score, so they fall after scored ones, then break ties by recency.
        const sa = scoreByNarrative.get(a.id) ?? -Infinity;
        const sb = scoreByNarrative.get(b.id) ?? -Infinity;
        if (sa !== sb) return sb - sa;
        return b.created_at - a.created_at;
      });
    }
    // Default list: connected/active first, then a paged window of ended.
    const active: NarrativeInfo[] = [];
    const ended: NarrativeInfo[] = [];
    for (const n of searchFiltered) {
      if (n.status === "ended" && !n.mcp_connected) {
        ended.push(n);
      } else {
        active.push(n);
      }
    }
    return [...active, ...ended.slice(0, endedLimit)];
  }, [searchFiltered, endedLimit, searchQuery, narrativesOrder, scoreByNarrative]);

  // A narrative can leave the list while its menu is open — archived, filtered
  // out by a search, or paged past the ended window. Drop the reference rather
  // than leaving it parked: nothing renders meanwhile, but the row coming back
  // (search cleared) would otherwise pop its menu open again unbidden.
  // Reordering is deliberately NOT this case: the open menu is keyed by nid, so
  // it travels with its narrative wherever the sort puts it.
  useEffect(() => {
    if (openMenuNid && !visibleNarratives.some((n) => n.id === openMenuNid)) {
      setOpenMenuNid(null);
    }
  }, [visibleNarratives, openMenuNid]);

  // What an empty list is hiding. The list loads no archived rows unless a
  // brane is picked (and then loads them all), but every brane's
  // narrative_count includes them; so when the list is empty, the counts of
  // the branes in view are exactly the archived narratives. "No narratives
  // yet" is only true when that is zero.
  const archivedHidden = useMemo(() => {
    if (narratives.length > 0) return 0;
    const inView = activeBraneId ? branes.filter((b) => b.brane_id === activeBraneId) : branes.filter((b) => !b.archived);
    return inView.reduce((sum, b) => sum + b.narrative_count, 0);
  }, [narratives.length, branes, activeBraneId]);

  const totalEnded = useMemo(
    () => searchFiltered.filter((n) => n.status === "ended" && !n.mcp_connected).length,
    [searchFiltered],
  );

  const handleLoadMoreEnded = useCallback(() => {
    setEndedLimit((prev) => Math.min(prev + ENDED_PAGE_SIZE, totalEnded));
  }, [totalEnded]);

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          header: () => (
            <View style={styles.customHeader}>
              <View style={styles.headerTitleRow}>
                <Pressable onPress={loadData} role="button" aria-label="Reload narratives">
                  <Text
                    style={{
                      color: "#8fd4b4",
                      fontSize: 20,
                      fontWeight: "700",
                      letterSpacing: 2,
                      ...(Platform.OS === "web"
                        ? {
                            textShadow: [
                              "0 0 7px rgba(143, 212, 180, 0.8)",
                              "0 0 20px rgba(143, 212, 180, 0.5)",
                              "0 0 40px rgba(100, 200, 160, 0.3)",
                              "0 2px 12px rgba(80, 180, 140, 0.6)",
                            ].join(", "),
                          }
                        : {
                            textShadowColor: "rgba(143, 212, 180, 0.8)",
                            textShadowOffset: { width: 0, height: 0 },
                            textShadowRadius: 12,
                          }),
                    } as any}
                  >
                    BRANE
                  </Text>
                </Pressable>
                <Pressable
                  onPress={handleSpawnPress}
                  role="button"
                  disabled={!conn}
                  style={[
                    styles.spawnButton,
                    !conn && styles.spawnButtonDisabled,
                  ]}
                >
                  <Text style={styles.spawnButtonText}>Spawn</Text>
                </Pressable>
                <BraneSwitcher
                  branes={branes}
                  activeBraneId={activeBraneId}
                  daemons={daemons}
                  activeDaemon={activeDaemon}
                  connected={connected}
                  onSwitchBrane={switchBrane}
                  onSwitchDaemon={switchDaemon}
                  onAdd={handleAddDaemon}
                  onArchiveDaemon={archiveDaemon}
                  onReconnectDaemon={reconnectDaemon}
                  onForgetDaemon={forgetDaemon}
                  onArchiveBrane={handleArchiveBrane}
                  onSignOutOthers={rotateActiveToken}
                  conn={conn}
                />
                <Pressable
                  onPress={() => {
                    setShowSearch((v) => {
                      if (!v) setTimeout(() => searchInputRef.current?.focus(), 100);
                      else setSearchQuery("");
                      return !v;
                    });
                  }}
                  style={[styles.searchButton, showSearch && styles.searchButtonActive]}
                  role="button"
                  aria-label="Search narratives"
                  aria-expanded={showSearch}
                >
                  <Text style={[styles.searchButtonText, showSearch && styles.searchButtonTextActive]}>{"\uD83D\uDD2C"}</Text>
                </Pressable>
              </View>
              {showSearch && (
                <View style={styles.searchBar}>
                  <TextInput
                    ref={searchInputRef}
                    style={styles.searchInput}
                    placeholder="Filter narratives..."
                    placeholderTextColor="#556"
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="search"
                  />
                </View>
              )}
            </View>
          ),
        }}
      />

      {activeDaemon?.revoked ? (
        <View style={styles.center}>
          <Text style={styles.signedOutTitle}>Signed out of {activeDaemon.id}</Text>
          <Text style={styles.emptySubtext}>
            Its token was rotated from another device, so the one stored here
            no longer works. Scan a fresh Meld QR — or run `brane meld` on
            that machine — to reconnect. Nothing else was touched.
          </Text>
        </View>
      ) : loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#5b9bd5" />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : showEmptyNoDaemons ? (
        <MembraneEmpty
          title="No daemons configured"
          subtitle="Tap the daemon selector above to add one"
        />
      ) : (
        // The membrane's caption is markdown (src/shared/membrane-quips.ts):
        // a /protocol in it opens the reader, a nid opens the narrative.
        <MarkdownLinksProvider
          knownNarrativeIds={knownNarrativeIds}
          onNarrativePress={(nid, seq) => router.push(seq != null ? `/${nid}?scrollToSeq=${seq}` : `/${nid}`)}
          onProtocolPress={(name) => setWikiReader({ source: "protocols", slug: name })}
        >
          <PullToRefresh
            refreshing={refreshing}
            onRefresh={handleRefresh}
            scrollOffsetRef={scrollOffsetRef}
          >
            <FlatList
              ref={listRef}
              style={{ flex: 1 }}
              data={searchQuery.trim() && narrativesCollapsed ? [] : visibleNarratives}
              keyExtractor={(item) => item.id}
              CellRendererComponent={NarrativeCell}
              onScroll={(e) => {
                scrollOffsetRef.current = e.nativeEvent.contentOffset.y;
              }}
              scrollEventThrottle={16}
              ListHeaderComponent={
                searchQuery.trim() ? (
                  <>
                    <WikiResultsHeader
                      results={wikiResults}
                      collapsed={wikiCollapsed}
                      onToggle={() => setWikiCollapsed((v) => !v)}
                      onOpen={(source, slug, anchor) => setWikiReader({ source, slug, anchor })}
                    />
                    <View style={styles.wikiSection}>
                      <SectionBar
                        icon={"💬"}
                        label="Narratives"
                        count={visibleNarratives.length}
                        collapsed={narrativesCollapsed}
                        onToggle={() => setNarrativesCollapsed((v) => !v)}
                        order={narrativesOrder}
                        onToggleOrder={() =>
                          setNarrativesOrder((o) => (o === "relevance" ? "recent" : "relevance"))
                        }
                      />
                    </View>
                  </>
                ) : null
              }
              renderItem={({ item }) => (
                <NarrativeCard
                  item={item}
                  conn={conn}
                  onPress={() => router.push(`/${item.id}`)}
                  onArchive={() => handleArchive(item.id, !!item.archived)}
                  onMeld={() => setMeldTarget(item)}
                  onTwin={() => setTwinTarget(item)}
                  onUtility={() => setUtilityTarget(item)}
                  onOpenTrack={(t) => router.push(fileHref(t.nid, t.path))}
                  onRevive={() => handleRevive(item)}
                  onEnd={() => handleEnd(item.id)}
                  menuVisible={openMenuNid === item.id}
                  setMenuVisible={(open) => setOpenMenuNid(open ? item.id : null)}
                  hits={hitsByNarrative.get(item.id)}
                  onHitPress={(nid, seq) => router.push(`/${nid}?scrollToSeq=${seq}`)}
                  isolated={isolated}
                  appHost={appHost}
                />
              )}
              onEndReached={
                !searchQuery.trim() && endedLimit < totalEnded ? handleLoadMoreEnded : undefined
              }
              onEndReachedThreshold={0.3}
              // The membrane is the list's floor: under the last card when there
              // are cards, and the centered empty state (below) when there are none.
              ListFooterComponent={
                visibleNarratives.length > 0 && !searchQuery.trim() ? (
                  <MembraneEmpty />
                ) : null
              }
              // The empty state fills the viewport (flexGrow) so the membrane sits
              // where the first card would not be, centered, rather than at the top.
              contentContainerStyle={
                visibleNarratives.length === 0 && !searchQuery.trim() ? styles.emptyFill : undefined
              }
              ListEmptyComponent={
                searchQuery.trim() ? (
                  narrativesCollapsed ? null : (
                    <View style={styles.center}>
                      <Text style={styles.emptyText}>No narratives match</Text>
                    </View>
                  )
                ) : (
                  <MembraneEmpty
                    title={
                      archivedHidden === 0
                        ? "No narratives yet"
                        : archivedHidden === 1
                          ? "The only narrative is archived"
                          : `All ${archivedHidden} narratives are archived`
                    }
                  />
                )
              }
            />
          </PullToRefresh>
        </MarkdownLinksProvider>
      )}

      <SpawnDialog
        visible={showSpawn}
        conn={conn}
        onClose={() => {
          setShowSpawn(false);
          // Folds may have been added/hidden inside the dialog; keep the list
          // screen's copy (which gates the Spawn button) in sync.
          if (conn) fetchFolds(conn).then(setFolds).catch(() => {});
        }}
        onSpawned={handleSpawned}
      />

      <QrModal
        visible={meldTarget !== null}
        conn={conn}
        path={`/${meldTarget?.id ?? ""}`}
        onClose={() => setMeldTarget(null)}
      />

      <SpawnDialog
        visible={twinTarget !== null}
        conn={conn}
        re={twinTarget?.id}
        defaultFoldPath={twinTarget?.fold_path}
        onClose={() => setTwinTarget(null)}
        onSpawned={handleSpawned}
      />

      <SpawnDialog
        visible={utilityTarget !== null}
        conn={conn}
        initialMode="utility"
        defaultFoldPath={utilityTarget?.fold_path}
        onClose={() => setUtilityTarget(null)}
        onSpawned={handleSpawned}
      />

      {wikiReader && conn && (
        <MarkdownLinksProvider
          knownNarrativeIds={knownNarrativeIds}
          onNarrativePress={(nid, seq) => {
            setWikiReader(null);
            router.push(seq != null ? `/${nid}?scrollToSeq=${seq}` : `/${nid}`);
          }}
        >
          <WikiReader conn={conn} target={wikiReader} onClose={() => setWikiReader(null)} />
        </MarkdownLinksProvider>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  customHeader: {
    backgroundColor: "#1a1a1e",
    paddingTop: 10,
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgb(216, 216, 216)",
  },
  headerTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  // Daemon switcher chip
  daemonChip: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#2a2a30",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: 180,
  },
  chipDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  chipText: {
    color: "#d8d8dd",
    fontSize: 15,
    fontFamily: "monospace",
  },
  chipChevron: {
    color: "#888",
    fontSize: 14,
    marginLeft: 5,
  },
  // Daemon dropdown items
  daemonOption: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: "#2a2a30",
    marginBottom: 6,
  },
  daemonOptionActive: {
    backgroundColor: "#1a3a2a",
    borderWidth: 1,
    borderColor: "#3a6a4a",
  },
  daemonOptionRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  // A switcher row with a ⋯ or actions on its right: the box is the row, and
  // the part that selects is padded inside it.
  switcherRow: {
    flexDirection: "row",
    alignItems: "stretch",
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  switcherRowMain: {
    flex: 1,
    paddingVertical: 12,
    paddingLeft: 12,
    paddingRight: 4,
  },
  switcherRowArchived: {
    opacity: 0.7,
    backgroundColor: "#222228",
  },
  // Lift the row with an open menu above the rows after it.
  rowMenuOpen: {
    zIndex: 100,
  },
  rowMenuButton: {
    paddingHorizontal: 12,
    justifyContent: "center",
  },
  rowMenuIcon: {
    color: "#aaa",
    fontSize: 15,
  },
  archivedActions: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: 8,
    gap: 4,
  },
  archivedAction: {
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  archivedActionText: {
    color: "#8fd4b4",
    fontSize: 13,
  },
  archivedActionDanger: {
    color: "#e0a070",
  },
  archivedToggle: {
    paddingVertical: 8,
    alignItems: "center",
  },
  archivedToggleText: {
    color: "#8a8a93",
    fontSize: 13,
  },
  daemonDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 10,
  },
  daemonName: {
    color: "#d8d8dd",
    fontSize: 15,
    fontFamily: "monospace",
  },
  daemonCost: {
    color: "#7bb894",
    fontSize: 12,
    fontFamily: "monospace",
    marginTop: 2,
  },
  daemonHost: {
    color: "#777",
    fontSize: 12,
    fontFamily: "monospace",
    marginTop: 2,
  },
  emptyDaemons: {
    color: "#666",
    fontSize: 14,
    textAlign: "center",
    paddingVertical: 16,
  },
  // Add daemon form
  addDaemonButton: {
    paddingVertical: 14,
    alignItems: "center",
    borderRadius: 8,
    backgroundColor: "#2a2a30",
    marginTop: 8,
  },
  addDaemonButtonText: {
    color: "#8fd4b4",
    fontSize: 15,
    fontWeight: "600",
  },
  addForm: {
    marginTop: 8,
    gap: 8,
  },
  addInput: {
    backgroundColor: "#222228",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#d8d8dd",
    fontSize: 14,
    fontFamily: "monospace",
    borderWidth: 1,
    borderColor: "#3a3a40",
  },
  addError: {
    color: "#e07070",
    fontSize: 12,
  },
  addButton: {
    backgroundColor: "#5b9bd5",
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  addButtonText: {
    color: "#111",
    fontSize: 14,
    fontWeight: "600",
  },
  // Sign out other devices
  signOutBody: {
    color: "#999",
    fontSize: 13,
    lineHeight: 18,
  },
  // A layer over the switcher: narrower than the switcher card so the
  // switcher stays visible around it and the layering reads as such.
  layerCard: {
    backgroundColor: "#1e1e22",
    borderRadius: 12,
    padding: 20,
    width: "100%",
    maxWidth: 360,
    borderWidth: 1,
    borderColor: "#3a3a40",
  },
  layerTitle: {
    color: "#d8d8dd",
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 10,
  },
  layerButtonRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 4,
  },
  layerCancel: {
    flex: 1,
    backgroundColor: "#2a2a30",
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  layerCancelText: {
    color: "#aaa",
    fontSize: 14,
    fontWeight: "600",
  },
  layerConfirm: {
    flex: 2,
  },
  signOutButton: {
    backgroundColor: "#e0a070",
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  signedOutTitle: {
    color: "#e0a070",
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 8,
    textAlign: "center",
  },
  // Spawn modal fields
  fieldLabel: {
    color: "#aaa",
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 12,
    marginBottom: 6,
  },
  fieldStaticValue: {
    backgroundColor: "#222228",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "#2a2a30",
  },
  // Cards
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  summary: {
    color: "#9a9aa0",
    fontSize: 12,
    marginTop: 4,
    lineHeight: SUMMARY_LINE_HEIGHT,
  },
  status: {
    fontSize: 12,
    textTransform: "uppercase",
  },
  hitsContainer: {
    marginTop: 8,
    gap: 4,
  },
  hitSnippetBox: {
    paddingLeft: 10,
    paddingVertical: 3,
    borderLeftWidth: 2,
    borderLeftColor: "rgba(255, 130, 180, 0.5)",
    backgroundColor: "rgba(255, 130, 180, 0.04)",
    borderRadius: 2,
  },
  // No padding here: see HitSnippet.
  hitSnippet: {
    color: "#b0a890",
    fontSize: 12,
    lineHeight: 17,
  },
  // Wiki search results section
  wikiSection: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 4,
  },
  // Full-width tappable Wiki heading bar with explicit toggle states.
  wikiBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 11,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderRadius: 8,
    backgroundColor: "rgba(143, 212, 180, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(143, 212, 180, 0.35)",
    ...(Platform.OS === "web" ? { userSelect: "none" } : {}),
  } as any,
  wikiBarCollapsed: {
    backgroundColor: "rgba(143, 212, 180, 0.06)",
    borderColor: "rgba(143, 212, 180, 0.22)",
  },
  wikiBarPillPressed: {
    backgroundColor: "rgba(143, 212, 180, 0.18)",
  },
  // Shared pill for the bar's two right-side controls — the 🧲/🕰️ order toggle
  // and the Show/Hide toggle — so they read identically (radius 9, dark fill,
  // green border).
  wikiBarPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 9,
    flexShrink: 0,
    // Darker than the faint-green header bar so the colored emoji pops; the
    // green border keeps the pill defined against the darker fill.
    backgroundColor: "rgba(0, 0, 0, 0.32)",
    borderWidth: 1,
    borderColor: "rgba(143, 212, 180, 0.35)",
    ...(Platform.OS === "web" ? { cursor: "pointer", userSelect: "none" } : {}),
  } as any,
  wikiBarOrderLabel: {
    // Light weight, bright against the dark bar — distinct from the muted
    // HIDE/SHOW, since this is the live control. Uppercase to match the bar.
    // No fixed width: the pill sizes to fit its label.
    color: "#cdeede",
    fontSize: 13,
    fontWeight: "400",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  wikiBarIcon: {
    fontSize: 15,
  },
  wikiBarLabel: {
    color: "#8fd4b4",
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    flexShrink: 1,
  },
  // Plain count, no badge — the digits earn their place; the rounded
  // background was chrome that didn't.
  wikiBarCount: {
    color: "#bfe6d3",
    fontSize: 12,
    fontWeight: "700",
    fontFamily: "monospace",
    flexShrink: 0,
  },
  // Matches the order chip's label (wikiBarOrderLabel) so both pills read alike.
  wikiBarToggle: {
    color: "#cdeede",
    fontSize: 13,
    fontWeight: "400",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  wikiCard: {
    backgroundColor: "#1e1e24",
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(143, 212, 180, 0.25)",
  },
  wikiCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  wikiSlug: {
    color: "#d8d8dd",
    fontSize: 15,
    fontWeight: "600",
    fontFamily: "monospace",
    flex: 1,
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
  wikiHitCitation: {
    color: "#6c9bd5",
    fontSize: 11,
    fontFamily: "monospace",
    paddingLeft: 10,
    marginTop: 4,
  },
  hitMatch: {
    color: "#ffd9ec",
    fontWeight: "700",
    backgroundColor: "rgba(255, 130, 180, 0.22)",
  },
  emptyFill: {
    flexGrow: 1,
  },
  emptyText: {
    color: "#666",
    fontSize: 16,
  },
  emptySubtext: {
    color: "#555",
    fontSize: 13,
    marginTop: 8,
  },
  errorText: {
    color: "#e07070",
    fontSize: 14,
    textAlign: "center",
  },
  searchButton: {
    paddingLeft: 16,
    paddingVertical: 8,
    marginLeft: "auto" as any,
    marginRight: -5,
  },
  searchButtonActive: {},
  searchButtonText: {
    fontSize: 20,
  },
  searchButtonTextActive: {
    ...(Platform.OS === "web"
      ? {
          textShadow: [
            "0 0 10px rgba(255, 130, 180, 0.9)",
            "0 0 25px rgba(255, 110, 165, 0.7)",
            "0 0 50px rgba(255, 100, 155, 0.4)",
            "0 2px 15px rgba(255, 120, 170, 0.6)",
          ].join(", "),
        }
      : {
          textShadowColor: "rgba(255, 130, 180, 0.8)",
          textShadowOffset: { width: 0, height: 0 },
          textShadowRadius: 16,
        }),
  } as any,
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 10,
  },
  searchInput: {
    flex: 1,
    color: "#d8d8dd",
    fontSize: 16,
    fontFamily: "monospace",
    backgroundColor: "#222228",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "rgba(255, 130, 180, 0.4)",
    ...(Platform.OS === "web"
      ? {
          outlineStyle: "none",
          boxShadow: [
            "0 0 6px rgba(255, 130, 180, 0.5)",
            "0 0 14px rgba(255, 110, 165, 0.35)",
            "0 0 28px rgba(255, 100, 155, 0.2)",
          ].join(", "),
        }
      : {}) as any,
  },
  spawnButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "#5b9bd5",
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 0,
    ...(Platform.OS === "web"
      ? {
          boxShadow: [
            "0 0 6px rgba(91, 155, 213, 0.7)",
            "0 0 16px rgba(91, 155, 213, 0.4)",
            "0 2px 10px rgba(70, 130, 200, 0.5)",
          ].join(", "),
        }
      : {}) as any,
  },
  spawnButtonDisabled: {
    opacity: 0.4,
  },
  spawnButtonText: {
    color: "#111",
    fontSize: 14,
    fontWeight: "600",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  modalContent: {
    backgroundColor: "#1e1e22",
    borderRadius: 12,
    padding: 20,
    width: "100%",
    maxWidth: 400,
    maxHeight: "80%",
  },
  modalTitle: {
    color: "#d8d8dd",
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 16,
  },
  foldOption: {
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: "#2a2a30",
    marginBottom: 8,
  },
  foldOptionText: {
    color: "#d8d8dd",
    fontSize: 15,
    fontFamily: "monospace",
  },
  modalCancel: {
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 8,
  },
  modalCancelText: {
    color: "#888",
    fontSize: 15,
  },
});
