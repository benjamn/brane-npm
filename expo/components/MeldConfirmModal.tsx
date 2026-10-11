import { Modal, Pressable, Text, View, StyleSheet } from "react-native";
import type { DaemonStatus } from "@/lib/api";

export interface MeldConfirmInfo {
  status: DaemonStatus;
  host: string;
  // Whether this brane_id was already in the registry (token rotation case).
  isUpdate: boolean;
}

interface MeldConfirmModalProps {
  pending: MeldConfirmInfo | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function MeldConfirmModal({
  pending,
  onConfirm,
  onCancel,
}: MeldConfirmModalProps) {
  const visible = pending !== null;
  const id = pending ? `${pending.status.username}@${pending.status.hostname}` : "";
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>
            {pending?.isUpdate ? "Update credentials?" : "Meld this device?"}
          </Text>
          {pending?.isUpdate ? (
            <Text style={styles.body}>
              You're already paired with this brane. The meld URL has a new
              token — replace the stored one?
            </Text>
          ) : (
            <Text style={styles.body}>
              You'll add this daemon to this device and switch to it.
            </Text>
          )}
          <View style={styles.detailsBlock}>
            <DetailRow label="Daemon" value={id} />
            <DetailRow label="Address" value={pending?.host ?? ""} />
            <DetailRow label="Brane" value={pending?.status.brane_id ?? ""} mono />
          </View>
          <View style={styles.buttonRow}>
            <Pressable
              style={[styles.button, styles.cancelButton]}
              onPress={onCancel}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.button, styles.confirmButton]}
              onPress={onConfirm}
            >
              <Text style={styles.confirmText}>
                {pending?.isUpdate ? "Update" : "Meld"}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, mono && styles.detailValueMono]} numberOfLines={1} selectable>
        {value}
      </Text>
    </View>
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
    marginBottom: 14,
    textAlign: "center",
  },
  detailsBlock: {
    backgroundColor: "#2a2a2a",
    borderRadius: 8,
    padding: 12,
    marginBottom: 18,
  },
  detailRow: {
    flexDirection: "row",
    paddingVertical: 3,
  },
  detailLabel: {
    color: "#888",
    fontSize: 12,
    width: 70,
  },
  detailValue: {
    color: "#e0e0e0",
    fontSize: 12,
    flex: 1,
  },
  detailValueMono: {
    fontFamily: "monospace",
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
});
