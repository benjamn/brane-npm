import { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  Modal,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  type StyleProp,
  type TextStyle,
} from "react-native";
import {
  fetchSpawnHistory,
  fetchRunHistory,
  fetchFolds,
  addFold,
  archiveFold,
  spawnAgent,
  runUtility,
  type ConnectionParams,
  type NarrativeInfo,
  type FoldInfo,
  type SpawnHistoryEntry,
} from "@/lib/api";
import ContextMenu from "./ContextMenu";

const AGENT_TYPES = ["claude", "gemini", "goose", "copilot", "cline", "codex", "crush", "amp"] as const;

/** The Utility dropdown's escape hatch: type a command no utility session has
 *  run yet. Empty, which no history entry can be (`runHistory` excludes it). */
const OTHER_UTILITY = "";

/** The Agent dropdown's escape hatch: any executable on the daemon's PATH, as
 *  `brane spawn <agent>` takes. Empty, which no entry in AGENT_TYPES is. */
const OTHER_AGENT = "";

export type SpawnMode = "agent" | "utility";

const nativeSelectChevron =
  "url(\"data:image/svg+xml;utf8," +
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'>" +
  "<path d='M1 1.5l5 5 5-5' stroke='%23a8a8b0' stroke-width='1.6' " +
  "fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>\")";

const nativeSelectStyle: React.CSSProperties = {
  display: "block",
  boxSizing: "border-box",
  width: "100%",
  margin: 0,
  backgroundColor: "#222228",
  color: "#d8d8dd",
  border: "1px solid #3a3a40",
  borderRadius: 8,
  padding: "10px 36px 10px 12px",
  fontSize: 14,
  fontFamily: "monospace",
  lineHeight: "20px",
  outline: "none",
  colorScheme: "dark",
  cursor: "pointer",
  appearance: "none",
  WebkitAppearance: "none",
  MozAppearance: "none",
  backgroundImage: nativeSelectChevron,
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 12px center",
  backgroundSize: "12px 8px",
};

export interface SpawnDialogProps {
  visible: boolean;
  conn: ConnectionParams | null;
  /**
   * When set, the dialog is in "twin" mode: the spawned agent continues from
   * this predecessor narrative (passed to the server as `re`). The role is
   * prefilled to "twin" and the title names the predecessor.
   */
  re?: string | null;
  /**
   * Fold to default the picker to (e.g. the predecessor's fold when twinning a
   * narrative that has one). Falls back to the first registered fold if unset
   * or not currently registered.
   */
  defaultFoldPath?: string | null;
  /**
   * Which side of the Agent ↔ Utility switch the dialog opens on (default
   * "agent"). The 🦠 menu's 🐚 Utility opens on "utility", where the newest
   * run-history entry is already the default pick. Ignored in twin mode.
   */
  initialMode?: SpawnMode;
  onClose: () => void;
  onSpawned: (narrative: NarrativeInfo) => void;
}

/**
 * Shared agent-spawn modal, usable from any screen (the narrative list's Spawn
 * button and a narrative's 🧬 Twin action). Self-contained: owns its form
 * state and the spawn call. Canceling simply closes it, leaving the host screen
 * exactly as it was — so twinning from a narrative returns to that narrative.
 */
