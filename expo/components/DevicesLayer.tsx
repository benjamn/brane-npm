/**
 * The Devices layer of the brane switcher: every live token on the active
 * daemon, one row per melded device plus this machine's CLI, with a Revoke
 * on each other device. A modal layer over the switcher like the add-daemon
 * form and the sign-out confirm (see `BraneSwitcher` in app/index.tsx), so
 * its backdrop, its ✕ and the back gesture dismiss this layer only. Its
 * card is the switchers' card (CARD_* in lib/pointer.ts): the ✕ in the
 * title row, and the rarely used footer at the end of the scroll.
 *
 * Revoking is per row and confirmed in place: the row's button turns into
 * "Revoke?" and a second tap does it. The revoked device's sockets are closed
 * with 4401 by the daemon, so it shows "signed out" at once.
 *
 * Below the devices, the operator's passkeys and security keys
 * (`CredentialsSection`): what verifies any of them once the gate is on.
 *
 * "Sign out other devices" lives at the foot of this list rather than beside
 * it in the switcher: it is the same job done wholesale, and the list above
 * it shows what it is about to take. Its confirm is the switcher's own layer,
 * which stacks over this one.
 */

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { listDeviceTokens, revokeDeviceToken, type ConnectionParams, type DeviceToken } from "@/lib/api";
import { relPart } from "@shared/narrative-format";
import { originHost } from "@shared/app-origin";
import { proofName } from "@shared/verification-hop";
import CredentialsSection from "./CredentialsSection";
import { FINE_POINTER, CARD_TITLE_LINE, CARD_TITLE_GAP, CARD_SIDE_PAD, CARD_CLOSE_INSET } from "@/lib/pointer";

function ago(ms: number): string {
  const p = relPart(ms);
  return p.ago ? `${p.val} ago` : p.val;
}

/** What a row is called: this machine, or the device it was first seen as.
 *  Never the label: whoever holds a token chooses its label (and its
 *  User-Agent), so a label as a title would let a copied token pass itself
 *  off as "This machine's CLI". The label is shown beneath, quoted. */
function rowTitle(t: DeviceToken): string {
  if (t.kind === "local") return "This machine's CLI";
  // A narrative's token is named by its narrative, whatever its kind says.
  if (t.owner_nid) return `Agent ${t.owner_nid}`;
  if (t.kind === "agent") return `Agent ${t.label}`;
  if (t.unused) return "Meld QR not scanned yet";
  // Never "Unknown device": a row nobody has named by browser is still
  // somewhere, and where it was seen is the next best name.
  if (t.device) return t.device;
  return t.remote_addr ? `Device at ${t.remote_addr}` : "Device not seen yet";
}

/** "4 min" until a verified window ends. */
function minutesLeft(until: number): string {
  return `${Math.max(1, Math.ceil((until - Date.now()) / 60_000))} min`;
}

function rowDetail(t: DeviceToken, gated: boolean): string {
  const added = `${t.kind === "agent" ? "started" : "added"} ${ago(t.created_at)}${t.minted_by_device ? ` by ${t.minted_by_device}` : ""}`;
  if (t.unused) {
    if (t.expires_at === null) return added;
    const min = Math.max(1, Math.ceil((t.expires_at - Date.now()) / 60_000));
    return `lapses in ${min} min · ${added}`;
  }
  const seen = t.connected ? "connected now" : t.last_used_at !== null ? `seen ${ago(t.last_used_at)}` : "never used";
  const parts = [seen];
  // Under the verification gate: what last proved the operator on this
  // device, and whether that window is still open (docs/passkeys.md, "The
  // record"). With the gate off a device is never verified, so nothing is
  // said; with it on, a device that never has is said to be.
  if (t.verified) {
    const name = proofName(t.verified);
    parts.push(t.verified.until !== null ? `verified with ${name}, ${minutesLeft(t.verified.until)} left` : `verified ${ago(t.verified.at)} with ${name}`);
  } else if (gated && t.kind === "device") {
    parts.push("never verified");
  }
  if (t.remote_addr) parts.push(t.remote_addr);
  // Which copy of the app the device runs: the hosted shell, a staging or
  // fork hostname, or a daemon's own bundle. A label, never a gate.
  if (t.app_origin) parts.push(`via ${originHost(t.app_origin)}`);
  parts.push(added);
  return parts.join(" · ");
}

