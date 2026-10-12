import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, Text, View, StyleSheet } from "react-native";
import QRCode from "react-qr-code";
import { mintDeviceToken, type ConnectionParams } from "@/lib/api";
import CopyButton from "@/components/CopyButton";
import { buildMeldUrl } from "@shared/view-url";

interface QrModalProps {
  visible: boolean;
  conn: ConnectionParams | null;
  // Path including leading slash, e.g. "/claude-abc123". When opening from a
  // narrative detail screen, pass the current pathname so the scanned URL
  // lands on the same narrative.
  path: string;
  // Live view state from `viewParams`, so the scanning device opens on the tab
  // and file you are looking at rather than the default view.
  view?: Record<string, string | undefined>;
  onClose: () => void;
}

type Reach =
  | { kind: "tailnet"; hostname: string }       // *.ts.net — safe by tailnet membership
  | { kind: "loopback"; hostname: string }      // 127.0.0.1 etc. — useful only on this machine
  | { kind: "open"; hostname: string };         // LAN IP or anything else — token is the only gate

function classifyHost(host: string): Reach {
  const hostname = host.split(":")[0]?.toLowerCase() ?? "";
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "0.0.0.0"
  ) {
    return { kind: "loopback", hostname };
  }
  if (hostname.endsWith(".ts.net")) return { kind: "tailnet", hostname };
  return { kind: "open", hostname };
}

// Build the meld URL from current connection params, a target path, and the
// view being looked at. Mirrors `brane meld`: either this same shared app
// (when the operator is on one, whichever host serves it) or a direct daemon
// URL otherwise — buildMeldUrl keeps the origin kind, since the QR is aimed
// at another device, not another origin.
//
// The daemon's host comes from the active connection, not from
// window.location, because the URL-clean step in _layout.tsx strips it after
// registration; the token is one minted for the scanning device (see
// `useMintedToken`). Everything else in the query string does come from
// window.location, so an unmodelled param like scrollToSeq crosses too.
function buildUrl(
  conn: ConnectionParams,
  path: string,
  view: Record<string, string | undefined>,
): string {
  if (typeof window === "undefined") return "";
  return buildMeldUrl({
    host: window.location.host,
    protocol: window.location.protocol,
    search: window.location.search,
    path,
    conn,
    view,
  });
}

type Minted =
  | { state: "minting" }
  | { state: "minted"; token: string; validForMs?: number }
  // A daemon from before hashing: no mint route, one shared token.
  | { state: "legacy" }
  | { state: "failed"; error: string };

// A token of its own for the device about to scan, minted each time the sheet
// opens and dropped when it closes, so the device showing the QR never hands
// over its own token and the new one can be revoked alone. A failed mint shows
// no QR rather than falling back to this device's token, which would quietly
// undo the point; only a daemon too old to mint gets the shared token.
// A minted token lapses if nobody uses it within `validForMs`, so a sheet
// left open mints a fresh one a minute before then: the code on screen is
// always one that still works.
function useMintedToken(visible: boolean, conn: ConnectionParams | null): Minted | null {
  const [minted, setMinted] = useState<Minted | null>(null);
  const [generation, setGeneration] = useState(0);
  const host = conn?.host;
  const token = conn?.token;
  useEffect(() => {
    if (!visible || host === undefined || token === undefined) {
      setMinted(null);
      setGeneration(0);
      return;
    }
    let cancelled = false;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    // Keep showing the current code while its replacement is minted.
    if (generation === 0) setMinted({ state: "minting" });
    mintDeviceToken({ host, token }).then(
      (fresh) => {
        if (cancelled) return;
        if (fresh === null) {
          setMinted({ state: "legacy" });
          return;
        }
        setMinted({ state: "minted", token: fresh.token, validForMs: fresh.validForMs });
        if (fresh.validForMs !== undefined) {
          refresh = setTimeout(() => setGeneration((g) => g + 1), Math.max(fresh.validForMs - 60_000, 30_000));
        }
      },
      (err) => {
        if (!cancelled) setMinted({ state: "failed", error: (err as Error).message });
      },
    );
    return () => {
      cancelled = true;
      if (refresh !== undefined) clearTimeout(refresh);
    };
  }, [visible, host, token, generation]);
  return minted;
}

