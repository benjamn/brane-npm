import { Modal, Pressable, Text, View, StyleSheet } from "react-native";
import type { DaemonStatus } from "@/lib/api";
import { LOOPBACK } from "@shared/tailnet";

export interface MeldConfirmInfo {
  status: DaemonStatus;
  host: string;
  // Whether this brane_id was already in the registry (token rotation case).
  isUpdate: boolean;
  /** This browser holds no daemon at all yet, or this meld picks the one
   *  tailnet it will accept from then on (src/shared/tailnet.ts). That is the
   *  one meld the rule can't screen, so it gets a warning: a stranger's link
   *  opened here is the whole attack. */
  firstMeld?: boolean;
  /** The trust domain the link's host belongs to (`tail1234.ts.net`). */
  domain?: string;
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
  if (pending?.firstMeld) {
    return <FirstMeld pending={pending} id={id} onConfirm={onConfirm} onCancel={onCancel} />;
  }
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <Pressable style={styles.backdrop} onPress={onCancel} tabIndex={-1}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()} tabIndex={-1}>
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
              role="button"
              onPress={onCancel}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.button, styles.confirmButton]}
              role="button"
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

/** The first meld in a browser: the routine card's details, under a warning
 *  that says who should be pressing the button. Everything it names about
 *  the daemon except the address is what the daemon says about itself. */
function FirstMeld({
  pending,
  id,
  onConfirm,
  onCancel,
}: {
  pending: MeldConfirmInfo;
  id: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // A loopback daemon decides nothing (src/shared/tailnet.ts), so its card
  // promises nothing about what comes after.
  const where = pending.domain && pending.domain !== LOOPBACK ? pending.domain : null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel} tabIndex={-1}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()} tabIndex={-1}>
          <Text style={styles.title}>Connect this browser to brane?</Text>
          <View style={styles.warning}>
            <Text style={styles.warningText}>
              Only continue if you installed brane yourself and just ran{" "}
              <Text style={styles.warningCode}>brane meld</Text> on your own machine. If someone
              sent you this link, cancel: whoever runs that daemon could be trying to trick you.
            </Text>
          </View>
          {where && (
            <Text style={styles.body}>
              This browser will then accept daemons on {where} only. Using a daemon elsewhere takes
              another browser, or removing this one's daemons first.
            </Text>
          )}
          {pending.isUpdate && (
            <Text style={styles.body}>
              It replaces the daemon this browser already holds for the same brane.
            </Text>
          )}
          <View style={styles.detailsBlock}>
            <DetailRow label="Daemon" value={id} />
            <DetailRow label="Address" value={pending.host} />
            <DetailRow label="Brane" value={pending.status.brane_id} mono />
          </View>
          <View style={styles.buttonRow}>
            <Pressable style={[styles.button, styles.cancelButton]} role="button" onPress={onCancel}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable style={[styles.button, styles.cautionButton]} role="button" onPress={onConfirm}>
              <Text style={styles.confirmText}>I asked for this</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export interface MeldRefusal {
  /** The address the link (or the add-daemon form) named. */
  host: string;
  message: string;
}

/** The meld that was refused before anything was sent to its host: the
 *  daemon is on another tailnet than this browser's (src/shared/tailnet.ts).
 *  There is nothing to confirm, so there is one button. */
export function MeldRefusedModal({
  refusal,
  onClose,
}: {
  refusal: MeldRefusal | null;
  onClose: () => void;
}) {
  return (
    <Modal visible={refusal !== null} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} tabIndex={-1}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()} tabIndex={-1}>
          <Text style={styles.title}>Not this browser's tailnet</Text>
          <Text style={styles.body}>{refusal?.message ?? ""}</Text>
          <View style={styles.detailsBlock}>
            <DetailRow label="Address" value={refusal?.host ?? ""} />
          </View>
          <View style={styles.buttonRow}>
            <Pressable style={[styles.button, styles.cancelButton]} role="button" onPress={onClose}>
              <Text style={styles.cancelText}>Close</Text>
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
  cautionButton: {
    backgroundColor: "#a65f2a",
  },
  warning: {
    backgroundColor: "#3a2a1a",
    borderColor: "#a65f2a",
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  warningText: {
    color: "#f0c8a0",
    fontSize: 13,
    lineHeight: 19,
  },
  warningCode: {
    fontFamily: "monospace",
    color: "#ffe0c0",
  },
  confirmText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
});