/** A token last presented from somewhere other than where it was first seen:
 *  a copy, or the same device on another network. Worth a line either way. */
function elsewhereNote(t: DeviceToken): string | null {
  if (t.elsewhere_at === null) return null;
  const where = [t.last_device, t.last_remote_addr].filter(Boolean).join(" at ");
  return `Also used from another address${where ? ` (latest: ${where})` : ""}, ${ago(t.elsewhere_at)}`;
}

export default function DevicesLayer({
  visible,
  conn,
  daemonName,
  onClose,
  onSignOutOthers,
  signedOutOthers,
  connected,
}: {
  visible: boolean;
  conn: ConnectionParams | null;
  daemonName: string;
  onClose: () => void;
  /** Open the "Sign out other devices?" confirm over this layer. */
  onSignOutOthers: () => void;
  /** A rotation from this device has completed since the switcher opened. */
  signedOutOthers: boolean;
  connected: boolean;
}) {
  const [tokens, setTokens] = useState<DeviceToken[] | null>(null);
  const [gated, setGated] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  // The devices to take with the one being revoked: every device it added,
  // checked by default, since a spare minted by a stolen token is exactly
  // what a revoke has to reach, and an unchecked laptop is one tap away.
  const [also, setAlso] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!conn) return;
    setError(null);
    try {
      const list = await listDeviceTokens(conn);
      setUnsupported(list === null);
      setTokens(list?.tokens ?? []);
      setGated(list?.gated ?? false);
    } catch (err) {
      setError(String(err));
    }
  }, [conn]);

  useEffect(() => {
    if (!visible) {
      setConfirming(null);
      return;
    }
    setTokens(null);
    void load();
    // A rotation from this device needs no trigger of its own: it replaces
    // this device's token, so `conn` (and with it `load`) changes and the
    // list is re-read under the new one. Reloading any earlier would ask
    // with the token that was just retired.
  }, [visible, load]);

  const revoke = async (t: DeviceToken) => {
    if (!conn) return;
    if (confirming !== t.id) {
      setConfirming(t.id);
      setAlso(new Set(t.descendants));
      return;
    }
    setRevoking(t.id);
    setError(null);
    try {
      await revokeDeviceToken(conn, t.id, t.descendants.filter((d) => also.has(d)));
      setConfirming(null);
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setRevoking(null);
    }
  };

  const close = () => {
    if (revoking) return;
    onClose();
  };

  const byId = new Map((tokens ?? []).map((t) => [t.id, t]));

  // This device first, then this machine, then the rest by last seen.
  const sorted = [...(tokens ?? [])].sort((a, b) => {
    const rank = (t: DeviceToken) => (t.current ? 0 : t.kind === "local" ? 1 : t.kind === "device" ? 2 : 3);
    return rank(a) - rank(b) || (b.last_used_at ?? b.created_at) - (a.last_used_at ?? a.created_at);
  });

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <Pressable style={styles.overlay} onPress={close} tabIndex={-1}>
        <Pressable style={[styles.card, FINE_POINTER && styles.cardTall]} onPress={(e) => e.stopPropagation()} tabIndex={-1}>
          <View style={styles.titleRow}>
            <Text style={styles.title} numberOfLines={1}>Devices on {daemonName}</Text>
            <Pressable
              style={[styles.close, revoking !== null && { opacity: 0.5 }]}
              role="button"
              aria-label="Close"
              onPress={close}
              disabled={revoking !== null}
            >
              <Text style={styles.closeText}>✕</Text>
            </Pressable>
          </View>
          {error && <Text style={styles.error}>{error}</Text>}
          <ScrollView style={styles.list}>
          {tokens === null && !error ? (
            <ActivityIndicator style={{ marginVertical: 16 }} color="#aaa" />
          ) : unsupported ? (
            <Text style={styles.body}>This daemon is older than the Devices list. Update brane on it to see and revoke devices.</Text>
          ) : (
            <>
              {sorted.map((t) => (
                <View key={t.id} style={styles.rowWrap}>
                <View style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {rowTitle(t)}
                      {t.current ? <Text style={styles.thisDevice}>  this device</Text> : null}
                    </Text>
                    <Text style={styles.rowDetail}>{rowDetail(t, gated)}</Text>
                    {t.kind === "device" && <Text style={styles.rowLabel}>"{t.label}"</Text>}
                    {elsewhereNote(t) && <Text style={styles.rowWarn}>{elsewhereNote(t)}</Text>}
                    {t.origin === "adopted" && t.kind === "device" && (
                      <Text style={styles.rowWarn}>From before tokens were hashed; may have been logged</Text>
                    )}
                    {t.origin === "adopted" && t.kind === "agent" && (
                      <Text style={styles.rowLabel}>Kept from before agents had their own tokens; replaced when it is next revived</Text>
                    )}
                  </View>
                  {t.kind !== "local" && !t.current && (
                    <Pressable
                      style={[styles.revoke, confirming === t.id && styles.revokeConfirm, revoking !== null && { opacity: 0.5 }]}
                      onPress={() => revoke(t)}
                      role="button"
                      aria-busy={revoking === t.id}
                      disabled={revoking !== null}
                    >
                      {revoking === t.id ? (
                        <ActivityIndicator size="small" color="#111" />
                      ) : (
                        <Text style={[styles.revokeText, confirming === t.id && styles.revokeConfirmText]}>
                          {confirming === t.id ? "Revoke?" : "Revoke"}
                        </Text>
                      )}
                    </Pressable>
                  )}
                </View>
                {confirming === t.id && (
                  <CascadePanel
                    token={t}
                    byId={byId}
                    also={also}
                    onToggle={(id) =>
                      setAlso((prev) => {
                        const next = new Set(prev);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        return next;
                      })
                    }
                  />
                )}
                </View>
              ))}
              <CredentialsSection conn={conn} visible={visible} />
            </>
          )}
          {/* The wholesale sign-out, last in the scroll as the picker's Add
              Daemon and Devices are: the rows get the height. */}
          <Text style={styles.footnote}>
            A revoked device is signed out until it scans a fresh Meld QR. To keep only this device:
          </Text>
          <Pressable
            style={[styles.signOut, (!connected || revoking !== null) && { opacity: 0.5 }]}
            onPress={onSignOutOthers}
            role="button"
            disabled={!connected || revoking !== null}
          >
            <Text style={styles.signOutText}>
              {signedOutOthers ? "Other devices signed out" : "Sign out other devices"}
            </Text>
          </Pressable>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** What revoking `token` would also touch: the devices it added, each
 *  checkable, and the agents it started, listed so the operator knows. An
 *  agent's token is a row of its own (docs/token-rotation.md, "Agent
 *  tokens"); a revoke never touches its tmux session. */