export default function QrModal({ visible, conn, path, view, onClose }: QrModalProps) {
  const minted = useMintedToken(visible, conn);
  const shared =
    minted?.state === "minted" ? minted.token :
    minted?.state === "legacy" ? conn?.token :
    undefined;
  const url = visible && conn && shared !== undefined
    ? buildUrl({ host: conn.host, token: shared }, path, view ?? {})
    : null;
  const reach = conn ? classifyHost(conn.host) : null;
  const showQr = url !== null && reach?.kind !== "loopback";
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>Meld another device</Text>
          {minted?.state === "minting" && (
            <ActivityIndicator style={styles.minting} color="#9ad6b3" />
          )}
          {minted?.state === "failed" && (
            <Text style={styles.warning}>
              Couldn't mint a token for the new device: {minted.error}
            </Text>
          )}
          {showQr && (
            <View style={styles.qrWrap}>
              {/* react-qr-code emits SVG; safe to nest inside RN Web View */}
              <QRCode value={url!} size={232} />
            </View>
          )}
          {reach?.kind === "loopback" && (
            <Text style={styles.warning}>
              {reach.hostname} only works on this machine. Run `brane certify`
              and reconnect over Tailscale to share.
            </Text>
          )}
          {/* The whole URL, never clamped: it carries the token, and a URL
              with its tail cut off is one you can't check or retype. */}
          {url && (
            <View style={styles.urlRow}>
              <Text style={styles.url} selectable>
                {url}
              </Text>
              <View style={styles.urlCopy}>
                <CopyButton text={url} size={13} padding={4} />
              </View>
            </View>
          )}
          {minted?.state === "minted" && (
            <Text style={styles.note}>
              This code carries a new token of its own, not this device's.
              {minted.validForMs !== undefined &&
                ` Unscanned, it lapses after ${Math.round(minted.validForMs / 60_000)} minutes; this sheet replaces it before then.`}
            </Text>
          )}
          {minted?.state === "legacy" && (
            <Text style={styles.warning}>
              This daemon predates per-device tokens, so the code carries this
              device's own token.
            </Text>
          )}
          {reach?.kind === "tailnet" && (
            <Text style={styles.note}>
              Safe to display — {reach.hostname} only resolves inside your tailnet.
            </Text>
          )}
          {reach?.kind === "open" && (
            <Text style={styles.warning}>
              {reach.hostname} isn't a Tailscale hostname — token is the only
              gate. Don't display in public.
            </Text>
          )}
          <Pressable style={styles.close} onPress={onClose}>
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// Wide enough for the 13px 📋 plus its 4px padding on each side.
const URL_GUTTER = 26;

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
    padding: 20,
    width: "100%",
    maxWidth: 320,
    alignItems: "center",
  },
  title: {
    color: "#e0e0e0",
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 16,
    textAlign: "center",
  },
  minting: {
    marginVertical: 24,
  },
  qrWrap: {
    backgroundColor: "#fff",
    padding: 12,
    borderRadius: 8,
  },
  // Equal gutters on both sides keep the URL block on the QR's center line;
  // the 📋 lives in the right one, out of the flow, so it can't push the
  // text off-center the way a flex sibling would.
  urlRow: {
    alignSelf: "stretch",
    marginTop: 14,
    paddingHorizontal: URL_GUTTER,
  },
  urlCopy: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    width: URL_GUTTER,
    alignItems: "center",
    justifyContent: "center",
  },
  // A URL has no spaces to wrap at, so without break-all it overflows the
  // card instead of wrapping. Centered, so the slack a monospace line leaves
  // at the end is split evenly rather than all landing on the right.
  url: {
    color: "#9ad6b3",
    fontSize: 11,
    fontFamily: "monospace",
    textAlign: "center",
    wordBreak: "break-all",
  } as any,
  note: {
    color: "#9ad6b3",
    fontSize: 12,
    marginTop: 12,
    textAlign: "center",
    lineHeight: 17,
  },
  warning: {
    color: "#e0a04e",
    fontSize: 13,
    marginVertical: 8,
    textAlign: "center",
    lineHeight: 18,
  },
  close: {
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: "#2a2a2a",
  },
  closeText: {
    color: "#ccc",
    fontSize: 14,
  },
});