export default function SpawnDialog({ visible, conn, re, defaultFoldPath, initialMode = "agent", onClose, onSpawned }: SpawnDialogProps) {
  const [mode, setMode] = useState<SpawnMode>("agent");
  const [selectedAgent, setSelectedAgent] = useState<string>("claude");
  const [otherAgent, setOtherAgent] = useState<string>("");
  const [utilities, setUtilities] = useState<string[]>([]);
  const [selectedUtility, setSelectedUtility] = useState<string>(OTHER_UTILITY);
  const [otherUtility, setOtherUtility] = useState<string>("");
  // Set once the operator picks or types a utility, so run history arriving
  // late never swaps the select out from under them — at satellite RTT the
  // fetch can land after "Other…"'s box has taken focus and keystrokes.
  const utilityTouched = useRef(false);
  const [role, setRole] = useState<string>("worker");
  const [argsText, setArgsText] = useState<string>("");
  const [folds, setFolds] = useState<FoldInfo[]>([]);
  const [foldPath, setFoldPath] = useState<string | null>(null);
  const [recentArgs, setRecentArgs] = useState<SpawnHistoryEntry[]>([]);
  const [spawning, setSpawning] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  // Fold management (add / archive) state.
  const [showHidden, setShowHidden] = useState(false);
  const [showAddFold, setShowAddFold] = useState(false);
  const [newFoldPath, setNewFoldPath] = useState("");
  const [addingFold, setAddingFold] = useState(false);
  const [foldError, setFoldError] = useState<string | null>(null);
  // Which fold row's ⋯ menu is open (by path), and any pending archive confirm.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirmFold, setConfirmFold] = useState<{ fold: FoldInfo; toArchived: boolean } | null>(null);

  // Sort active folds most-recently-used first (last_spawned, then created_at)
  // so the common case sits on top and becomes the default selection. Archived
  // folds keep creation order — they're just an unhide list.
  const recency = (f: FoldInfo) => f.last_spawned ?? f.created_at ?? 0;
  const activeFolds = folds.filter((f) => !f.archived).sort((a, b) => recency(b) - recency(a));
  const archivedFolds = folds.filter((f) => f.archived);

  // Choose a sensible selected fold from a fresh list: keep the current
  // selection if still active, else prefer the requested default, else first.
  const pickFold = useCallback(
    (flds: FoldInfo[], keep: string | null): string | null => {
      const active = flds
        .filter((f) => !f.archived)
        .sort((a, b) => (b.last_spawned ?? b.created_at ?? 0) - (a.last_spawned ?? a.created_at ?? 0));
      if (keep && active.some((f) => f.path === keep)) return keep;
      if (defaultFoldPath && active.some((f) => f.path === defaultFoldPath)) return defaultFoldPath;
      return active[0]?.path ?? null; // most-recently-used
    },
    [defaultFoldPath],
  );

  // (Re)initialize the form each time the dialog opens. Twin mode prefills the
  // role to "twin"; otherwise default to "worker". Folds + recent args are
  // fetched here so the dialog is self-contained on any screen. We fetch
  // archived folds too so the "show hidden" toggle needs no extra round-trip.
  // Initialize once per OPEN (visible false→true). Gating on the transition —
  // not just `visible` truthiness — keeps a re-render (e.g. a control-WS
  // reconnect that recomputes the memoized `conn`) from re-firing this effect
  // and re-fetching folds mid-interaction, which would clobber an optimistic
  // archive and make the hidden fold snap back into the list.
  const wasVisible = useRef(false);
  useEffect(() => {
    if (!visible) {
      wasVisible.current = false;
      return;
    }
    if (wasVisible.current) return; // already initialized for this open
    wasVisible.current = true;
    setRole(re ? "twin" : "worker");
    setMode(initialMode);
    setSelectedAgent("claude");
    setOtherAgent("");
    setSpawnError(null);
    setSelectedUtility(OTHER_UTILITY);
    utilityTouched.current = false;
    setOtherUtility("");
    setArgsText("");
    setShowHidden(false);
    setShowAddFold(false);
    setNewFoldPath("");
    setFoldError(null);
    setMenuFor(null);
    setConfirmFold(null);
    if (conn) {
      fetchFolds(conn, true)
        .then((flds) => {
          setFolds(flds);
          setFoldPath(pickFold(flds, null));
        })
        .catch(() => setFolds([]));
      fetchSpawnHistory(conn)
        .then(setRecentArgs)
        .catch(() => setRecentArgs([]));
      // Utilities are whatever utility sessions have run before, most recent first; the
      // most recent is the default. With no history, "Other…" is all there is.
      fetchRunHistory(conn)
        .then((history) => {
          const names = history.map((h) => h.command);
          setUtilities(names);
          if (!utilityTouched.current) setSelectedUtility(names[0] ?? OTHER_UTILITY);
        })
        .catch(() => setUtilities([]));
    }
  }, [visible, re, conn, defaultFoldPath, initialMode, pickFold]);

  const handleAddFold = useCallback(async () => {
    if (!conn || addingFold) return;
    const path = newFoldPath.trim();
    if (!path) return;
    setAddingFold(true);
    setFoldError(null);
    try {
      const added = await addFold(conn, path);
      // Re-fetch so an un-archived re-add lands in the right bucket, then select
      // the just-added fold.
      const flds = await fetchFolds(conn, true);
      setFolds(flds);
      setFoldPath(added.path);
      setNewFoldPath("");
      setShowAddFold(false);
    } catch (err) {
      setFoldError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingFold(false);
    }
  }, [conn, addingFold, newFoldPath]);

  const handleToggleArchive = useCallback(
    async (fold: FoldInfo) => {
      if (!conn) return;
      const nextArchived = !fold.archived;
      setFoldError(null);
      // Optimistic update.
      const optimistic = folds.map((f) =>
        f.path === fold.path ? { ...f, archived: nextArchived ? 1 : 0 } : f,
      );
      setFolds(optimistic);
      // If we just hid the selected fold, move selection to another active one.
      setFoldPath((cur) => (cur === fold.path && nextArchived ? pickFold(optimistic, null) : cur));
      try {
        await archiveFold(conn, fold.path, nextArchived);
        // Reconcile with authoritative server state so the row can't drift back
        // (optimistic update stays if the refetch agrees; corrects it if not).
        const flds = await fetchFolds(conn, true);
        setFolds(flds);
        setFoldPath((cur) => pickFold(flds, cur));
      } catch (err) {
        setFolds(folds); // revert
        setFoldError(err instanceof Error ? err.message : String(err));
      }
    },
    [conn, folds, pickFold],
  );

  // A twin is always an agent, so `re` pins agent mode whatever `mode` says.
  const utilityMode = mode === "utility" && !re;
  const typingUtility = utilityMode && selectedUtility === OTHER_UTILITY;
  // The command and its own args. "Other…" is where a whole command line gets
  // typed (`git log`), so it splits like the args box rather than reaching
  // doRun as one argv element the shell can't find.
  const utilityCommand = (typingUtility ? otherUtility : selectedUtility)
    .trim()
    .split(/\s+/)
    .filter((tok) => tok.length > 0);
  // Same for "Other…" on the Agent side: the first word is the agent, the rest
  // lead its args, so `aider --model x` spawns aider with `--model x`.
  const typingAgent = !utilityMode && selectedAgent === OTHER_AGENT;
  const agentCommand = (typingAgent ? otherAgent : selectedAgent)
    .trim()
    .split(/\s+/)
    .filter((tok) => tok.length > 0);

  const handleGo = useCallback(async () => {
    if (!conn || spawning) return;
    const fold = foldPath ?? activeFolds[0]?.path;
    if (!fold) return;
    const effectiveRole = role.trim() || "worker";
    const extraArgs = argsText
      .trim()
      .split(/\s+/)
      .filter((tok) => tok.length > 0);
    if (utilityMode && utilityCommand.length === 0) return;
    if (!utilityMode && agentCommand.length === 0) return;
    const agentArgs = [...agentCommand.slice(1), ...extraArgs];
    setSpawning(true);
    setSpawnError(null);
    try {
      const narrative = utilityMode
        ? await runUtility(conn, [...utilityCommand, ...extraArgs], fold)
        : await spawnAgent(
        conn,
        agentCommand[0],
        fold,
        effectiveRole,
        undefined,
        agentArgs.length > 0 ? agentArgs : undefined,
        re ?? undefined,
      );
      onSpawned(narrative);
      onClose();
    } catch (err) {
      console.error("Spawn failed:", err);
      // A typed agent the daemon can't find ("Agent command not found: aidr")
      // is the operator's to fix, so say so here rather than only in the console.
      setSpawnError(err instanceof Error ? err.message : String(err));
    } finally {
      setSpawning(false);
    }
  }, [conn, spawning, foldPath, folds, role, argsText, utilityMode, utilityCommand, agentCommand, re, onSpawned, onClose]);

  const canSpawn =
    !spawning &&
    !!foldPath &&
    (utilityMode ? utilityCommand.length > 0 : agentCommand.length > 0);

  return (
    <>
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalOverlay} onPress={onClose}>
        <Pressable style={styles.modalContent} onPress={() => {}}>
          <Text style={styles.modalTitle}>{re ? `/twin with ${re}` : utilityMode ? "Run utility" : "Spawn agent"}</Text>

          <ScrollView style={{ flexGrow: 0 }}>
            {/* Agent ↔ Utility: two labels over one dropdown, the lit one saying
                what the dropdown holds. A twin is always an agent, so twin
                mode shows only the Agent label. */}
            <View style={styles.modeRow}>
              <Pressable
                onPress={() => setMode("agent")}
                accessibilityRole="tab"
                accessibilityState={{ selected: !utilityMode }}
                hitSlop={8}
              >
                <Text style={[styles.fieldLabel, styles.modeLabel, utilityMode && styles.modeLabelDim]}>
                  Agent
                </Text>
              </Pressable>
              {!re && (
                <Pressable
                  onPress={() => setMode("utility")}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: utilityMode }}
                  hitSlop={8}
                >
                  <Text style={[styles.fieldLabel, styles.modeLabel, !utilityMode && styles.modeLabelDim]}>
                    Utility
                  </Text>
                </Pressable>
              )}
            </View>
            {utilityMode ? (
              <select
                value={selectedUtility}
                onChange={(e) => {
                  utilityTouched.current = true;
                  setSelectedUtility(e.target.value);
                }}
                style={nativeSelectStyle}
              >
                {utilities.map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
                <option value={OTHER_UTILITY}>Other…</option>
              </select>
            ) : (
              <select
                value={selectedAgent}
                onChange={(e) => setSelectedAgent(e.target.value)}
                style={nativeSelectStyle}
              >
                {AGENT_TYPES.map((agent) => (
                  <option key={agent} value={agent}>{agent}</option>
                ))}
                <option value={OTHER_AGENT}>Other…</option>
              </select>
            )}

            {typingAgent && (
              <TextInput
                style={[styles.addInput, { marginTop: 6 }]}
                value={otherAgent}
                onChangeText={setOtherAgent}
                placeholder="aider"
                placeholderTextColor="#666"
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
              />
            )}

            {typingUtility && (
              <TextInput
                style={[styles.addInput, { marginTop: 6 }]}
                value={otherUtility}
                onChangeText={(text) => {
                  utilityTouched.current = true;
                  setOtherUtility(text);
                }}
                placeholder="zsh"
                placeholderTextColor="#666"
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
              />
            )}

            {!utilityMode && (
              <>
                <Text style={styles.fieldLabel}>Role</Text>
                <TextInput
                  style={styles.addInput}
                  value={role}
                  onChangeText={setRole}
                  placeholder="worker"
                  placeholderTextColor="#666"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </>
            )}

            <Text style={styles.fieldLabel}>CLI args (optional)</Text>
            <TextInput
              style={styles.addInput}
              value={argsText}
              onChangeText={setArgsText}
              placeholder={utilityMode ? "args" : "--flag value"}
              placeholderTextColor="#666"
              autoCapitalize="none"
              autoCorrect={false}
            />
            {/* Spawn history is agents' launch args; it means nothing to a utility. */}
            {!utilityMode && recentArgs.length > 0 && (
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) setArgsText(e.target.value);
                  e.target.value = "";
                }}
                style={{ ...nativeSelectStyle, marginTop: 6 }}
              >
                <option value="">Recent args…</option>
                {recentArgs.map((entry, idx) => {
                  const display = entry.args.join(" ");
                  return (
                    <option key={`${display}-${idx}`} value={display}>
                      {display}
                    </option>
                  );
                })}
              </select>
            )}

            <Text style={styles.fieldLabel}>Fold</Text>

            {activeFolds.length === 0 && !showAddFold && (
              <Text style={styles.foldEmptyHint}>
                No folders yet. Add a directory below to spawn agents in it.
              </Text>
            )}

            {activeFolds.map((fold) => {
              const selected = fold.path === foldPath;
              return (
                <View
                  key={fold.path}
                  style={[
                    styles.foldRow,
                    selected && styles.foldRowSelected,
                    // Lift the row (and its absolutely-positioned menu) above the
                    // sibling rows below it, which would otherwise paint on top.
                    menuFor === fold.path && styles.foldRowMenuOpen,
                  ]}
                >
                  <Pressable
                    style={styles.foldRowSelect}
                    onPress={() => setFoldPath(fold.path)}
                  >
                    <Text style={styles.foldRowDot}>{selected ? "●" : "○"}</Text>
                    <FoldPath path={fold.path} selected={selected} />
                  </Pressable>
                  <div style={{ position: "relative" }}>
                    <Pressable
                      style={styles.foldRowAction}
                      onPress={() => setMenuFor((cur) => (cur === fold.path ? null : fold.path))}
                      accessibilityLabel={`Actions for ${fold.path}`}
                    >
                      <Text style={styles.foldRowActionIcon}>⋯</Text>
                    </Pressable>
                    {menuFor === fold.path && (
                      <ContextMenu
                        items={[{
                          label: "Archive",
                          icon: "🗄️",
                          onPress: () => { setMenuFor(null); setConfirmFold({ fold, toArchived: true }); },
                        }]}
                        onClose={() => setMenuFor(null)}
                        align="beside"
                      />
                    )}
                  </div>
                </View>
              );
            })}

            {/* Hidden folds, shown behind a toggle. Archived folds aren't
                spawnable — only un-hideable — so no selection affordance. */}
            {showHidden &&
              archivedFolds.map((fold) => (
                <View
                  key={fold.path}
                  style={[
                    styles.foldRow,
                    styles.foldRowArchived,
                    menuFor === fold.path && styles.foldRowMenuOpen,
                  ]}
                >
                  <View style={styles.foldRowSelect}>
                    <FoldPath path={fold.path} />
                  </View>
                  <div style={{ position: "relative" }}>
                    <Pressable
                      style={styles.foldRowAction}
                      onPress={() => setMenuFor((cur) => (cur === fold.path ? null : fold.path))}
                      accessibilityLabel={`Actions for ${fold.path}`}
                    >
                      <Text style={styles.foldRowActionIcon}>⋯</Text>
                    </Pressable>
                    {menuFor === fold.path && (
                      <ContextMenu
                        items={[{
                          label: "Unarchive",
                          icon: "📂",
                          onPress: () => { setMenuFor(null); setConfirmFold({ fold, toArchived: false }); },
                        }]}
                        onClose={() => setMenuFor(null)}
                        align="beside"
                      />
                    )}
                  </div>
                </View>
              ))}

            {archivedFolds.length > 0 && (
              <Pressable onPress={() => setShowHidden((v) => !v)} style={styles.foldTextButton}>
                <Text style={styles.foldTextButtonLabel}>
                  {showHidden
                    ? "Hide archived"
                    : `Show ${archivedFolds.length} hidden`}
                </Text>
              </Pressable>
            )}

            {showAddFold ? (
              <View style={styles.addFoldForm}>
                <TextInput
                  style={styles.addInput}
                  value={newFoldPath}
                  onChangeText={setNewFoldPath}
                  placeholder="~/dev/my-project"
                  placeholderTextColor="#666"
                  autoCapitalize="none"
                  autoCorrect={false}
                  onSubmitEditing={handleAddFold}
                />
                <Text style={styles.addFoldHint}>Must be a directory under your home folder.</Text>
                <Pressable
                  style={[styles.addButton, { marginTop: 8 }, (addingFold || !newFoldPath.trim()) && { opacity: 0.5 }]}
                  onPress={handleAddFold}
                  disabled={addingFold || !newFoldPath.trim()}
                >
                  {addingFold ? (
                    <ActivityIndicator size="small" color="#111" />
                  ) : (
                    <Text style={styles.addButtonText}>Add folder</Text>
                  )}
                </Pressable>
              </View>
            ) : (
              <Pressable style={styles.addFoldButton} onPress={() => setShowAddFold(true)}>
                <Text style={styles.addFoldButtonText}>+ Add folder</Text>
              </Pressable>
            )}
            {foldError && <Text style={styles.foldErrorText}>{foldError}</Text>}
          </ScrollView>

          {spawnError && <Text style={styles.foldErrorText}>{spawnError}</Text>}
          <Pressable
            style={[styles.addButton, { marginTop: 12 }, !canSpawn && { opacity: 0.5 }]}
            onPress={handleGo}
            disabled={!canSpawn}
          >
            {spawning ? (
              <ActivityIndicator size="small" color="#111" />
            ) : (
              <Text style={styles.addButtonText}>{re ? "/twin" : utilityMode ? "Run" : "Spawn"}</Text>
            )}
          </Pressable>
          <Pressable style={styles.modalCancel} onPress={onClose}>
            <Text style={styles.modalCancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>

    {/* Archive/unarchive confirmation. Reuses the dialog's modal styling. */}
    <Modal
      visible={!!confirmFold}
      transparent
      animationType="fade"
      onRequestClose={() => setConfirmFold(null)}
    >
      <Pressable style={styles.modalOverlay} onPress={() => setConfirmFold(null)}>
        <Pressable style={[styles.modalContent, { maxWidth: 340 }]} onPress={() => {}}>
          <Text style={styles.modalTitle}>
            {confirmFold?.toArchived ? "Archive fold?" : "Unarchive fold?"}
          </Text>
          <Text style={styles.confirmBody}>
            {confirmFold?.toArchived
              ? "Hide this fold from the spawn list. It's kept and can be unarchived anytime."
              : "Restore this fold to the spawn list."}
          </Text>
          {confirmFold && (
            <FoldPath path={confirmFold.fold.path} textStyle={styles.confirmPath} />
          )}
          <Pressable
            style={[styles.addButton, { marginTop: 16 }]}
            onPress={() => {
              if (confirmFold) handleToggleArchive(confirmFold.fold);
              setConfirmFold(null);
            }}
          >
            <Text style={styles.addButtonText}>
              {confirmFold?.toArchived ? "Archive" : "Unarchive"}
            </Text>
          </Pressable>
          <Pressable style={styles.modalCancel} onPress={() => setConfirmFold(null)}>
            <Text style={styles.modalCancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
    </>
  );
}

