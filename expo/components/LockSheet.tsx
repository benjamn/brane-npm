/**
 * The lock sheet (docs/passkeys.md, "What the browser side must do" #5): a
 * sheet over the app, never a route, so the screen underneath keeps its
 * state. It opens when the daemon's verification gate refuses this device
 * and closes when the proof lands; the store behind it is
 * `expo/lib/verification.ts`.
 *
 * The Verify button opens the ceremony page on the daemon's own origin, in
 * a new window when the browser allows one. It is enabled only once the
 * approval is in hand, so the tap opens the window at once. When no
 * credential can verify on this daemon (`lockedOut`: every one orphaned by
 * a rename, or the last revoked) there is no Verify: the sheet says what
 * to do from the daemon's shell.
 */

import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { dismiss, hop, retry, useLockState } from "@/lib/verification";

export default function LockSheet() {
  const s = useLockState();
  if (s.phase === "closed") return null;
  const fresh = s.kind === "fresh";
  return (
    <Modal visible transparent animationType="fade" onRequestClose={dismiss}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>{fresh ? "Verify again to continue" : "Verify to continue"}</Text>
          <Text style={styles.body}>
            {fresh
              ? "This act adds a device, a credential or an agent, so it needs a proof from the last minute: Face ID, Touch ID or your security key."
              : "brane needs Face ID, Touch ID or your security key before this device acts."}
          </Text>
          {s.lockedOut ? (
            <Text style={styles.error}>{s.lockedOut}</Text>
          ) : s.phase === "hopping" ? (
            <Text style={styles.note}>
              Finish on the page that opened, then come back here. This closes by itself once it worked.
            </Text>
          ) : (
            <Text style={styles.note}>It opens on your daemon's own page{s.host ? ` (${s.host})` : ""}, then comes back here.</Text>
          )}
          {s.phase === "error" && <Text style={styles.error}>{s.error}</Text>}
          <View style={styles.buttonRow}>
            <Pressable style={[styles.button, styles.cancelButton]} role="button" onPress={dismiss}>
              <Text style={styles.cancelText}>Not now</Text>
            </Pressable>
            {s.lockedOut ? null : s.phase === "error" ? (
              <Pressable style={[styles.button, styles.confirmButton]} role="button" onPress={retry}>
                <Text style={styles.confirmText}>Try again</Text>
              </Pressable>
            ) : s.phase === "hopping" ? (
              <Pressable style={[styles.button, styles.confirmButton]} role="button" onPress={retry}>
                <Text style={styles.confirmText}>Open again</Text>
              </Pressable>
            ) : (
              <Pressable
                style={[styles.button, styles.confirmButton, s.phase !== "ready" && styles.disabled]}
                disabled={s.phase !== "ready"}
                role="button"
                aria-label="Verify"
                aria-busy={s.phase !== "ready"}
                onPress={hop}
              >
                {s.phase === "ready" ? <Text style={styles.confirmText}>Verify</Text> : <ActivityIndicator color="#fff" size="small" />}
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  card: {
    backgroundColor: "#1e1e1e",
    borderRadius: 12,
    padding: 22,
    width: "100%",
    maxWidth: 360,
  },
  title: {
    color: "#e0e0e0",
    fontSize: 17,
    fontWeight: "600",
    marginBottom: 10,
    textAlign: "center",
  },
  body: {
    color: "#bbb",
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 10,
    textAlign: "center",
  },
  note: {
    color: "#888",
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 16,
    textAlign: "center",
  },
  error: {
    color: "#ef9a9a",
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 14,
    textAlign: "center",
  },
  buttonRow: {
    flexDirection: "row",
    gap: 10,
  },
  button: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: "center",
    minHeight: 38,
    justifyContent: "center",
  },
  cancelButton: {
    backgroundColor: "#2a2a2a",
  },
  cancelText: {
    color: "#ccc",
    fontSize: 14,
  },
  confirmButton: {
    backgroundColor: "#2e7d32",
  },
  confirmText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
  disabled: {
    opacity: 0.6,
  },
});