function CascadePanel({
  token,
  byId,
  also,
  onToggle,
}: {
  token: DeviceToken;
  byId: Map<string, DeviceToken>;
  also: Set<string>;
  onToggle: (id: string) => void;
}) {
  const agents = [token, ...token.descendants.map((d) => byId.get(d)).filter((d): d is DeviceToken => !!d)]
    .flatMap((t) => t.agents)
    .filter((a) => a.status !== "ended");
  const isAgent = token.kind === "agent";
  if (token.descendants.length === 0 && agents.length === 0 && !isAgent) return null;
  return (
    <View style={styles.cascade}>
      {isAgent && (
        // Revive answers "already running" for a live session and can't hand
        // a running process a new token, so this is the one way back.
        <Text style={styles.cascadeNote}>
          This cuts {token.owner_nid ?? "the agent"} off from brane at once; its session keeps running without
          tools. To bring it back, end its session and revive it.
        </Text>
      )}
      {token.descendants.length > 0 && (
        <Text style={styles.cascadeHead}>
          Also revoke {token.descendants.length === 1 ? "the device or agent" : `the ${token.descendants.length} devices and agents`} it added:
        </Text>
      )}
      {token.descendants.map((id) => {
        const d = byId.get(id);
        const checked = also.has(id);
        return (
          <Pressable key={id} style={styles.cascadeRow} role="checkbox" aria-checked={checked} onPress={() => onToggle(id)}>
            <Text style={[styles.checkbox, checked && styles.checkboxOn]}>{checked ? "☑" : "☐"}</Text>
            <Text style={styles.cascadeText} numberOfLines={2}>
              {d ? `${rowTitle(d)} · ${rowDetail(d, false)}` : id}
            </Text>
          </Pressable>
        );
      })}
      {agents.length > 0 && (
        <Text style={styles.cascadeNote}>
          Started {agents.length === 1 ? "1 running agent" : `${agents.length} running agents`}:{" "}
          {agents.map((a) => a.id).join(", ")}. Their sessions keep running; revoking their tokens cuts off their brane tools.
        </Text>
      )}
    </View>
  );
}