// Fold paths are long and their tails tell them apart, so a path that
// overflows scrolls sideways under a fade instead of ending in an ellipsis.
// The fade is a mask, as in the narrative list's summaries; the padding is
// the fade's width, so scrolling to the end brings the last characters fully
// clear of it.
const FOLD_PATH_FADE = 40;

function FoldPath({ path, selected, textStyle = styles.foldRowText }: {
  path: string;
  selected?: boolean;
  textStyle?: StyleProp<TextStyle>;
}) {
  return (
    <div className="no-scrollbar" style={{
      flex: 1,
      minWidth: 0,
      overflowX: "auto",
      overflowY: "hidden",
      scrollbarWidth: "none",
      WebkitOverflowScrolling: "touch",
      maskImage: `linear-gradient(to right, #000 calc(100% - ${FOLD_PATH_FADE}px), transparent)`,
      WebkitMaskImage: `linear-gradient(to right, #000 calc(100% - ${FOLD_PATH_FADE}px), transparent)`,
    }}>
      <Text style={[textStyle, selected && styles.foldRowTextSelected, {
        flex: undefined,
        whiteSpace: "nowrap",
        paddingRight: FOLD_PATH_FADE,
      } as TextStyle]}>
        {path}
      </Text>
    </div>
  );
}

const styles = StyleSheet.create({
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
  fieldLabel: {
    color: "#aaa",
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 12,
    marginBottom: 6,
  },
  modeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  modeLabel: {
    color: "#d8d8dd",
  },
  modeLabelDim: {
    color: "#66666e",
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
  fieldStaticValue: {
    backgroundColor: "#222228",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "#2a2a30",
  },
  foldOptionText: {
    color: "#d8d8dd",
    fontSize: 15,
    fontFamily: "monospace",
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
  modalCancel: {
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 8,
  },
  modalCancelText: {
    color: "#888",
    fontSize: 15,
  },
  foldEmptyHint: {
    color: "#888",
    fontSize: 13,
    fontStyle: "italic",
    paddingVertical: 8,
  },
  foldRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#2a2a30",
    borderRadius: 8,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: "transparent",
  },
  foldRowSelected: {
    borderColor: "#5b9bd5",
    backgroundColor: "#26303a",
  },
  foldRowArchived: {
    opacity: 0.55,
    backgroundColor: "#222228",
  },
  foldRowMenuOpen: {
    zIndex: 100,
  },
  foldRowSelect: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingLeft: 12,
    paddingRight: 8,
    gap: 8,
  },
  foldRowDot: {
    color: "#5b9bd5",
    fontSize: 13,
    width: 12,
  },
  foldRowText: {
    flex: 1,
    color: "#c8c8cf",
    fontSize: 14,
    fontFamily: "monospace",
  },
  foldRowTextSelected: {
    color: "#eaeaef",
  },
  foldRowAction: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignSelf: "stretch",
    justifyContent: "center",
  },
  foldRowActionIcon: {
    fontSize: 15,
  },
  foldTextButton: {
    paddingVertical: 6,
    alignItems: "center",
  },
  foldTextButtonLabel: {
    color: "#8a8a93",
    fontSize: 13,
  },
  addFoldForm: {
    marginTop: 6,
  },
  addFoldHint: {
    color: "#777",
    fontSize: 12,
    marginTop: 6,
  },
  addFoldButton: {
    backgroundColor: "#2a2a30",
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
    marginTop: 6,
  },
  addFoldButtonText: {
    color: "#8fd4b4",
    fontSize: 14,
    fontWeight: "600",
  },
  foldErrorText: {
    color: "#e07070",
    fontSize: 13,
    marginTop: 8,
  },
  confirmBody: {
    color: "#c8c8cf",
    fontSize: 14,
    lineHeight: 20,
  },
  confirmPath: {
    color: "#9fb8d0",
    fontSize: 13,
    fontFamily: "monospace",
    marginTop: 10,
  },
});
