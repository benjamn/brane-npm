/**
 * The Devices layer's credentials: the operator's enrolled passkeys and
 * security keys, any of which verifies any device (docs/passkeys.md, "Many
 * credentials, one operator"), with enrollment and revoke.
 *
 * Enrolling runs on the daemon's own page, the only origin its credentials
 * answer on, so it is two taps: the first asks the daemon for an approval
 * (an act: with the gate on, the lock sheet may ask for a fresh proof
 * first), the second opens the page, synchronously, so no browser blocks
 * it as a popup.
 */

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { beginCeremony, listCredentials, revokeCredential, type ConnectionParams, type EnrolledCredential } from "@/lib/api";
import { relPart } from "@shared/narrative-format";
import { sameTabHopUrl } from "@shared/verification-hop";

function ago(ms: number): string {
  const p = relPart(ms);
  return p.ago ? `${p.val} ago` : p.val;
}

function detail(c: EnrolledCredential): string {
  const parts = [c.attested ? "hardware attested" : c.backup_eligible ? "synced passkey" : "device-bound"];
  parts.push(`added ${ago(c.enrolled_at)}`);
  parts.push(c.last_used_at ? `used ${ago(c.last_used_at)}` : "never used");
  return parts.join(" · ");
}

export default function CredentialsSection({ conn, visible }: { conn: ConnectionParams | null; visible: boolean }) {
  const [list, setList] = useState<EnrolledCredential[] | null>(null);
  // The host a credential must be enrolled for; one enrolled for another was
  // orphaned by a rename (docs/passkeys.md, "The rename warning").
  const [rpId, setRpId] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!conn) return;
    try {
      const l = await listCredentials(conn);
      setUnsupported(l === null);
      setList(l?.credentials ?? []);
      setRpId(l?.rp_id ?? null);
    } catch (err) {
      setError(String(err));
    }
  }, [conn]);

  useEffect(() => {
    if (!visible) {
      setPageUrl(null);
      setConfirming(null);
      return;
    }
    setError(null);
    void load();
    // Back from the enrollment page: show what it added.
    const onShow = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [visible, load]);

  const ask = async () => {
    if (!conn || asking) return;
    setAsking(true);
    setError(null);
    try {
      const r = await beginCeremony(conn, "enroll");
      setPageUrl(r.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  };

  const open = () => {
    if (!pageUrl) return;
    const target = pageUrl;
    // The approval is single-use: the next enrollment asks for another.
    setPageUrl(null);
    const w = window.open(target, "_blank");
    if (w) {
      try {
        w.opener = null;
      } catch {}
      return;
    }
    window.location.assign(sameTabHopUrl(target, window.location.href));
  };

  const revoke = async (c: EnrolledCredential) => {
    if (!conn) return;
    if (confirming !== c.id) {
      setConfirming(c.id);
      return;
    }
    setRevoking(c.id);
    setError(null);
    try {
      await revokeCredential(conn, c.id);
      setConfirming(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevoking(null);
    }
  };

  if (unsupported) return null;
  const onlyDeviceBound = list !== null && list.length > 0 && list.every((c) => !c.backup_eligible);

  return (
    <View style={styles.section}>
      <Text style={styles.head}>Passkeys and security keys</Text>
      {list === null ? (
        <ActivityIndicator style={{ marginVertical: 8 }} color="#aaa" />
      ) : list.length === 0 ? (
        <Text style={styles.note}>
          None yet. Any one you add can verify any of your devices, once verification is switched on.
        </Text>
      ) : (
        list.map((c) => (
          <View key={c.id} style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle} numberOfLines={1}>{c.label}</Text>
              <Text style={styles.rowDetail}>{detail(c)}</Text>
              {rpId !== null && c.rp_id !== rpId && (
                <Text style={styles.warn}>
                  Enrolled for {c.rp_id}; this daemon is now {rpId}, so it cannot verify here. Add one on this host.
                </Text>
              )}
            </View>
            <Pressable
              style={[styles.revoke, confirming === c.id && styles.revokeConfirm, revoking !== null && { opacity: 0.5 }]}
              onPress={() => revoke(c)}
              role="button"
              aria-busy={revoking === c.id}
              disabled={revoking !== null}
            >
              {revoking === c.id ? (
                <ActivityIndicator size="small" color="#111" />
              ) : (
                <Text style={[styles.revokeText, confirming === c.id && styles.revokeConfirmText]}>
                  {confirming === c.id ? "Revoke?" : "Revoke"}
                </Text>
              )}
            </Pressable>
          </View>
        ))
      )}
      {onlyDeviceBound && (
        <Text style={styles.warn}>A security key is not synced: add a second credential as its backup.</Text>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      {pageUrl ? (
        <Pressable style={styles.add} role="button" onPress={open}>
          <Text style={styles.addText}>Open the enrollment page</Text>
        </Pressable>
      ) : (
        <Pressable style={[styles.add, (asking || !conn) && { opacity: 0.5 }]} role="button" aria-label="Add a passkey or security key" aria-busy={asking} onPress={ask} disabled={asking || !conn}>
          {asking ? <ActivityIndicator size="small" color="#66d9a0" /> : <Text style={styles.addText}>Add a passkey or security key</Text>}
        </Pressable>
      )}
      <Text style={styles.note}>
        A passkey is confirmed at the daemon's machine (Touch ID or its password) before it is added; a YubiKey vouches for
        itself. On iPhone, turn on Stolen Device Protection, so a passcode someone saw cannot stand in for Face ID.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 14, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#3a3a40", gap: 6 },
  head: { color: "#d8d8dd", fontSize: 14, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
  rowTitle: { color: "#d8d8dd", fontSize: 13 },
  rowDetail: { color: "#777", fontSize: 12, fontFamily: "monospace", marginTop: 2 },
  note: { color: "#666", fontSize: 12, lineHeight: 16 },
  warn: { color: "#e0a070", fontSize: 12, lineHeight: 16 },
  error: { color: "#e07070", fontSize: 12 },
  add: { backgroundColor: "#2a2a30", borderRadius: 8, paddingVertical: 10, alignItems: "center", marginTop: 4, minHeight: 38, justifyContent: "center" },
  addText: { color: "#66d9a0", fontSize: 14, fontWeight: "600" },
  revoke: { backgroundColor: "#2a2a30", borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12, minWidth: 76, alignItems: "center" },
  revokeConfirm: { backgroundColor: "#e0a070" },
  revokeText: { color: "#e0a070", fontSize: 13, fontWeight: "600" },
  revokeConfirmText: { color: "#111" },
});