// The switchers' card (`modalContent` in app/index.tsx, `switcherContent`
// in app/[nid].tsx): their geometry, edge, ✕ and height caps.
const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", alignItems: "center", padding: 24 },
  card: {
    backgroundColor: "#1e1e22",
    borderRadius: 12,
    paddingTop: CARD_TITLE_GAP,
    paddingHorizontal: CARD_SIDE_PAD,
    paddingBottom: CARD_SIDE_PAD,
    width: "100%",
    maxWidth: 420,
    // On a touch screen, backdrop above and below to tap away on.
    maxHeight: "80%",
    borderWidth: 1,
    borderColor: "#3a3a40",
  },
  cardTall: { maxHeight: "100%" },
  titleRow: { flexDirection: "row", alignItems: "center", marginBottom: CARD_TITLE_GAP },
  title: { flex: 1, color: "#d8d8dd", fontSize: 18, lineHeight: CARD_TITLE_LINE, fontWeight: "600" },
  // As the switchers' ✕: a square as tall as the title's line, reaching
  // into the side padding so it is as far from the right edge as the top.
  close: {
    width: CARD_TITLE_LINE,
    height: CARD_TITLE_LINE,
    marginLeft: 12,
    marginRight: -CARD_CLOSE_INSET,
    alignItems: "center",
    justifyContent: "center",
  },
  closeText: { color: "#888", fontSize: 16, lineHeight: 16 },
  body: { color: "#999", fontSize: 13, lineHeight: 18 },
  list: { flexGrow: 0 },
  rowWrap: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#3a3a40", paddingVertical: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  cascade: { marginTop: 8, padding: 10, borderRadius: 8, backgroundColor: "#26262b", gap: 6 },
  cascadeHead: { color: "#d8d8dd", fontSize: 13 },
  cascadeRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  checkbox: { color: "#777", fontSize: 16, lineHeight: 18 },
  checkboxOn: { color: "#e0a070" },
  cascadeText: { color: "#aaa", fontSize: 12, flex: 1, lineHeight: 18 },
  cascadeNote: { color: "#888", fontSize: 12, lineHeight: 16 },
  rowTitle: { color: "#d8d8dd", fontSize: 14 },
  thisDevice: { color: "#66d9a0", fontSize: 12 },
  rowDetail: { color: "#777", fontSize: 12, fontFamily: "monospace", marginTop: 2 },
  rowLabel: { color: "#666", fontSize: 12, marginTop: 2 },
  rowWarn: { color: "#e0a070", fontSize: 12, marginTop: 2 },
  revoke: { backgroundColor: "#2a2a30", borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12, minWidth: 76, alignItems: "center" },
  revokeConfirm: { backgroundColor: "#e0a070" },
  revokeText: { color: "#e0a070", fontSize: 13, fontWeight: "600" },
  revokeConfirmText: { color: "#111" },
  error: { color: "#e07070", fontSize: 12, marginBottom: 8 },
  footnote: { color: "#666", fontSize: 12, lineHeight: 16, marginTop: 12 },
  signOut: { backgroundColor: "#2a2a30", borderRadius: 8, paddingVertical: 10, alignItems: "center", marginTop: 8 },
  signOutText: { color: "#e0a070", fontSize: 14, fontWeight: "600" },
});
