import { useEffect, useState, useRef, useCallback, useMemo, memo } from "react";
import {
  View,
  Text,
  Image,
  FlatList,
  TextInput,
  Pressable,
  Modal,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  type ViewStyle,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { useBrane } from "./_layout";
import {
  fetchEvents,
  fetchEventsBefore,
  fetchNarratives,
  fetchNarrative,
  fetchToolUse,
  archiveNarrative,
  sendSignal,
  payloadUrl,
  isInlinePayload,
  fetchAllToolUseWindow,
  fetchAllToolUsesSince,
  formatCost,
  type NarrativeEvent,
  type NarrativeInfo,
  type ConnectionParams,
  type ToolUse,
} from "@/lib/api";
import ToolUseGroup from "@/components/ToolUseGroup";
import TerminalPane, { type TerminalPaneHandle } from "@/components/TerminalPane";
import ContextMenu from "@/components/ContextMenu";
import { narrativeMenuItems, openNarrativeExport, revivesAsTwin } from "@/components/NarrativeMenu";
import type { ExportScope } from "@shared/narrative-menu";
import { isAwaiting, awaitingGlow, AWAITING_STATUS, NOT_AWAITING_STATUS } from "@shared/narrative-status";
import { MessageSelection, useIsSelected, useMessageSelection, useSelectedSeqs } from "@/lib/selection";
import { speakerColor, speakerBgColor } from "@shared/speaker-color";
import { readRecolorSalt, bumpRecolorSalt } from "@/lib/recolor";
import { glowHueFor, recolorGlowHue } from "@/lib/glow-hues";
import { NarrativeMetaLine, NarrativeIdentity } from "@/components/NarrativeMeta";
import QrModal from "@/components/QrModal";
import { MarkdownContent } from "@/components/Markdown";
import { narrativeHref, fileHref } from "@/lib/routes";
import { downloadUrl, downloadNameFor } from "@/lib/download";
import FilesView, { parseRelLink, type FilesViewHandle } from "@/components/FilesView";
import SpawnDialog from "@/components/SpawnDialog";
import CopyButton from "@/components/CopyButton";
import WikiReader, { type WikiTarget } from "@/components/WikiReader";
import { MarkdownLinksProvider } from "@/components/MarkdownLinks";
import { isSystemEvent, systemLine, agentTypeOf } from "@shared/narrative-format";
import { collectKnownNids } from "@shared/known-nids";
import { sortNarratives } from "@shared/narrative-sort";
// The view's URL contract — tab, pins, open file — lives in shared/ because it
// is what carries the view across the origin hop that Isolate performs, and
// because being window-free is what makes it testable. See view-url.ts.
import {
  type Tab,
  CANONICAL_TABS,
  parseActiveTab,
  parsePinnedTabs,
  serializePinned,
  viewParams,
  parseLineSpec,
  isIsolated,
  buildIsolateUrl,
  terminalOnlyHref,
} from "@shared/view-url";
import { useAppHost } from "@/lib/appHost";
import { visiblePanes, selectPane } from "@shared/pane-layout";

interface PendingPayload {
  id: string;
  filename: string;
  data: string; // base64 without prefix
  uri: string;  // data URI for preview
}

function formatTimestamp(ms: number, full = false): string {
  const d = new Date(ms);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dow = days[d.getDay()];
  const mon = months[d.getMonth()];
  const day = d.getDate();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (full) return `${dow} ${mon} ${day}, ${d.getFullYear()} ${time}`;
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const sameDay = sameYear && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return `${dow} ${time}`;
  if (sameYear) return `${dow} ${mon} ${day} ${time}`;
  return `${dow} ${mon} ${day}, ${d.getFullYear()} ${time}`;
}

function isOperator(type: string): boolean {
  return type === "human_signal";
}

function isForeign(type: string): boolean {
  return type === "agent_signal";
}

// isSystemEvent (daemon-written lifecycle events) comes from the shared module
// so the chat view and the HTML export agree on what counts as system.


// Foreign speaker hues come from `src/shared/speaker-color.ts`, salted per
// narrative by 🎨 Recolor (the `palette` prop below) so two speakers that hash
// to near-identical hues can be told apart.

// Reserved on every bubble so selecting one is a pure color change — see
// `styles.bubble`.
const SELECTION_BORDER_WIDTH = 1.5;

const THUMB_MAX_W = 200;
const THUMB_MAX_H = 150;

const PayloadThumbnail = memo(function PayloadThumbnail({
  uri,
  onPress,
}: {
  uri: string;
  onPress?: () => void;
}) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    Image.getSize(
      uri,
      (w, h) => setDims({ w, h }),
      () => setDims({ w: THUMB_MAX_W, h: THUMB_MAX_H }),
    );
  }, [uri]);

  const scale = dims
    ? Math.min(THUMB_MAX_W / dims.w, THUMB_MAX_H / dims.h)
    : 1;
  const width = dims ? Math.round(dims.w * scale) : THUMB_MAX_W;
  const height = dims ? Math.round(dims.h * scale) : THUMB_MAX_H;

  return (
    <Pressable onPress={onPress}>
      <Image
        source={{ uri }}
        style={{ width, height, borderRadius: 8 }}
        resizeMode="cover"
      />
    </Pressable>
  );
});

const MessageBubble = memo(function MessageBubble({ item, nid, agentType, foldPath, conn, selection, palette = 0, onImagePress, onForeignPress, onFilePress, fileHref, onTimestampPress }: { item: NarrativeEvent; nid: string; agentType?: string | null; foldPath?: string | null; conn: ConnectionParams | null; /** The chat's selection, which this bubble watches for its own seq and nothing else — so a tap elsewhere never re-renders it. */ selection: MessageSelection; /** The narrative's 🎨 Recolor salt; 0 is the default palette. */ palette?: number; onImagePress?: (uri: string) => void; onForeignPress?: (nid: string, time: number) => void; onFilePress?: (relativePath: string) => void; fileHref?: (relativePath: string) => string | undefined; onTimestampPress?: (seq: number) => void }) {
  // The one subscription that makes a tap local: this bubble re-renders when
  // *its* seq is selected or deselected, and at no other time.
  const selected = useIsSelected(selection, item.seq);
  const fromOperator = isOperator(item.type);
  const foreign = isForeign(item.type);
  const system = isSystemEvent(item.type);
  const imagePayloads = conn && item.payloads
    ? item.payloads.filter(isInlinePayload)
    : [];
  const filePayloads = conn && item.payloads
    ? item.payloads.filter((p) => !isInlinePayload(p))
    : [];

  const bubbleContent = (
    <>
      {/* Attribution header. Lifecycle events have no `source` — the daemon
          wrote them — so they name "system" explicitly rather than going
          anonymous, and otherwise sit in the same top-left slot as everyone
          else's. */}
      {(item.source || system) && (
        <View style={styles.bubbleSourceRow}>
          {/* A foreign speaker's nid is the way back to the narrative it was
              written in. It used to be the whole bubble, which made copying
              or scrolling the rendered markdown a navigation; now only the
              nid itself navigates, and the (nid:seq) beside it selects this
              event the way every other attribution does. */}
          {foreign && item.source && (
            <Pressable onPress={() => onForeignPress?.(item.source!, item.time)} style={styles.bubbleSourcePress}>
              <Text style={[styles.bubbleSource, styles.bubbleSourceLink, { color: speakerColor(item.source, palette) }]}>
                {item.source}
              </Text>
            </Pressable>
          )}
          <Pressable onPress={() => onTimestampPress?.(item.seq)} style={[styles.bubbleSourcePress, foreign && styles.bubbleSourceAfterLink]}>
            <Text style={[
              styles.bubbleSource,
              foreign && item.source && { color: speakerColor(item.source, palette) },
              system && styles.bubbleSourceSystem,
            ]}>
              {system
                ? `system (${nid}:${item.seq})`
                : fromOperator
                  ? `you (${nid}:${item.seq})`
                  : foreign
                    ? `(${nid}:${item.seq})`
                    : `${item.source}:${item.seq}`}
            </Text>
          </Pressable>
          {/* Foreign events show the speaker's nid in the label, but the event
              lives here — so the reference worth copying is always ours. */}
          <CopyButton text={`${nid}:${item.seq}`} size={9} padding={3} marginLeft={1} translateY={-1} />
        </View>
      )}
      {item.content ? (
        <MarkdownContent content={system ? systemLine({ type: item.type, content: item.content }, { agent: agentType ?? agentTypeOf(nid), fold: foldPath }) : item.content} foreign={foreign} system={system} onFilePress={onFilePress} fileHref={fileHref} />
      ) : null}
      {imagePayloads.length > 0 && conn && (
        <View style={styles.payloadsContainer}>
          {imagePayloads.map((path) => (
            <PayloadThumbnail
              key={path}
              uri={payloadUrl(conn, path)}
              onPress={() => onImagePress?.(payloadUrl(conn, path))}
            />
          ))}
        </View>
      )}
      {filePayloads.length > 0 && conn && (
        <View style={styles.payloadsContainer}>
          {filePayloads.map((path) => {
            const filename = downloadNameFor(path);
            const url = payloadUrl(conn, path);
            // Downloaded, never opened: the URL carries `?token=`, and a tab
            // navigated to it puts the token in the address bar and in the
            // base URL a "Save Page As" rewrites relative links against.
            return (
              <Pressable
                key={path}
                onPress={() => {
                  if (typeof window === "undefined") return;
                  downloadUrl(url, filename).catch((err) => console.error("Payload download failed:", err));
                }}
                style={styles.filePayload}
              >
                <Text style={styles.filePayloadText}>{filename}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
      <Pressable onPress={() => onTimestampPress?.(item.seq)} style={styles.bubbleTimePress}>
        <Text style={styles.bubbleTime}>
          {formatTimestamp(item.time)}
        </Text>
      </Pressable>
    </>
  );

  const bubbleStyle = [
    styles.bubble,
    system
      ? styles.bubbleSystem
      : fromOperator
        ? styles.bubbleOperator
        : foreign
          ? [styles.bubbleForeign, { backgroundColor: speakerBgColor(item.source || "unknown", palette) }]
          : styles.bubbleAgent,
    selected && styles.bubbleSelected,
  ];

  return (
    <View
      style={[
        styles.bubbleRow,
        fromOperator
          ? styles.bubbleRowRight
          : foreign || system
            ? styles.bubbleRowCenter
            : styles.bubbleRowLeft,
      ]}
    >
      {/* `data-bubble` marks the bubble's own box — not the full-width row —
          so the chat pane's click handler can tell a tap *on* a message from a
          tap in the negative space beside it. */}
      <View dataSet={{ bubble: String(item.seq) }} style={bubbleStyle}>
        {bubbleContent}
      </View>
    </View>
  );
});

// Isolated input bar — typing only re-renders this component, not the chat list
const InputBar = memo(function InputBar({
  conn,
  nid,
  loadEvents,
  chatActive,
  selection,
  onDeselect,
}: {
  conn: ConnectionParams | null;
  nid: string;
  loadEvents: () => Promise<void>;
  chatActive: boolean;
  // The chat's message selection. Subscribed to *here* rather than passed down
  // as an array: the seqs ride along as the `re` array of the next signal, and
  // the composer is one component, so waking it on a tap costs one render
  // instead of the screen's.
  selection: MessageSelection;
  // Drops the selection *and* its `?scrollToSeq=` — the screen's
  // `handleDeselect`. Clearing the store alone leaves the param behind, and a
  // reload, Isolate or Meld then re-selects the message this send already
  // answered, so the next signal silently carries the old `re` again.
  onDeselect: () => void;
}) {
  const reSeqs = useSelectedSeqs(selection);
  const [sending, setSending] = useState(false);
  const [hasText, setHasText] = useState(false);
  const [pendingPayloads, setPendingPayloads] = useState<PendingPayload[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<TextInput>(null);
  const refocusAfterSendRef = useRef(false);
  // Latest chatActive, read synchronously from the after-send effect so a send
  // that settles after you've switched tabs can't yank focus back here.
  const chatActiveRef = useRef(false);
  // Expo Router keeps every visited [nid] screen mounted under the top of the
  // stack, and the funnel below listens on `document`. `chatActive` is per
  // screen and knows nothing about whether its screen is the foreground route,
  // so without this guard a backgrounded narrative left on its Chat tab kept
  // funnelling every keystroke typed into ANOTHER narrative's terminal into
  // its own composer. #342 closed this for the terminal listener; the chat
  // funnel predates it and was never gated. Same rule for both listeners:
  // a key is routed by the foreground route's green tab, and nothing else.
  const isFocused = useIsFocused();
  const chatOwnsKeys = chatActive && isFocused;
  chatActiveRef.current = chatOwnsKeys;
  // Track text in a ref (not state) to avoid re-renders per keystroke
  const textRef = useRef("");
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftKey = `brane:draft:${nid}`;

  // Restore draft on mount / nid change
  useEffect(() => {
    if (Platform.OS !== "web") return;
    try {
      const saved = localStorage.getItem(draftKey);
      if (saved) {
        textRef.current = saved;
        setHasText(saved.trim().length > 0);
        // Populate the textarea
        if (inputRef.current) {
          const el = inputRef.current as unknown as HTMLTextAreaElement;
          el.value = saved;
        }
      }
    } catch {}
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      // Flush: save current text before unmount/nid change
      try {
        const t = textRef.current;
        if (t.trim()) localStorage.setItem(draftKey, t);
        else localStorage.removeItem(draftKey);
      } catch {}
    };
  }, [draftKey]);

  const handleChangeText = useCallback((text: string) => {
    textRef.current = text;
    const empty = text.trim().length === 0;
    setHasText((prev) => {
      if (prev === !empty) return prev; // no-op if unchanged
      return !empty;
    });
    // Debounced draft save (web only)
    if (Platform.OS === "web") {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      draftTimerRef.current = setTimeout(() => {
        try {
          if (text.trim()) localStorage.setItem(draftKey, text);
          else localStorage.removeItem(draftKey);
        } catch {}
      }, 300);
    }
  }, [draftKey]);

  // Focus the composer when the Chat tab becomes (or starts) active. Web only:
  // on mobile, programmatic focus would pop the soft keyboard up unexpectedly.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = inputRef.current as unknown as HTMLTextAreaElement | null;
    if (!el) return;
    if (!chatOwnsKeys) {
      // Release focus when leaving the Chat tab, or when this whole screen
      // drops into the background of the nav stack. The composer stays
      // mounted either way, and a focused textarea nobody can see is where
      // stray keystrokes end up.
      if (document.activeElement === el) el.blur();
      return;
    }
    // Not on a touch screen. Focus from code raises no keyboard there, so it
    // only leaves the composer focused with the keyboard down, and the first
    // tap on an already-focused field raises the keyboard natively, pan and
    // all — the chat opening far too high on the first tap after every page
    // load (claude-3j4583pl:176). The convenience is a physical keyboard's.
    if (!window.matchMedia?.("(pointer: fine)").matches) return;
    // rAF lets layout settle (e.g. after a tab switch) before we focus, so the
    // browser doesn't scroll something offscreen into view first.
    const id = requestAnimationFrame(() => {
      try { el.focus({ preventScroll: true }); } catch { el.focus(); }
    });
    return () => cancelAnimationFrame(id);
  }, [chatOwnsKeys]);

  // Funnel keystrokes into the composer when Chat is active but focus is
  // somewhere else (e.g. a clicked message bubble or the document body).
  // Mirrors the terminal pane's document-level keydown trick so typing
  // "just works" without a manual click into the textarea — and, like that
  // listener, it exists only while this screen is the foreground route
  // (chatOwnsKeys), so a stacked-but-hidden narrative never hears a key.
  useEffect(() => {
    if (Platform.OS !== "web" || !chatOwnsKeys) return;
    const handler = (e: KeyboardEvent) => {
      // Re-check at event time: the effect tears down on the next render, but
      // a keystroke can land between the route losing focus and that render.
      if (!chatActiveRef.current) return;
      // Skip when the user is already in some other input field.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      // Ignore modifier-driven shortcuts (Cmd-R, Ctrl-F, etc.).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Don't disrupt IME composition (CJK input, dead-key accent sequences).
      if (e.isComposing) return;
      // Only handle printable characters. Other keys (arrows, Escape,
      // function keys) should keep their default behavior on the page.
      if (e.key.length !== 1) return;
      const el = inputRef.current as unknown as HTMLTextAreaElement | null;
      if (!el) return;
      // Append the character ourselves: focusing during keydown doesn't
      // reliably redirect the keystroke to the textarea on all browsers,
      // so we insert the character and suppress the default.
      e.preventDefault();
      const next = (el.value || "") + e.key;
      el.value = next;
      el.focus({ preventScroll: true });
      // Place the caret at the end so the next keystroke lands there too.
      try { el.setSelectionRange(next.length, next.length); } catch {}
      handleChangeText(next);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [chatOwnsKeys, handleChangeText]);

  // Paste handler for images (web only). Foreground route only: a hidden
  // narrative's composer would otherwise pick up every image pasted into the
  // one in front, and send it with its next message.
  useEffect(() => {
    if (Platform.OS !== "web" || !isFocused) return;
    const handler = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (!item.type.startsWith("image/")) continue;
        const blob = item.getAsFile();
        if (!blob) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(",")[1];
          const ext = blob.type.split("/")[1] || "png";
          setPendingPayloads((prev) => [
            ...prev,
            {
              id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              filename: `paste_${Date.now()}.${ext}`,
              data: base64,
              uri: dataUrl,
            },
          ]);
        };
        reader.readAsDataURL(blob);
      }
    };
    document.addEventListener("paste", handler as EventListener);
    return () => document.removeEventListener("paste", handler as EventListener);
  }, [isFocused]);

  const handleFilePick = useCallback(() => {
    if (Platform.OS !== "web") return;
    if (!fileInputRef.current) {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "*/*";
      inp.multiple = true;
      inp.style.display = "none";
      inp.addEventListener("change", () => {
        const files = inp.files;
        if (!files) return;
        for (const file of Array.from(files)) {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const base64 = dataUrl.split(",")[1];
            setPendingPayloads((prev) => [
              ...prev,
              {
                id: String(Date.now()) + file.name,
                filename: file.name,
                data: base64,
                uri: dataUrl,
              },
            ]);
          };
          reader.readAsDataURL(file);
        }
        inp.value = "";
      });
      document.body.appendChild(inp);
      fileInputRef.current = inp;
    }
    fileInputRef.current.click();
  }, []);

  useEffect(() => {
    return () => {
      if (fileInputRef.current) {
        fileInputRef.current.remove();
        fileInputRef.current = null;
      }
    };
  }, []);

  const removePendingPayload = useCallback((id: string) => {
    setPendingPayloads((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const handleSend = useCallback(async () => {
    const text = textRef.current.trim();
    if (!conn || !nid || (!text && pendingPayloads.length === 0)) return;
    const payloads = pendingPayloads.length > 0
      ? pendingPayloads.map((p) => ({ filename: p.filename, data: p.data }))
      : undefined;
    setSending(true);
    setPendingPayloads([]);
    try {
      await sendSignal(conn, nid, text || "(attachment)", "web", payloads, [...reSeqs]);
      // The selection has been consumed by the send — drop it, so the next
      // message doesn't silently inherit the last one's references.
      if (reSeqs.length > 0) onDeselect();
      textRef.current = "";
      setHasText(false);
      // Clear saved draft
      if (Platform.OS === "web") {
        try { localStorage.removeItem(draftKey); } catch {}
      }
      // Clear the native input
      if (inputRef.current) {
        const el = inputRef.current as unknown as HTMLTextAreaElement & { clear?: () => void };
        if (typeof el.clear === "function") el.clear();
        else el.value = "";
      }
      // Tab-Enter submits via the send button, leaving focus on the now-
      // disabled arrow. Refocus the composer — but the focus must happen
      // *after* `sending` flips back to false, since the textarea is
      // `disabled={sending}` while in flight and disabled elements reject
      // focus. The effect on `sending` below handles that.
      refocusAfterSendRef.current = Platform.OS === "web";
      // Don't await — let events load in background. Sending never scrolls:
      // the new message is followed only if the view is already at the
      // bottom, which the chat scroller does by itself.
      loadEvents();
    } catch {
      // TODO: show error
    } finally {
      setSending(false);
    }
  }, [conn, nid, draftKey, pendingPayloads, reSeqs, onDeselect, loadEvents]);

  // Refocus the composer after a send completes. Runs once `sending` flips
  // back to false (which re-enables the textarea so it can accept focus).
  useEffect(() => {
    if (sending) return;
    if (!refocusAfterSendRef.current) return;
    refocusAfterSendRef.current = false;
    // Only reclaim focus if Chat is still the active tab — otherwise the
    // active-tab router owns the keyboard and we'd be stealing it back.
    if (!chatActiveRef.current) return;
    const el = inputRef.current as unknown as HTMLTextAreaElement | null;
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch { el.focus(); }
  }, [sending]);

  return (
    <>
      {pendingPayloads.length > 0 && (
        <View style={styles.pendingPayloadsRow} dataSet={{ composer: "1" }}>
          {pendingPayloads.map((p) => (
            <View key={p.id} style={styles.pendingPayloadThumb}>
              {isInlinePayload(p.filename) ? (
                <Image source={{ uri: p.uri }} style={styles.pendingPayloadImage} resizeMode="cover" />
              ) : (
                <View style={[styles.pendingPayloadImage, { justifyContent: "center", alignItems: "center", backgroundColor: "rgba(255,255,255,0.1)" }]}>
                  <Text style={{ color: "#aaa", fontSize: 10 }} numberOfLines={2}>{p.filename.split(".").pop()}</Text>
                </View>
              )}
              <Pressable style={styles.pendingPayloadRemove} onPress={() => removePendingPayload(p.id)}>
                <Text style={styles.pendingPayloadRemoveText}>×</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}
      <View style={styles.inputRow} dataSet={{ composer: "1" }}>
        {Platform.OS === "web" && (
          <Pressable
            onPress={handleFilePick}
            accessibilityLabel="Attach file"
            style={({ hovered, pressed }: { hovered?: boolean; pressed?: boolean }) =>
              [styles.attachButton, (hovered || pressed) && styles.circleGlowActive]}
          >
            <Text style={styles.attachText}>🧫</Text>
          </Pressable>
        )}
        {Platform.OS === "web" ? (
          <textarea
            ref={inputRef as unknown as React.RefObject<HTMLTextAreaElement>}
            style={{
              flex: 1,
              backgroundColor: "#111",
              color: "#e0e0e0",
              borderRadius: 20,
              paddingLeft: 16,
              paddingRight: 16,
              paddingTop: 6,
              paddingBottom: 6,
              fontSize: 16,
              border: "1px solid #555",
              resize: "none",
              overflow: "auto",
              maxHeight: 120,
              fieldSizing: "content",
              fontFamily: "system-ui, -apple-system, sans-serif",
              outline: "none",
              lineHeight: "22px",
              boxSizing: "border-box",
            } as React.CSSProperties}
            onChange={(e) => handleChangeText(e.target.value)}
            placeholder="Compose message..."
            disabled={sending}
            autoComplete="off"
            autoCorrect="on"
            spellCheck={true}
            inputMode="text"
            rows={1}
          />
        ) : (
          <TextInput
            ref={inputRef as React.RefObject<TextInput>}
            style={styles.input}
            onChangeText={handleChangeText}
            placeholder="Compose message..."
            placeholderTextColor="#556"
            editable={!sending}
            multiline
          />
        )}
        <Pressable
          style={[styles.sendButton, (!sending && (hasText || pendingPayloads.length > 0)) && styles.circleGlowSend]}
          onPress={handleSend}
          disabled={sending || (!hasText && pendingPayloads.length === 0)}
        >
          <Text style={[styles.sendText, (sending || (!hasText && pendingPayloads.length === 0)) && styles.sendTextInactive]}>🦋</Text>
        </Pressable>
      </View>
    </>
  );
});

// Custom in-tree header. Rendered as a plain View inside ChatView's JSX so it
// lives in our render tree and is fully insulated from expo-router's navigator
// re-renders. memo() guarantees that changes to unrelated ChatView state
// (activeTab, pinnedTabs, events, etc.) do not re-render this subtree.
type NarrativeHeaderProps = {
  nid: string;
  narrativeSummary: string | null;
  narrativeFoldPath: string | null;
  narrativeRole: string | null;
  narrativeStatus: string | null;
  narrativeMcpConnected: boolean;
  /** Parked waiting for direction — the header glows from the inside. */
  narrativeAwaiting: boolean;
  /** The narrative's 🎨 Recolor salt, which tints that glow. */
  palette: number;
  narrativeCreatedAt: number | null;
  narrativeLastActivity: number | null;
  /** Preformatted cost badge (e.g. "$6.81"), or null for no badge. */
  cost: string | null;
  archived: boolean;
  /** The chat's message selection. The header subscribes to it for the count
   *  the Export item names — one component waking on a tap, which is the
   *  arrangement the store exists to make possible. */
  selection: MessageSelection;
  openSwitcher: () => void;
  /** Swiping the card down puts the narrative away: the list, as a jump. */
  onDismiss: () => void;
  onDownload: (scope: ExportScope) => void;
  onTerminate: () => void;
  onRevive: () => void;
  onTwin: () => void;
  onArchiveToggle: () => void;
  onRecolor: () => void;
  onShowQr: () => void;
  onIsolateDaemon: () => void;
  isIsolated: boolean;
  /** False on a daemon's own bundle that reported no app host: there is
   *  nowhere to hop out to, so the menu leaves Isolate out. */
  canIsolate: boolean;
};

const NarrativeHeader = memo(function NarrativeHeader({
  nid,
  narrativeSummary,
  narrativeFoldPath,
  narrativeRole,
  narrativeStatus,
  narrativeMcpConnected,
  narrativeAwaiting,
  palette,
  narrativeCreatedAt,
  narrativeLastActivity,
  cost,
  archived,
  selection,
  openSwitcher,
  onDismiss,
  onDownload,
  onTerminate,
  onRevive,
  onTwin,
  onArchiveToggle,
  onRecolor,
  onShowQr,
  onIsolateDaemon,
  isIsolated,
  canIsolate,
}: NarrativeHeaderProps) {
  const [menuVisible, setMenuVisible] = useState(false);
  const selectedCount = useSelectedSeqs(selection).length;
  const hasMeta = !!(narrativeRole || narrativeFoldPath || narrativeCreatedAt);
  const glow = isAwaiting({ mcpConnected: narrativeMcpConnected, awaiting: narrativeAwaiting })
    ? awaitingGlow(glowHueFor(nid))
    : undefined;

  // Swipe the card down to dismiss the narrative, judged on release as the
  // pane swipe is: far enough down and mostly vertical. A sideways drag (the
  // summary row scrolls) doesn't count, and neither does one under an open
  // 🦠 menu.
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const swipedRef = useRef(false);
  const swipeHandlers = {
    onTouchStart: (e: any) => {
      swipedRef.current = false;
      const touch = e.nativeEvent;
      swipeStartRef.current = menuVisible ? null : { x: touch.pageX, y: touch.pageY };
    },
    onTouchEnd: (e: any) => {
      const start = swipeStartRef.current;
      swipeStartRef.current = null;
      if (!start) return;
      const touch = e.nativeEvent;
      const dx = touch.pageX - start.x;
      const dy = touch.pageY - start.y;
      if (dy > 60 && dy > Math.abs(dx) * 1.5) {
        swipedRef.current = true;
        onDismiss();
      }
    },
    onTouchCancel: () => { swipeStartRef.current = null; },
  };

  return (
    <View
      style={[styles.header, styles.glowTransition, glow ? ({ boxShadow: glow } as any) : null]}
      {...swipeHandlers}
    >
      <Pressable
        style={styles.headerTitleContainer}
        // A swipe is not also a tap, should the browser click after it.
        onPress={() => { if (swipedRef.current) swipedRef.current = false; else openSwitcher(); }}
      >
        <NarrativeIdentity
          id={nid}
          foldPath={narrativeFoldPath}
          align="center"
        />
        {hasMeta ? (
          <NarrativeMetaLine
            role={narrativeRole}
            cost={cost}
            createdAt={narrativeCreatedAt ?? undefined}
            lastActivity={narrativeLastActivity}
            status={narrativeStatus}
            mcpConnected={narrativeMcpConnected}
            style={{ marginTop: 4 }}
          />
        ) : null}
        {narrativeSummary ? (
          <div style={{ position: "relative", marginRight: 8 }}>
            <div className="no-scrollbar" style={{
              overflowX: "auto",
              overflowY: "hidden",
              scrollbarWidth: "none",
              WebkitOverflowScrolling: "touch",
              // Fade the overflow by masking the text, not by painting the
              // background over it, so a glow behind the row shows through.
              maskImage: `linear-gradient(to right, #000 calc(100% - 60px), transparent)`,
              WebkitMaskImage: `linear-gradient(to right, #000 calc(100% - 60px), transparent)`,
            }}>
              <Text style={styles.headerSummary}>
                {narrativeSummary}
              </Text>
            </div>
          </div>
        ) : null}
      </Pressable>
      <div style={{ position: "relative" }}>
        <Pressable
          onPress={() => setMenuVisible((v) => !v)}
          style={styles.reloadButton}
          hitSlop={8}
        >
          <Text style={[styles.reloadText, menuVisible && styles.reloadTextActive]}>🦠</Text>
        </Pressable>
        {menuVisible && (
          <ContextMenu
            items={narrativeMenuItems({
              role: narrativeRole,
              status: narrativeStatus,
              mcpConnected: narrativeMcpConnected,
              archived,
              isIsolated,
              canIsolate,
              selectedCount,
              onMeld: () => { setMenuVisible(false); onShowQr(); },
              onIsolate: () => { setMenuVisible(false); onIsolateDaemon(); },
              onExport: (scope) => { setMenuVisible(false); onDownload(scope); },
              onRecolor: () => { setMenuVisible(false); onRecolor(); },
              onTwin: () => { setMenuVisible(false); onTwin(); },
              onRevive: () => { setMenuVisible(false); onRevive(); },
              onEnd: () => { setMenuVisible(false); onTerminate(); },
              onArchiveToggle: () => { setMenuVisible(false); onArchiveToggle(); },
            })}
            onClose={() => setMenuVisible(false)}
          />
        )}
      </div>
    </View>
  );
});

// Tell expo-router: don't render its own header. Stable reference — set once.
const HIDE_NAV_HEADER = { headerShown: false } as const;

// Module-level cache of last-known header metadata per narrative, keyed by nid.
// Survives unmount/remount of the detail screen (which happens when navigating
// back to the list and into a narrative again). Without this, every re-entry
// starts with null summary/agent_type/role and the header renders blank until
// fetchNarratives resolves — producing the flicker the user reported.
// Growth is bounded by the number of distinct narratives visited in a session;
// we accept that and don't evict.
type HeaderMeta = { summary?: string; agent_type?: string; role?: string; archived?: boolean; fold_path?: string | null; status?: string; mcp_connected?: boolean; created_at?: number; last_activity?: number | null; cost_amount?: number | null; cost_unit?: string | null };
const headerMetaCache = new Map<string, HeaderMeta>();

/** Narrow a HeaderMeta's cost fields to a {amount, unit} pair, or null. */
function costFromMeta(m: HeaderMeta): { amount: number; unit: string } | null {
  return m.cost_amount != null && m.cost_unit ? { amount: m.cost_amount, unit: m.cost_unit } : null;
}

// Scroll-up prepends are suppressed for this many milliseconds after chat-tab
// initial layout settles. Window is long enough to swallow the layout-reflow
// onScroll events that fire on mount / pane-visibility flip, short enough not
// to feel laggy if the user immediately starts scrolling up.
const CHAT_SETTLE_GRACE_MS = 300;

// The chat scroller. A `column-reverse` flex container measures its scroll
// position from the bottom (scrollTop 0 is the bottom, negative is up), which
// is what lets the chat never write a scroll position after landing:
// - a first render lands on the latest message with no scroll at all;
// - an arrival while the view sits exactly at the bottom is followed, because
//   0 stays 0; anywhere else, the browser's scroll anchoring holds the view;
// - a page of older history is inserted at the far end, so nothing moves.
// Every item is rendered — there is no virtualization to swap measured rows
// for estimated spacers mid-scroll, which was the lumpiness — and paging
// still bounds how many are loaded. Its one child keeps the messages in
// reading order; `marginBottom: auto` lifts a short conversation to the top.
// It is a raw DOM <div> on purpose: brane is web-only, and no RN list can
// express `column-reverse` scrolling. Putting a FlatList back brings back
// the estimated-height spacers and the scroll writes this exists to avoid.
const CHAT_SCROLLER_STYLE = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column-reverse",
  overflowY: "auto",
  overflowX: "hidden",
} as const;
const CHAT_CONTENT_STYLE = { marginBottom: "auto" } as const;

// Where a landing target sits in the viewport, as a fraction from the top.
const CHAT_LANDING_POSITION = 0.3;

// Brings the row for `seq` to the landing position, if it is in the DOM.
// Written on the scroller alone — `scrollIntoView` would also scroll the
// document, which on iOS drags the page out from under the header.
function landChatRow(node: HTMLDivElement | null, seq: number): boolean {
  const row = node?.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
  if (!node || !row) return false;
  const offset = row.getBoundingClientRect().top - node.getBoundingClientRect().top;
  node.scrollTop += offset - node.clientHeight * CHAT_LANDING_POSITION;
  return true;
}

// Controls whose press means only itself — pressing one never re-points the
// keyboard at the pane it happens to sit in. Real <button>s cover the terminal
// quick bar, the 🎹/🦾/macro menus and the copy buttons; the role selectors catch
// the handful of RN `Pressable`s that declare `accessibilityRole` (RN-Web
// renders the rest as a bare <div>, which correctly reads as pane surface).
// <input>/<textarea> are pointedly absent: clicking into the composer is a
// request to type there.
const INTERACTIVE_SELECTOR =
  'button, a[href], [role="button"], [role="link"], [role="menuitem"]';
function readHeaderMeta(nid: string | undefined): HeaderMeta {
  if (!nid) return {};
  return headerMetaCache.get(nid) ?? {};
}
function writeHeaderMeta(nid: string, patch: HeaderMeta) {
  const prev = headerMetaCache.get(nid) ?? {};
  headerMetaCache.set(nid, { ...prev, ...patch });
}

export default function ChatView() {
  // Whether this screen is the foreground route — the Stack keeps the ones
  // behind it mounted, and their document-level listeners must stand down.
  const screenFocused = useIsFocused();
  const { nid, scrollTo, scrollToSeq, tab: tabParam, pinned: pinnedParam, path: pathParam, line: lineParam } = useLocalSearchParams<{
    nid: string;
    scrollTo?: string;
    scrollToSeq?: string;
    tab?: string;
    pinned?: string;
    path?: string;
    line?: string;
  }>();
  const router = useRouter();
  const { conn, subscribe, unsubscribe, onHint, onMeta, onStatus, onToolUses, narrativeIds } = useBrane();
  const [events, setEvents] = useState<NarrativeEvent[]>([]);
  // Tool rows keyed by dedup_key — a row mutates in place (rev bump), so a map
  // makes both the inline-push upsert and the refetch merge idempotent.
  const [toolUses, setToolUses] = useState<Map<string, ToolUse>>(() => new Map());
  // Sync watermark (highest rev seen) and window floor (lowest after_seq
  // fetched) — the two cursors of the tool-row query model.
  const toolRevRef = useRef(0);
  const toolWindowRef = useRef(Number.MAX_SAFE_INTEGER);
  // Local state is the source of truth for file navigation. URL gets written
  // as a side-effect for shareability but is never read back on every render
  // — Expo Router v5's `router.replace(href)` has proven unreliable at
  // clearing query params that the new href omits, which previously left
  // `pathParam` stale and broke in-viewer crumb + arrow navigation.
  const [filesPath, setFilesPath] = useState<string>(() => pathParam ?? "");
  const [filesLine, setFilesLine] = useState<number | undefined>(() => parseLineSpec(lineParam).line);
  const [filesLineEnd, setFilesLineEnd] = useState<number | undefined>(() => parseLineSpec(lineParam).lineEnd);
  const filesStorageKey = nid ? `brane:files:${nid}` : null;
  const tabsStorageKey = nid ? `brane:tabs:${nid}` : null;
  // Tracks the nid whose tab layout has been restored. Used both as the
  // restore one-shot guard and to gate the persist effect, so persist never
  // clobbers a narrative's saved layout with the previous narrative's state
  // during a navigation transition (persist runs before restore in the commit).
  const tabsRestoredNidRef = useRef<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>(() => parseActiveTab(tabParam));
  const [pinnedTabs, setPinnedTabs] = useState<Set<Tab>>(() => parsePinnedTabs(pinnedParam));

  // When navigating to a different narrative, sync file state from the URL.
  // Within the same narrative, state-driven updates own the URL.
  const syncedNidRef = useRef<string | null>(nid ?? null);
  useEffect(() => {
    if (!nid) return;
    if (syncedNidRef.current === nid) return;
    syncedNidRef.current = nid;
    const spec = parseLineSpec(lineParam);
    setFilesPath(pathParam ?? "");
    setFilesLine(spec.line);
    setFilesLineEnd(spec.lineEnd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nid]);

  // Restore last-visited file from sessionStorage when entering a narrative
  // without a path in the URL (e.g. tapping in from the list). `restoredNidRef`
  // guarantees one restore per nid lifetime.
  const restoredNidRef = useRef<string | null>(null);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!filesStorageKey || !nid) return;
    if (restoredNidRef.current === nid) return;
    restoredNidRef.current = nid;
    if (pathParam) return;
    let raw: string | null = null;
    try { raw = sessionStorage.getItem(filesStorageKey); } catch { return; }
    if (!raw) return;
    let parsed: { path?: string; line?: number; lineEnd?: number } | null = null;
    try { parsed = JSON.parse(raw); } catch {}
    if (!parsed?.path) return;
    setFilesPath(parsed.path);
    setFilesLine(parsed.line);
    setFilesLineEnd(parsed.lineEnd);
    const lineStr = parsed.line
      ? (parsed.lineEnd && parsed.lineEnd > parsed.line
          ? `${parsed.line}-${parsed.lineEnd}`
          : String(parsed.line))
      : undefined;
    router.setParams({
      path: parsed.path,
      line: lineStr,
    });
    // Intentionally react only to nid changes; restoration is a one-shot on entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nid]);

  // Persist current file state to sessionStorage whenever it changes.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!filesStorageKey) return;
    try {
      if (filesPath) {
        const payload: { path: string; line?: number; lineEnd?: number } = { path: filesPath };
        if (filesLine) payload.line = filesLine;
        if (filesLineEnd) payload.lineEnd = filesLineEnd;
        sessionStorage.setItem(filesStorageKey, JSON.stringify(payload));
      } else {
        sessionStorage.removeItem(filesStorageKey);
      }
    } catch {}
  }, [filesStorageKey, filesPath, filesLine, filesLineEnd]);

  // Persist active/pinned tab layout to sessionStorage whenever it changes, so
  // the per-narrative layout survives navigating away and back (mirrors the
  // files-state persistence above). Keyed per nid, so each narrative remembers
  // its own tab arrangement independently and per browser tab (per client).
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!tabsStorageKey) return;
    // Don't persist until the restore effect has settled this nid. This effect
    // is declared before the restore effect, so during a navigation transition
    // it would otherwise run first with activeTab/pinnedTabs still holding the
    // previous narrative's values and overwrite the destination's saved layout
    // before restore can read it.
    if (tabsRestoredNidRef.current !== nid) return;
    try {
      sessionStorage.setItem(
        tabsStorageKey,
        JSON.stringify({ tab: activeTab, pinned: serializePinned(pinnedTabs) }),
      );
    } catch {}
  }, [tabsStorageKey, nid, activeTab, pinnedTabs]);
  const visibleTabs = useMemo<Tab[]>(
    () => visiblePanes(activeTab, pinnedTabs),
    [activeTab, pinnedTabs],
  );
  const paneStyles = useMemo(() => {
    const compute = (tab: Tab): ViewStyle => {
      const idx = visibleTabs.indexOf(tab);
      const total = visibleTabs.length;
      if (idx < 0 || total === 1) {
        return {
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: idx < 0 ? 0 : 1,
          backgroundColor: "#111",
          pointerEvents: idx < 0 ? "none" : "auto",
        };
      }
      return {
        position: "absolute",
        top: 0,
        bottom: 0,
        left: `${(idx / total) * 100}%`,
        width: `${100 / total}%`,
        zIndex: 1,
        backgroundColor: "#111",
        borderLeftWidth: idx > 0 ? StyleSheet.hairlineWidth : 0,
        borderLeftColor: "#555",
      };
    };
    return {
      chat: compute("chat"),
      terminal: compute("terminal"),
      files: compute("files"),
    };
  }, [visibleTabs]);
  const swipeEnabled = visibleTabs.length === 1;
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [qrVisible, setQrVisible] = useState(false);
  // Twin dialog opens in place over this narrative — canceling returns here,
  // not to the list.
  const [showTwin, setShowTwin] = useState(false);
  // Lazy init reads the cached value for the current nid on mount. The effect
  // below re-syncs on nid change in case expo-router reuses the ChatView
  // instance across routes instead of remounting (e.g. when the nid param
  // changes without a full navigation pop+push).
  const [narrativeSummary, setNarrativeSummary] = useState<string | null>(
    () => readHeaderMeta(nid).summary ?? null,
  );
  const [narrativeAgentType, setNarrativeAgentType] = useState<string | null>(
    () => readHeaderMeta(nid).agent_type ?? null,
  );
  const [narrativeRole, setNarrativeRole] = useState<string | null>(
    () => readHeaderMeta(nid).role ?? null,
  );
  const [narrativeArchived, setNarrativeArchived] = useState<boolean>(
    () => readHeaderMeta(nid).archived ?? false,
  );
  const [narrativeFoldPath, setNarrativeFoldPath] = useState<string | null>(
    () => readHeaderMeta(nid).fold_path ?? null,
  );
  const [narrativeStatus, setNarrativeStatus] = useState<string | null>(
    () => readHeaderMeta(nid).status ?? null,
  );
  const [narrativeMcpConnected, setNarrativeMcpConnected] = useState<boolean>(
    () => readHeaderMeta(nid).mcp_connected ?? false,
  );
  // Not cached with the rest of the header: it flips on every exchange, so a
  // remembered value is more often wrong than right. The fetch below and the
  // control channel's `awaiting` edges are its only sources.
  const [narrativeAwaiting, setNarrativeAwaiting] = useState(false);
  const [narrativeCreatedAt, setNarrativeCreatedAt] = useState<number | null>(
    () => readHeaderMeta(nid).created_at ?? null,
  );
  const [narrativeLastActivity, setNarrativeLastActivity] = useState<number | null>(
    () => readHeaderMeta(nid).last_activity ?? null,
  );
  const [narrativeCost, setNarrativeCost] = useState<{ amount: number; unit: string } | null>(
    () => costFromMeta(readHeaderMeta(nid)),
  );
  useEffect(() => {
    const cached = readHeaderMeta(nid);
    setNarrativeSummary(cached.summary ?? null);
    setNarrativeAgentType(cached.agent_type ?? null);
    setNarrativeRole(cached.role ?? null);
    setNarrativeArchived(cached.archived ?? false);
    setNarrativeFoldPath(cached.fold_path ?? null);
    setNarrativeStatus(cached.status ?? null);
    setNarrativeMcpConnected(cached.mcp_connected ?? false);
    setNarrativeAwaiting(false);
    setNarrativeCreatedAt(cached.created_at ?? null);
    setNarrativeLastActivity(cached.last_activity ?? null);
    setNarrativeCost(costFromMeta(cached));
  }, [nid]);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [switcherNarratives, setSwitcherNarratives] = useState<NarrativeInfo[]>([]);
  const [switcherLoading, setSwitcherLoading] = useState(false);
  // The sweep below is the heaviest request this screen makes and the first to
  // die on a slow link — and its rejection is swallowed, and the effect can't
  // re-fire. When it was the *only* source, one failed request left every
  // narrative reference on the screen dead until a reload, while the
  // conversation (fetched separately) rendered fine. Union it with the ids the
  // socket already pushed and the one in the route, so a lost sweep costs the
  // ids only it had.
  const [listedNarratives, setListedNarratives] = useState<Array<{ id: string }> | null>(null);
  const knownNarrativeIds = useMemo(
    () => collectKnownNids({ viewing: nid, pushed: [...narrativeIds].map((id) => ({ id })), listed: listedNarratives }),
    [nid, narrativeIds, listedNarratives],
  );
  // The message selection — a store rather than state, so a tap wakes the
  // bubbles that changed and nothing else (see shared/message-selection). The
  // screen deliberately never subscribes: the moment it does, `renderItem` is
  // rebuilt on every tap and every row re-renders, which is the cost this
  // exists to avoid. Consumers that need the set — the header's count, the
  // composer's `re` — subscribe for themselves.
  const selection = useMessageSelection(nid);
  const cursorRef = useRef(0);
  // 🎨 Recolor: the salt foreign speaker hues are hashed with. Seeded from
  // this device's storage so a palette chosen last visit (or from the list
  // card's menu) is the one the bubbles open with; bumping it re-renders every
  // bubble through `renderItem`'s dependency on it.
  const [palette, setPalette] = useState(() => readRecolorSalt(nid));
  useEffect(() => setPalette(readRecolorSalt(nid)), [nid]);
  // The glow moves in the same press; `palette` changing is what re-renders
  // the header that wears it.
  const handleRecolor = useCallback(() => {
    recolorGlowHue(nid);
    setPalette(bumpRecolorSalt(nid));
  }, [nid]);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const swipeLockedRef = useRef(false);
  const chatAtBottomRef = useRef(true);
  const [chatAtBottom, setChatAtBottom] = useState(true);
  const [termAtBottom, setTermAtBottom] = useState(true);
  const [filesAtBottom, setFilesAtBottom] = useState(true);
  const terminalPaneRef = useRef<TerminalPaneHandle>(null);
  const filesPaneRef = useRef<FilesViewHandle>(null);
  const chatVisibleRef = useRef(true);
  chatVisibleRef.current = visibleTabs.includes("chat");
  // Timestamp marking when the chat tab's initial layout settled. Prepends
  // before this has elapsed are almost certainly spurious (layout reflow, pane
  // visibility flip) rather than genuine user scroll-up intent.
  const chatSettledAtRef = useRef(0);
  const scrollToTimeRef = useRef(scrollTo ? Number(scrollTo) : 0);
  const scrollToSeqRef = useRef(scrollToSeq ? Number(scrollToSeq) : 0);
  const scrollLockRef = useRef(false);
  const [scrollButtonLoading, setScrollButtonLoading] = useState(false);

  // Pagination state
  const PAGE_SIZE = 50;
  const [hasMore, setHasMore] = useState(true);
  const loadingOlderRef = useRef(false);
  const suppressOlderLoadRef = useRef(false);
  // Track which (conn, nid) pair has been initially loaded so we re-fetch
  // when the active daemon's credentials change — e.g. after a meld confirm
  // updates a stale token. A bare boolean here would leave us serving the
  // failed-401 events from the prior token forever.
  const initialLoadConnRef = useRef<string | null>(null);

  const chatInitializedRef = useRef(false);
  const terminalInitializedRef = useRef(false);

  // Scroll to target time/seq or bottom on first activation of chat tab.
  // If we have a scroll target but events haven't loaded yet, defer
  // initialization until they arrive (the effect re-runs on events.length).
  useEffect(() => {
    if (visibleTabs.includes("chat") && !chatInitializedRef.current) {
      const targetSeq = scrollToSeqRef.current;
      const targetTime = scrollToTimeRef.current;
      const hasTarget = targetSeq || targetTime;

      // Wait for events before trying to scroll to a target
      if (hasTarget && events.length === 0) return;

      chatInitializedRef.current = true;
      chatSettledAtRef.current = Date.now();

      let targetIdx = -1;
      if (targetSeq && events.length > 0) {
        targetIdx = events.findIndex((e) => e.seq === targetSeq);
        if (targetIdx >= 0) selection.replace([targetSeq]);
        scrollToSeqRef.current = 0;
      } else if (targetTime && events.length > 0) {
        let closestDist = Infinity;
        for (let i = 0; i < events.length; i++) {
          const dist = Math.abs(events[i].time - targetTime);
          if (dist < closestDist) {
            closestDist = dist;
            targetIdx = i;
          }
        }
        scrollToTimeRef.current = 0;
      }

      if (targetIdx >= 0) {
        // Suppress older-event loading briefly so mid-history position doesn't trigger it
        suppressOlderLoadRef.current = true;
        const suppressTimer = setTimeout(() => { suppressOlderLoadRef.current = false; }, 2000);
        // The one scroll the chat ever makes on its own: bringing a requested
        // message into view on landing. Effects run after commit, and nothing
        // is virtualized, so the row is already in the DOM.
        landChatRow(chatScrollRef.current, events[targetIdx].seq);
        return () => clearTimeout(suppressTimer);
      } else {
        chatAtBottomRef.current = true;
        setChatAtBottom(true);
      }
    }
    if (visibleTabs.includes("terminal")) {
      terminalInitializedRef.current = true;
    }
  }, [visibleTabs, events.length]);

  // The ↑/↓ tab button's two destinations. These are the operator's own
  // taps, not auto-scroll; nothing else calls them. In a `column-reverse`
  // scroller the bottom is 0 and the top is as negative as it goes.
  const scrollChatToBottom = useCallback(() => {
    chatScrollRef.current?.scrollTo({ top: 0 });
  }, []);
  const scrollChatToTop = useCallback(() => {
    const node = chatScrollRef.current;
    node?.scrollTo({ top: -node.scrollHeight, behavior: "smooth" });
  }, []);


  const fetchingRef = useRef(false);
  // A `new_events` hint is the client's only wakeup: the server poller fires
  // once per head_seq and advances its cursor immediately, so it never re-sends
  // a hint. If we drop one because a fetch is already in flight, the events it
  // referenced stay invisible until some later event bumps head_seq again
  // (e.g. a terse agent that narrates once and goes quiet — its last reply
  // strands). So instead of dropping a mid-fetch hint, record it and re-fetch
  // once the in-flight pass finishes, looping until we're caught up.
  const pendingFetchRef = useRef(false);

  // Load newer events (incremental, append-only)
  const loadEvents = useCallback(async () => {
    if (!conn || !nid) return;
    if (fetchingRef.current) {
      pendingFetchRef.current = true;
      return;
    }
    fetchingRef.current = true;
    try {
      do {
        pendingFetchRef.current = false;
        const data = await fetchEvents(conn, nid, cursorRef.current);
        if (data.events.length > 0) {
          setEvents((prev) => {
            const maxSeen = prev.length > 0 ? prev[prev.length - 1].seq : 0;
            const novel = data.events.filter((e) => e.seq > maxSeen);
            return novel.length > 0 ? [...prev, ...novel] : prev;
          });
          cursorRef.current = data.events[data.events.length - 1].seq;
        }
      } while (pendingFetchRef.current);
    } finally {
      fetchingRef.current = false;
    }
  }, [conn, nid]);

  // Load older events (prepend, for infinite scroll upward)
  const loadOlderEvents = useCallback(async () => {
    if (!conn || !nid || loadingOlderRef.current || !hasMore) return;
    loadingOlderRef.current = true;
    try {
      const oldestSeq = events.length > 0 ? events[0].seq : Infinity;
      const data = await fetchEventsBefore(conn, nid, oldestSeq, PAGE_SIZE);
      if (data.events.length > 0) {
        setEvents((prev) => {
          // Deduplicate: only prepend events we don't already have
          const minSeen = prev.length > 0 ? prev[0].seq : Infinity;
          const novel = data.events.filter((e) => e.seq < minSeen);
          return novel.length > 0 ? [...novel, ...prev] : prev;
        });
      }
      // No more events if we got fewer than requested, or oldest event is the min
      if (data.events.length < PAGE_SIZE || (data.events.length > 0 && data.events[0].seq <= data.min_seq)) {
        setHasMore(false);
      }
    } finally {
      loadingOlderRef.current = false;
    }
  }, [conn, nid, events, hasMore]);

  // Merge tool rows into local state; newer rev wins so an inline push and a
  // refetch can arrive in either order without regressing a row.
  const applyToolRows = useCallback((rows: ToolUse[]) => {
    if (rows.length === 0) return;
    setToolUses((prev) => {
      let next: Map<string, ToolUse> | null = null;
      for (const row of rows) {
        const existing = (next ?? prev).get(row.dedup_key);
        if (existing && existing.rev >= row.rev) continue;
        if (!next) next = new Map(prev);
        next.set(row.dedup_key, row);
        if (row.rev > toolRevRef.current) toolRevRef.current = row.rev;
      }
      return next ?? prev;
    });
  }, []);

  // Window the tool-row fetch to the seq range the chat has loaded: whenever
  // the loaded window's floor drops (initial load, older-page prepend), fetch
  // rows anchored in the band between the new floor and the old one. The upper
  // bound is what keeps paging back linear — without it every page-back
  // re-downloaded the entire suffix it already held. Live additions arrive by
  // inline push, not by this effect.
  useEffect(() => {
    if (!conn || !nid || events.length === 0) return;
    const floor = Math.max(0, events[0].seq - 1);
    const prevFloor = toolWindowRef.current;
    if (floor >= prevFloor) return;
    toolWindowRef.current = floor;
    fetchAllToolUseWindow(
      conn,
      nid,
      // First pass has no prior floor, so it takes the whole suffix; later
      // passes fetch only [floor, prevFloor).
      { afterSeqGte: floor, afterSeqLt: prevFloor === Number.MAX_SAFE_INTEGER ? undefined : prevFloor },
      applyToolRows,
    ).catch(() => {
      // Fail-open: chat renders without tool rows. Reopening the window means
      // the next change refetches the whole visible range, so a half-applied
      // drain can't leave a permanent hole.
      toolWindowRef.current = Number.MAX_SAFE_INTEGER;
    });
  }, [conn, nid, events, applyToolRows]);

  // Inline tool-row frames ride the narrative subscription the chat already
  // holds. A null rows batch is the server's resync valve: catch up by rev.
  useEffect(() => {
    if (!conn || !nid) return;
    return onToolUses((tuNid, rows, _rev) => {
      if (tuNid !== nid) return;
      if (rows) {
        applyToolRows(rows);
        return;
      }
      // Resync fires precisely when this client is slow or backgrounded, which
      // is when a fetch is most likely to fail — so a swallowed error here is
      // the case that matters. Reopen the display window instead: the rows are
      // still in the table, and the next window change refetches them. Losing
      // them until remount is what the empty catch used to do
      // (claude-8fkbabsx:9, finding 3).
      fetchAllToolUsesSince(conn, nid, toolRevRef.current, applyToolRows).catch(() => {
        toolWindowRef.current = Number.MAX_SAFE_INTEGER;
      });
    });
  }, [conn, nid, onToolUses, applyToolRows]);

  // Initial load: fetch the most recent PAGE_SIZE events, or a window around scrollToSeq
  useEffect(() => {
    if (!conn || !nid) return;
    const sig = `${conn.host}|${conn.token}|${nid}`;
    if (initialLoadConnRef.current === sig) return;
    initialLoadConnRef.current = sig;
    // Drop events loaded under the prior conn (likely 401-empty after a
    // stale-token meld update) so we don't render them on the new daemon.
    setEvents([]);
    setHasMore(true);
    cursorRef.current = 0;
    setToolUses(new Map());
    toolRevRef.current = 0;
    toolWindowRef.current = Number.MAX_SAFE_INTEGER;
    const targetSeq = scrollToSeqRef.current;
    const targetTime = scrollToTimeRef.current;
    (async () => {
      try {
        if (targetSeq) {
          // Load a window of events centered around the target seq
          const halfPage = Math.floor(PAGE_SIZE / 2);
          const after = Math.max(0, targetSeq - halfPage - 1);
          const data = await fetchEvents(conn, nid, after, PAGE_SIZE);
          if (data.events.length > 0) {
            setEvents(data.events);
            // Set cursor to the last event we loaded (not head seq) so
            // incremental loads will fill in events after our window
            cursorRef.current = data.events[data.events.length - 1].seq;
            // Has more older events if the first event isn't seq 1
            setHasMore(data.events[0].seq > 1);
          } else {
            cursorRef.current = data.seq;
            setHasMore(false);
          }
        } else {
          // Default: fetch the tail end of events
          const data = await fetchEventsBefore(conn, nid, Number.MAX_SAFE_INTEGER, PAGE_SIZE);
          if (data.events.length > 0) {
            setEvents(data.events);
            cursorRef.current = data.events[data.events.length - 1].seq;
            if (data.events.length < PAGE_SIZE || data.events[0].seq <= data.min_seq) {
              setHasMore(false);
            }
          } else {
            cursorRef.current = 0;
            setHasMore(false);
          }
        }
      } catch {
        // Fall back to loading all events
        loadEvents();
      }
    })();
  }, [conn, nid]);

  // Everything the header shows, from one narrative row. Extracted so the
  // header can be filled by a single-row fetch instead of waiting on the full
  // list, which on one phone was 1,864 narratives and 934KB — fifteen seconds
  // before a title appeared (claude-n1izig04:76). The list still calls it when
  // it lands; applying the same values twice is idempotent.
  const applyNarrativeMeta = useCallback((narr: NarrativeInfo) => {
    if (!nid) return;
    if (narr.summary) {
      setNarrativeSummary(narr.summary);
      writeHeaderMeta(nid, { summary: narr.summary });
    }
    if (narr.agent_type) {
      setNarrativeAgentType(narr.agent_type);
      writeHeaderMeta(nid, { agent_type: narr.agent_type });
    }
    if (narr.role) {
      setNarrativeRole(narr.role);
      writeHeaderMeta(nid, { role: narr.role });
    }
    setNarrativeFoldPath(narr.fold_path ?? null);
    writeHeaderMeta(nid, { fold_path: narr.fold_path ?? null });
    const archived = !!narr.archived;
    setNarrativeArchived(archived);
    writeHeaderMeta(nid, { archived });
    if (narr.status) {
      setNarrativeStatus(narr.status);
      writeHeaderMeta(nid, { status: narr.status });
    }
    const mcp = !!narr.mcp_connected;
    setNarrativeMcpConnected(mcp);
    writeHeaderMeta(nid, { mcp_connected: mcp });
    setNarrativeAwaiting(!!narr.awaiting);
    setNarrativeCreatedAt(narr.created_at ?? null);
    writeHeaderMeta(nid, { created_at: narr.created_at });
    setNarrativeLastActivity(narr.last_activity ?? null);
    writeHeaderMeta(nid, { last_activity: narr.last_activity ?? null });
    setNarrativeCost(costFromMeta({ cost_amount: narr.cost_amount, cost_unit: narr.cost_unit }));
    writeHeaderMeta(nid, { cost_amount: narr.cost_amount ?? null, cost_unit: narr.cost_unit ?? null });
  }, [nid]);

  // Header first, in its own request: one row, one key seek.
  useEffect(() => {
    if (!conn || !nid) return;
    fetchNarrative(conn, nid).then(applyNarrativeMeta).catch(() => {});
  }, [conn, nid, applyNarrativeMeta]);

  // The full list is only needed for NID linkification, so it no longer gates
  // anything the operator is looking at. It is also the heaviest request here
  // and the first to fail on a slow link — which is survivable now only because
  // it is one source among several (see knownNarrativeIds above). Logged rather
  // than swallowed: this failing used to be completely invisible, which is how
  // it went unexplained.
  useEffect(() => {
    if (!conn || !nid) return;
    fetchNarratives(conn, { archived: true }).then((narrs) => {
      setListedNarratives(narrs);
      const narr = narrs.find((n) => n.id === nid);
      if (narr) applyNarrativeMeta(narr);
    }).catch((err) => {
      console.warn("narrative list sweep failed; linkifying from pushed ids only", err);
    });
  }, [conn, nid, applyNarrativeMeta]);

  useEffect(() => {
    if (!nid) return;
    subscribe(nid, cursorRef.current);
    const unsub = onHint((hintNid, _headSeq) => {
      if (hintNid === nid) {
        loadEvents();
        // A hint means a new event just landed — pulse the header timestamp.
        const now = Date.now();
        setNarrativeLastActivity(now);
        writeHeaderMeta(nid, { last_activity: now });
      }
    });
    return () => {
      unsubscribe(nid);
      unsub();
    };
  }, [nid, subscribe, unsubscribe, onHint, loadEvents]);

  // Live metadata updates. Only apply truthy values — absent/empty broadcasts
  // (e.g. narrations without meta.summary) must not clobber a known value.
  useEffect(() => {
    if (!nid) return;
    return onMeta((metaNid, _title, summary, cost) => {
      if (metaNid !== nid) return;
      if (summary) {
        setNarrativeSummary(summary);
        writeHeaderMeta(nid, { summary });
      }
      if (cost != null) {
        setNarrativeCost(cost);
        writeHeaderMeta(nid, { cost_amount: cost.amount, cost_unit: cost.unit });
      }
    });
  }, [nid, onMeta]);

  useEffect(() => {
    if (!nid) return;
    return onStatus((statusNid, status) => {
      if (statusNid !== nid) return;
      if (status === "mcp_connected") {
        setNarrativeMcpConnected(true);
        writeHeaderMeta(nid, { mcp_connected: true });
      } else if (status === "mcp_disconnected") {
        setNarrativeMcpConnected(false);
        setNarrativeAwaiting(false);
        writeHeaderMeta(nid, { mcp_connected: false });
      } else if (status === AWAITING_STATUS || status === NOT_AWAITING_STATUS) {
        setNarrativeAwaiting(status === AWAITING_STATUS);
      } else if (status === "active" || status === "ended") {
        setNarrativeStatus(status);
        writeHeaderMeta(nid, { status });
      }
    });
  }, [nid, onStatus]);

  // Export conversation via the server-side export endpoint. With messages
  // selected, the menu offers both sides of that selection — the same set that
  // would become a signal's `re`, read either as "these ones" or as "all but
  // these". Selecting nothing keeps the old meaning: the whole conversation.
  //
  // The scope is read off the press rather than the store: `getSelected()` at
  // press time is what the operator was looking at when they chose the item.
  const downloadConversation = useCallback(async (scope: ExportScope) => {
    if (!conn || !nid) return;
    if (scope === "all") {
      await openNarrativeExport(conn, nid);
      return;
    }
    await openNarrativeExport(
      conn,
      nid,
      [...selection.getSelected()],
      scope === "excluded" ? "except" : "only",
    );
  }, [conn, nid, selection]);

  const handleChatScroll = useCallback(async () => {
    if (chatAtBottomRef.current) {
      // At bottom → scroll to top
      scrollLockRef.current = true;
      chatAtBottomRef.current = false;
      setChatAtBottom(false);
      scrollChatToTop();
      setTimeout(() => { scrollLockRef.current = false; }, 600);
    } else {
      // Not at bottom → load new events, then scroll to bottom
      const loadingTimer = setTimeout(() => setScrollButtonLoading(true), 150);
      try {
        await loadEvents();
      } finally {
        clearTimeout(loadingTimer);
        setScrollButtonLoading(false);
      }
      chatAtBottomRef.current = true;
      setChatAtBottom(true);
      scrollChatToBottom();
    }
  }, [loadEvents, scrollChatToBottom, scrollChatToTop]);

  const handleTermScroll = useCallback(() => {
    if (termAtBottom) {
      terminalPaneRef.current?.scrollToTop();
    } else {
      terminalPaneRef.current?.scrollToBottom();
    }
  }, [termAtBottom]);

  const handleFilesScroll = useCallback(() => {
    if (filesAtBottom) {
      filesPaneRef.current?.scrollToTop();
    } else {
      filesPaneRef.current?.scrollToBottom();
    }
  }, [filesAtBottom]);

  const writeUrl = useCallback((tab: Tab, pins: Set<Tab>, path?: string, line?: number, lineEnd?: number) => {
    // setParams updates query params in place without treating the URL change
    // as navigation — avoids Expo Router v5 remounting the [nid] screen on
    // every files-pane tap. Undefined values clear the param.
    router.setParams(viewParams(tab, pins, path, line, lineEnd));
  }, [router]);

  const activateTab = useCallback((tab: Tab) => {
    setActiveTab((prev) => {
      if (prev === tab) return prev;
      writeUrl(tab, pinnedTabs, filesPath, filesLine, filesLineEnd);
      return tab;
    });
  }, [writeUrl, pinnedTabs, filesPath, filesLine, filesLineEnd]);

  // Tapping *into* a visible pane selects it without changing which panes are
  // visible — `selectPane` in shared/pane-layout.ts carries the reasoning, and
  // the short version is that the naive `setActiveTab` collapses the split
  // under the finger and the tap that caused it is never delivered.
  //
  // It cannot live in `activateTab` itself: the single-pane swipe handler uses
  // that one, and preserving the visible set there would turn every swipe into
  // a split.
  const selectVisiblePane = useCallback((tab: Tab) => {
    if (activeTab === tab) return;
    const { pinned } = selectPane(activeTab, pinnedTabs, tab);
    setActiveTab(tab);
    setPinnedTabs(pinned);
    writeUrl(tab, pinned, filesPath, filesLine, filesLineEnd);
  }, [writeUrl, activeTab, pinnedTabs, filesPath, filesLine, filesLineEnd]);

  // Where Revive and End leave you: in front of the terminal, with the keys
  // pointed at it. Both end in a prompt you have to answer — a resumed agent
  // often comes up on one, a termination is often blocked by one — so the pane
  // also takes DOM focus, or the keystroke goes to the chat composer instead.
  //
  // It *reveals* rather than replaces — `selectPane` again, so the new visible
  // set is the old one plus the terminal. Clearing the pins instead used to
  // yank Chat out from under an operator who already had both panes up: a
  // lifecycle action needs the terminal in front of you, which is not a reason
  // to take away everything else. Pinning alone would not do, either: the
  // visible set is `activeTab ∪ pinnedTabs`, so a merely pinned terminal
  // appears while the keystrokes still land in the chat composer.
  //
  // The navigating cases arrive at this view via `terminalOnlyHref`; this is
  // the in-place case, which has no navigation to carry it.
  const revealTerminal = useCallback(() => {
    const { pinned: pins } = selectPane(activeTab, pinnedTabs, "terminal");
    setActiveTab("terminal");
    setPinnedTabs(pins);
    writeUrl("terminal", pins, filesPath, filesLine, filesLineEnd);
    // After the pane is visible — focusing a hidden pane does nothing.
    setTimeout(() => terminalPaneRef.current?.focus(), 60);
  }, [writeUrl, activeTab, pinnedTabs, filesPath, filesLine, filesLineEnd]);

  // Split view: clicking/tapping any visible pane selects it (green tab) so
  // further keystrokes route there. Without this, DOM focus and the active tab
  // can disagree — e.g. the chat composer keeps focus while the Terminal tab is
  // green, so typing lands in the composer instead of the terminal. Web-only;
  // only meaningful when more than one pane is visible side-by-side.
  //
  // Only while this screen is the foreground route. A narrative behind the top
  // one stays mounted, and its listener would hear taps on the screen in front:
  // it would select a pane in *its* layout (pinning whatever it was showing,
  // usually Chat), and `router.setParams` — the global router, which writes to
  // the focused route — would hand that layout to the screen you're looking at.
  // Same rule as the composer's keystroke funnel (#342).
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!screenFocused) return;
    if (visibleTabs.length < 2) return;
    const handler = (e: Event) => {
      const target = e.target as HTMLElement | null;
      // A press on a control is a press on that control, not on the pane
      // behind it. Tapping the terminal's quick bar asks for a keystroke, not
      // for your typing to move house; tapping a copy button asks for the
      // clipboard. Re-pointing the keyboard as a side effect is a surprise
      // either way, and the re-render it triggers is one more chance for the
      // button to move out from under the release event that was going to
      // fire it. Text fields are deliberately not on this list: clicking into
      // the composer *is* a request to type there, and the tab should follow.
      if (target?.closest?.(INTERACTIVE_SELECTOR)) return;
      const paneEl = target?.closest?.("[data-pane]") as HTMLElement | null;
      const pane = paneEl?.getAttribute("data-pane");
      if (pane !== "chat" && pane !== "terminal" && pane !== "files") return;
      selectVisiblePane(pane);
      // Force DOM focus to follow the click even when the tab was already active
      // (terminal green but composer focused) and when alt-screen mode
      // suppresses the browser's default focus-on-click.
      if (pane === "terminal") terminalPaneRef.current?.focus();
    };
    document.addEventListener("pointerdown", handler, true);
    return () => document.removeEventListener("pointerdown", handler, true);
  }, [screenFocused, visibleTabs.length, selectVisiblePane]);

  const togglePin = useCallback((tab: Tab) => {
    setPinnedTabs((prev) => {
      const next = new Set(prev);
      if (next.has(tab)) next.delete(tab);
      else next.add(tab);
      writeUrl(activeTab, next, filesPath, filesLine, filesLineEnd);
      return next;
    });
  }, [writeUrl, activeTab, filesPath, filesLine, filesLineEnd]);

  // Which protocol the reader is showing, if any — set by tapping a `/command`
  // in a message.
  const [protocolReader, setProtocolReader] = useState<string | null>(null);

  const handleNarrativePress = useCallback((targetNid: string, seq?: number) => {
    // This narrative, by name alone, is where you already are. With a seq it
    // is a jump like any other: a pushed screen, so Back returns to the one
    // underneath, still mounted at the spot you were reading — see "Back" in
    // docs/view-urls.md.
    if (targetNid === nid && !seq) return;
    router.push(narrativeHref(targetNid, seq));
  }, [router, nid]);

  const handleForeignPress = useCallback((sourceNid: string, time: number) => {
    router.push(`/${sourceNid}?scrollTo=${time}`);
  }, [router]);

  // Stable across taps — it closes over the store, not over the selection. That
  // is what keeps `renderItem` (and so every mounted bubble) from being rebuilt
  // every time a message is picked.
  const handleTimestampPress = useCallback((seq: number) => {
    const selecting = selection.toggle(seq);
    // `?scrollToSeq=` makes the selection survive a reload, so it has to track
    // selection rather than every tap: writing it while *de*selecting would
    // resurrect a message you had just dismissed.
    router.setParams({ scrollToSeq: selecting ? String(seq) : undefined });
  }, [router, selection]);

  // Drop the whole selection without touching scroll position — a tap in the
  // chat's negative space, or a send that consumed the references.
  const handleDeselect = useCallback(() => {
    if (selection.clear().length === 0) return;
    router.setParams({ scrollToSeq: undefined });
  }, [router, selection]);

  // Tap in the chat's negative space to clear the selection. Web-only and
  // deliberately DOM-level: the margin beside a bubble belongs to the
  // full-width row, so there is no React element to hang this on that wouldn't
  // also swallow taps on the message itself. Clearing never scrolls — the
  // whole point is that dismissing a selection leaves your view where it is.
  // Foreground route only, for the reason the pane-select listener gives: a
  // backgrounded screen's `handleDeselect` would clear `?scrollToSeq=` from the
  // URL of the screen in front.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!screenFocused) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest) return;
      // Only inside the chat pane, and only in space that belongs to no one.
      // Bubbles, the composer, and in-list chrome like tool-use groups all opt
      // out: interacting with something is not dismissing something else.
      if (!target.closest('[data-pane="chat"]')) return;
      if (target.closest("[data-bubble], [data-chrome]")) return;
      if (target.closest("input, textarea, [data-composer]")) return;
      // Releasing a text-selection drag in the margin is not a tap. Same signal
      // the swipe handler uses to tell dragging from gesturing.
      if (window.getSelection()?.toString()) return;
      handleDeselect();
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [screenFocused, handleDeselect]);

  const updateFilesParams = useCallback((path: string, line?: number, lineEnd?: number) => {
    setFilesPath(path);
    setFilesLine(line);
    setFilesLineEnd(lineEnd);
    const filesVisible = activeTab === "files" || pinnedTabs.has("files");
    if (filesVisible) {
      // Files already on screen — just update the path/line, preserve current active tab and pins.
      writeUrl(activeTab, pinnedTabs, path, line, lineEnd);
    } else {
      setActiveTab("files");
      writeUrl("files", pinnedTabs, path, line, lineEnd);
    }
  }, [writeUrl, activeTab, pinnedTabs]);

  const handleFilePress = useCallback((rel: string) => {
    const { path: cleanPath, line, lineEnd } = parseRelLink(rel);
    updateFilesParams(cleanPath, line, lineEnd);
  }, [updateFilesParams]);

  // Where a plain click on a file link would land, so the link can carry it as
  // a real href and ⌘-click opens that file in its own tab.
  const resolveFileHref = useCallback((rel: string) => {
    if (!nid) return undefined;
    const { path: cleanPath, line, lineEnd } = parseRelLink(rel);
    return fileHref(nid, cleanPath, line, lineEnd, serializePinned(pinnedTabs) || undefined);
  }, [nid, pinnedTabs]);

  // Sync activeTab/pinnedTabs with URL when navigated via deep link (e.g., back/forward).
  const activeRefForSync = useRef(activeTab);
  activeRefForSync.current = activeTab;
  const pinnedRefForSync = useRef(pinnedTabs);
  pinnedRefForSync.current = pinnedTabs;
  useEffect(() => {
    const desiredTab = parseActiveTab(tabParam);
    if (desiredTab !== activeRefForSync.current) setActiveTab(desiredTab);
    const desiredPins = parsePinnedTabs(pinnedParam);
    const current = pinnedRefForSync.current;
    if (desiredPins.size !== current.size || [...desiredPins].some((t) => !current.has(t))) {
      setPinnedTabs(desiredPins);
    }
  }, [tabParam, pinnedParam]);

  // Restore the per-narrative tab layout from sessionStorage when entering a
  // narrative that has no explicit tab params in the URL (e.g. tapping in from
  // the list, or returning after navigating elsewhere). Explicit deep links
  // (?tab=/?pinned=) always win; sessionStorage is the per-client fallback.
  // One restore per nid lifetime, mirroring the files-restore effect.
  //
  // Declared after the URL-sync effect above so that, in the commit where both
  // fire (nid + params change together on navigation), this effect's setState
  // is the last write and wins — restored state is applied directly without a
  // transient flash to the default tab, and without touching the URL.
  //
  // Deliberately does NOT call router.setParams: in single-daemon mode the
  // daemon-served bundle bootstraps async (meld/probe), so this effect can run
  // before the Expo Router navigator has mounted. Navigating then throws
  // "Attempted to navigate before mounting the Root Layout component", which
  // unmounts the whole tree into a blank screen. sessionStorage is the
  // per-client store; the URL only needs to carry explicit deep links.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!tabsStorageKey || !nid) return;
    if (tabsRestoredNidRef.current === nid) return;
    tabsRestoredNidRef.current = nid;
    if (tabParam || pinnedParam) return;
    let raw: string | null = null;
    try { raw = sessionStorage.getItem(tabsStorageKey); } catch { return; }
    if (!raw) return;
    let parsed: { tab?: string; pinned?: string } | null = null;
    try { parsed = JSON.parse(raw); } catch {}
    if (!parsed) return;
    setActiveTab(parseActiveTab(parsed.tab));
    setPinnedTabs(parsePinnedTabs(parsed.pinned));
    // One-shot on entry; intentionally react only to nid changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nid]);

  // Tool rows grouped by render anchor. A group anchored at seq N renders
  // right after event N — inside event N's list cell, so the FlatList's data
  // stays `events` and every piece of seq-indexed scroll math survives
  // untouched. Anchors outside the loaded window: rows below the floor stay
  // hidden until their page loads (their anchor event isn't on screen);
  // rows above the ceiling (push beat the event hint) clamp to the last
  // loaded event so live activity is visible immediately.
  const toolGroups = useMemo(() => {
    const map = new Map<number, ToolUse[]>();
    if (toolUses.size === 0 || events.length === 0) return map;
    const firstSeq = events[0].seq;
    const lastSeq = events[events.length - 1].seq;
    for (const row of toolUses.values()) {
      let anchor = Math.min(row.after_seq, lastSeq);
      if (anchor === 0) {
        // Pre-first-event rows belong above seq 1; representable only when
        // the top of history is loaded. Anchor into seq 1's cell (rendered
        // above the bubble).
        if (firstSeq !== 1) continue;
        anchor = 0;
      } else if (anchor < firstSeq) {
        continue;
      }
      const group = map.get(anchor);
      if (group) group.push(row);
      else map.set(anchor, [row]);
    }
    for (const group of map.values()) {
      group.sort(
        (a, b) => a.started_at - b.started_at || a.dedup_key.localeCompare(b.dedup_key),
      );
    }
    return map;
  }, [events, toolUses]);

  // Rows arrive excerpted; this is how an opened one pays for its full text.
  const fetchFullToolUse = useCallback(
    (dedupKey: string) => {
      if (!conn || !nid) return Promise.reject(new Error("no connection"));
      return fetchToolUse(conn, nid, dedupKey);
    },
    [conn, nid],
  );

  const renderItem = useCallback(({ item }: { item: NarrativeEvent }) => {
    const groupBefore = item.seq === 1 ? toolGroups.get(0) : undefined;
    const groupAfter = toolGroups.get(item.seq);
    const bubble = (
      <MessageBubble
        item={item}
        nid={nid}
        agentType={narrativeAgentType}
        foldPath={narrativeFoldPath}
        conn={conn}
        selection={selection}
        palette={palette}
        onImagePress={setLightboxUrl}
        onForeignPress={handleForeignPress}
        onFilePress={handleFilePress}
        fileHref={resolveFileHref}
        onTimestampPress={handleTimestampPress}
      />
    );
    if (!groupBefore && !groupAfter) return bubble;
    return (
      <>
        {groupBefore && <ToolUseGroup rows={groupBefore} onNarrativePress={handleNarrativePress} onFetchFull={fetchFullToolUse} />}
        {bubble}
        {groupAfter && <ToolUseGroup rows={groupAfter} onNarrativePress={handleNarrativePress} onFetchFull={fetchFullToolUse} />}
      </>
    );
  }, [nid, narrativeAgentType, narrativeFoldPath, conn, selection, palette, handleForeignPress, handleNarrativePress, handleFilePress, resolveFileHref, handleTimestampPress, toolGroups, fetchFullToolUse]);

  // The view as query params — what Isolate carries to the other origin and
  // what the Meld QR carries to another device. One record, so the two can't
  // show you different things.
  const currentView = useMemo(
    () => viewParams(activeTab, pinnedTabs, filesPath, filesLine, filesLineEnd),
    [activeTab, pinnedTabs, filesPath, filesLine, filesLineEnd],
  );

  // Whether this page is the daemon's own bundle, and if so where Isolate
  // hops out to: the host the daemon reports, never one the app knows.
  const isolated = typeof window !== "undefined" && !!conn && isIsolated(window.location.host, conn.host);
  const appHost = useAppHost(conn, isolated);

  const handleIsolateDaemon = useCallback(() => {
    if (!conn || !nid) return;
    if (typeof window === "undefined") return;
    // The whole view goes across, because isolating crosses origins and the
    // URL is the only thing that survives that. buildIsolateUrl owns the rest.
    const url = buildIsolateUrl({
      host: window.location.host,
      protocol: window.location.protocol,
      search: window.location.search,
      path: `/${nid}`,
      conn,
      appHost,
      view: currentView,
    });
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }, [conn, nid, currentView, appHost]);

  const handleArchiveToggle = useCallback(async () => {
    if (!conn || !nid) return;
    const next = !narrativeArchived;
    setNarrativeArchived(next);
    writeHeaderMeta(nid, { archived: next });
    try {
      await archiveNarrative(conn, nid, next);
    } catch {
      setNarrativeArchived(!next);
      writeHeaderMeta(nid, { archived: !next });
      return;
    }
    // Archiving puts the narrative away, so go to the list. A jump, so it
    // pushes: Back returns to the archived narrative — see docs/view-urls.md.
    // Only once the request has landed: archiving broadcasts nothing, and the
    // list's fetch on mount would otherwise race it and still show the row.
    if (next) router.push("/");
  }, [conn, nid, narrativeArchived, router]);

  // Swiping the header card down: the list, as a jump, so Back returns here —
  // see docs/view-urls.md. Stable, because the header is memoized.
  const dismissToList = useCallback(() => router.push("/"), [router]);

  const openSwitcher = useCallback(() => {
    if (!conn) return;
    // Open immediately — don't block the modal on the network round-trip. The
    // list (kept from the last open) shows right away and repopulates below.
    setShowSwitcher(true);
    setSwitcherLoading(true);
    fetchNarratives(conn)
      .then((narrs) => {
        // Show only active narratives (MCP-connected or still running), but
        // always keep the one you're viewing so you can see where you are.
        const active = narrs.filter(
          (n) => n.mcp_connected || n.status === "active" || n.id === nid,
        );
        // Membership is this screen's business; order is not. `sortNarratives`
        // is the same rule the list screen uses, so a narrative sits in the same
        // place whichever surface you find it on — and a bridge dropping while
        // the modal is open no longer moves a card out from under your thumb.
        // Given the filter above, the only `ended` row that can reach it is the
        // narrative you're viewing, which lands at the bottom as before.
        setSwitcherNarratives(sortNarratives(active));
      })
      .catch(() => {})
      .finally(() => setSwitcherLoading(false));
  }, [conn, nid]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
    <MarkdownLinksProvider
      knownNarrativeIds={knownNarrativeIds}
      onNarrativePress={handleNarrativePress}
      onProtocolPress={setProtocolReader}
    >
      <Stack.Screen options={HIDE_NAV_HEADER} />
      <NarrativeHeader
        nid={nid!}
        narrativeSummary={narrativeSummary}
        narrativeFoldPath={narrativeFoldPath}
        narrativeRole={narrativeRole}
        narrativeStatus={narrativeStatus}
        narrativeMcpConnected={narrativeMcpConnected}
        narrativeAwaiting={narrativeAwaiting}
        palette={palette}
        narrativeCreatedAt={narrativeCreatedAt}
        narrativeLastActivity={narrativeLastActivity}
        cost={formatCost(narrativeCost?.amount, narrativeCost?.unit)}
        archived={narrativeArchived}
        selection={selection}
        openSwitcher={openSwitcher}
        onDismiss={dismissToList}
        onDownload={downloadConversation}
        onTerminate={() => { revealTerminal(); terminalPaneRef.current?.terminate(); }}
        onRevive={() => {
          // A role that twins instead of reviving opens a dialog and then
          // navigates away — rewriting the view first would be for nothing.
          if (!revivesAsTwin(narrativeRole)) revealTerminal();
          terminalPaneRef.current?.revive();
        }}
        onTwin={() => setShowTwin(true)}
        onArchiveToggle={handleArchiveToggle}
        onRecolor={handleRecolor}
        onShowQr={() => setQrVisible(true)}
        onIsolateDaemon={handleIsolateDaemon}
        isIsolated={isolated}
        canIsolate={!isolated || !!appHost}
      />
      <View style={styles.tabBar}>
        {CANONICAL_TABS.map((tab, idx) => {
          const isActive = activeTab === tab;
          const isPinned = pinnedTabs.has(tab);
          const isVisible = isActive || isPinned;
          const label = tab === "chat" ? "Chat" : tab === "terminal" ? "Terminal" : "Files";
          const arrowAtBottom = tab === "chat" ? chatAtBottom : tab === "terminal" ? termAtBottom : filesAtBottom;
          const onArrowPress = tab === "chat" ? handleChatScroll : tab === "terminal" ? handleTermScroll : handleFilesScroll;
          return (
            <View
              key={tab}
              style={[styles.tab, idx > 0 && styles.tabDivider, isActive && styles.tabActive]}
            >
              <Pressable style={styles.tabLabel} onPress={() => activateTab(tab)}>
                <Text style={[styles.tabText, isActive && styles.tabTextActive]}>
                  {label}
                </Text>
              </Pressable>
              <Pressable
                style={styles.tabPin}
                onPress={() => togglePin(tab)}
                hitSlop={6}
              >
                <Text style={[styles.tabPinIcon, isPinned ? styles.tabPinOn : styles.tabPinOff]}>📌</Text>
              </Pressable>
              <Pressable
                style={styles.tabArrowPress}
                onPress={onArrowPress}
                disabled={!isVisible}
                hitSlop={6}
              >
                {isVisible ? (
                  tab === "chat" && scrollButtonLoading
                    ? <Text style={styles.tabArrowText}>♻️</Text>
                    : <Text style={styles.tabArrowText}>{arrowAtBottom ? "↑" : "↓"}</Text>
                ) : <Text style={styles.tabArrowText} />}
              </Pressable>
            </View>
          );
        })}
      </View>
      <View
        style={{ flex: 1, overflow: "hidden", position: "relative" }}
        {...(swipeEnabled ? {
          onTouchStart: (e: any) => {
            const touch = e.nativeEvent;
            touchStartRef.current = { x: touch.pageX, y: touch.pageY };
          },
          onTouchMove: (e: any) => {
            if (!touchStartRef.current) return;
            const touch = e.nativeEvent;
            const dx = Math.abs(touch.pageX - touchStartRef.current.x);
            const dy = Math.abs(touch.pageY - touchStartRef.current.y);
            if (dx > 15 && dx > dy * 1.5 && !swipeLockedRef.current) {
              swipeLockedRef.current = true;
            }
          },
          onTouchEnd: (e: any) => {
            if (!touchStartRef.current) return;
            const touch = e.nativeEvent;
            const dx = touch.pageX - touchStartRef.current.x;
            const dy = touch.pageY - touchStartRef.current.y;
            touchStartRef.current = null;
            swipeLockedRef.current = false;
            // Don't treat the gesture as a tab swipe if the user was actually
            // dragging to select message text. Brane is web-only, so the DOM
            // Selection API is the right (and only) signal here.
            const hasSelection =
              typeof window !== "undefined" && !!window.getSelection()?.toString();
            if (!hasSelection && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
              const only = visibleTabs[0];
              const idx = CANONICAL_TABS.indexOf(only);
              const next = dx < 0 ? idx + 1 : idx - 1;
              if (next >= 0 && next < CANONICAL_TABS.length) {
                activateTab(CANONICAL_TABS[next]);
              }
            }
          },
        } : {})}
      >
      {/* Chat view */}
      <View style={paneStyles.chat} dataSet={{ pane: "chat" }}>
        {/* Vertical scroll is never switched off, not even under a
            horizontal pane swipe: the gate that did so could outlive its
            gesture and leave the list stuck. See CHAT_SCROLLER_STYLE. */}
        <div
          ref={chatScrollRef}
          style={CHAT_SCROLLER_STYLE}
          onScroll={(e) => {
            const node = e.currentTarget;
            // scrollTop is 0 at the bottom and negative above it.
            const atBottom = node.scrollTop > -50;
            if (atBottom !== chatAtBottomRef.current && !scrollLockRef.current) {
              chatAtBottomRef.current = atBottom;
              setChatAtBottom(atBottom);
            }
            // Prepend older history when near the top. Skip during the settle
            // grace window after the chat tab initializes — that window catches
            // spurious onScroll events from layout reflow/pane-visibility flips.
            // After that, any near-top scroll is genuine user intent. A prepend
            // lands at the scroller's far end, so it moves nothing on screen,
            // and the distance to the top grows by a page, so one gesture loads
            // one page rather than rapid-firing down to seq 1.
            //
            // `chatSettledAtRef.current > 0` is load-bearing: the ref is
            // initialized to 0, and `Date.now() - 0` trivially exceeds the
            // grace window, so without this guard prepends would fire before
            // the chat tab has ever initialized.
            const distFromTop = node.scrollHeight - node.clientHeight + node.scrollTop;
            const settledAgo = Date.now() - chatSettledAtRef.current;
            if (
              distFromTop < 200 &&
              hasMore &&
              !loadingOlderRef.current &&
              !suppressOlderLoadRef.current &&
              chatVisibleRef.current &&
              chatSettledAtRef.current > 0 &&
              settledAgo > CHAT_SETTLE_GRACE_MS
            ) {
              loadOlderEvents();
            }
          }}
        >
          <View style={[styles.list, CHAT_CONTENT_STYLE]}>
            {events.map((item) => (
              <div key={item.seq} data-seq={item.seq}>
                {renderItem({ item })}
              </div>
            ))}
          </View>
        </div>
        <InputBar
          conn={conn}
          nid={nid!}
          loadEvents={loadEvents}
          chatActive={activeTab === "chat"}
          selection={selection}
          onDeselect={handleDeselect}
        />
      </View>
      {/* Terminal view */}
      {conn && nid && (
        <View style={paneStyles.terminal} dataSet={{ pane: "terminal" }}>
          <TerminalPane
            ref={terminalPaneRef}
            conn={conn}
            nid={nid}
            active={visibleTabs.includes("terminal")}
            keyboardActive={activeTab === "terminal" && !showSwitcher && !showTwin && lightboxUrl === null}
            agentType={narrativeAgentType}
            role={narrativeRole}
            onAtBottomChange={setTermAtBottom}
            onTwin={() => setShowTwin(true)}
            onRevived={(revivedNid) => router.push(terminalOnlyHref(revivedNid))}
          />
        </View>
      )}
      {/* Files view */}
      {conn && nid && (
        <View style={paneStyles.files} dataSet={{ pane: "files" }}>
          <FilesView
            ref={filesPaneRef}
            conn={conn}
            nid={nid}
            path={filesPath}
            line={filesLine}
            lineEnd={filesLineEnd}
            active={visibleTabs.includes("files")}
            onPathChange={updateFilesParams}
            onImagePress={setLightboxUrl}
            onAtBottomChange={setFilesAtBottom}
          />
        </View>
      )}
      </View>
      <Modal
        visible={showSwitcher}
        transparent
        animationType="fade"
        onRequestClose={() => setShowSwitcher(false)}
      >
        <Pressable
          style={styles.switcherOverlay}
          onPress={() => setShowSwitcher(false)}
        >
          <View style={styles.switcherContent}>
            <View style={styles.switcherTitleRow}>
              <Text style={styles.switcherTitle}>Switch narrative</Text>
              <Pressable
                hitSlop={8}
                onPress={() => {
                  setShowSwitcher(false);
                  // The one in-app route to the list, needed when a narrative
                  // was opened directly (Meld, Isolate) with nothing beneath
                  // it. A jump, so it pushes: Back returns here — see
                  // docs/view-urls.md. The list beneath, if any, stays mounted
                  // and keeps its activity stream: connection.ts refcounts it.
                  router.push("/");
                }}
              >
                <Text style={styles.switcherListLink}>All narratives</Text>
              </Pressable>
            </View>
            <FlatList
              data={switcherNarratives}
              keyExtractor={(item) => item.id}
              style={styles.switcherList}
              ListEmptyComponent={
                <Text style={styles.switcherEmpty}>
                  {switcherLoading ? "Loading…" : "No active narratives"}
                </Text>
              }
              renderItem={({ item }) => {
                const isEnded = item.status === "ended" && !item.mcp_connected;
                const glow = isAwaiting({ mcpConnected: item.mcp_connected, awaiting: item.awaiting })
                  ? awaitingGlow(glowHueFor(item.id))
                  : undefined;
                return (
                  <Pressable
                    style={[
                      styles.switcherItem,
                      item.id === nid && styles.switcherItemActive,
                      isEnded && styles.switcherItemEnded,
                      glow ? ({ boxShadow: glow } as any) : null,
                    ]}
                    onPress={() => {
                      setShowSwitcher(false);
                      // Another narrative is a new history entry, as it is from
                      // the list or an @nid link — see "Back" in docs/view-urls.md.
                      if (item.id !== nid) {
                        router.push(`/${item.id}`);
                      }
                    }}
                  >
                    <NarrativeIdentity
                      id={item.id}
                      foldPath={item.fold_path}
                      titleStyle={isEnded ? { color: "#666" } : undefined}
                      copyMarginLeft={5}
                      dimmed={isEnded}
                    />
                    <NarrativeMetaLine
                      role={item.role}
                      cost={formatCost(item.cost_amount, item.cost_unit)}
                      createdAt={item.created_at}
                      lastActivity={item.last_activity}
                      status={item.status}
                      mcpConnected={item.mcp_connected}
                      dimmed={isEnded}
                      style={{ marginTop: 4 }}
                    />
                    {item.summary && (
                      <div style={{ position: "relative" }}>
                        <div className="no-scrollbar" style={{
                          overflowX: "auto",
                          overflowY: "hidden",
                          scrollbarWidth: "none",
                          WebkitOverflowScrolling: "touch",
                          // Fade the overflow by masking the text, not by painting the
                          // background over it, so a glow behind the row shows through.
                          maskImage: `linear-gradient(to right, #000 calc(100% - 40px), transparent)`,
                          WebkitMaskImage: `linear-gradient(to right, #000 calc(100% - 40px), transparent)`,
                        }}>
                          <Text style={[styles.switcherItemSummary, isEnded && { color: "#555" }]}>
                            {item.summary}
                          </Text>
                        </div>
                      </div>
                    )}
                  </Pressable>
                );
              }}
            />
            <Pressable
              style={styles.switcherCancel}
              onPress={() => setShowSwitcher(false)}
            >
              <Text style={styles.switcherCancelText}>Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
      <QrModal
        visible={qrVisible}
        conn={conn}
        path={`/${nid}`}
        view={currentView}
        onClose={() => setQrVisible(false)}
      />
      <SpawnDialog
        visible={showTwin}
        conn={conn}
        re={nid}
        defaultFoldPath={narrativeFoldPath}
        onClose={() => setShowTwin(false)}
        onSpawned={(narrative) => { setShowTwin(false); router.push(`/${narrative.id}`); }}
      />
      <Modal
        visible={lightboxUrl !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setLightboxUrl(null)}
      >
        <Pressable style={styles.lightboxBackdrop} onPress={() => setLightboxUrl(null)}>
          {lightboxUrl && (
            <Image
              source={{ uri: lightboxUrl }}
              style={styles.lightboxImage}
              resizeMode="contain"
            />
          )}
          <Text style={styles.lightboxHint}>Tap anywhere to close</Text>
        </Pressable>
      </Modal>
      {protocolReader && conn && (
        <MarkdownLinksProvider
          onNarrativePress={(targetNid, seq) => {
            setProtocolReader(null);
            handleNarrativePress(targetNid, seq);
          }}
        >
          <WikiReader
            conn={conn}
            target={{ source: "protocols", slug: protocolReader }}
            onClose={() => setProtocolReader(null)}
          />
        </MarkdownLinksProvider>
      )}
    </MarkdownLinksProvider>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  // The awaiting glow fades in and out rather than blinking: it flips on
  // every exchange.
  glowTransition: (Platform.OS === "web"
    ? { transitionProperty: "box-shadow", transitionDuration: "400ms" }
    : {}) as any,
  header: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1a1a1e",
    paddingHorizontal: 4,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgb(216, 216, 216)",
    position: "relative",
    zIndex: 10,
  },
  tabBar: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#555",
    backgroundColor: "#111",
  },
  tab: {
    // Match the split-pane width math (left/width percentages) instead of
    // flexbox so the tab dividers round to the same device pixels as the
    // pane dividers below them — otherwise flex's integer-remainder
    // distribution offsets the 2nd divider by ~1px. Both use borderLeft.
    width: `${100 / CANONICAL_TABS.length}%`,
    position: "relative",
  },
  tabDivider: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: "#555",
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: "#4caf50",
  },
  tabLabel: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  tabPin: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  tabPinIcon: {
    fontSize: 12,
  },
  tabPinOn: {
    opacity: 1,
  },
  tabPinOff: {
    opacity: 0.25,
  },
  tabArrowPress: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    width: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  tabText: {
    color: "#666",
    fontSize: 14,
    fontWeight: "600",
  },
  tabTextActive: {
    color: "#4caf50",
  },
  tabArrowText: {
    color: "#8fd4b4",
    fontSize: 16,
    fontWeight: "400",
  },
  headerTitleContainer: {
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "center",
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 8,
  },
  headerSubtitle: {
    color: "#888",
    fontSize: 12,
    fontFamily: "monospace",
    marginTop: 1,
  },
  headerSummary: {
    color: "#9a9aa0",
    fontSize: 12,
    lineHeight: 12,
    whiteSpace: "nowrap",
  },
  list: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bubbleRow: {
    marginBottom: 6,
    flexDirection: "row",
  },
  bubbleRowLeft: {
    justifyContent: "flex-start",
  },
  bubbleRowRight: {
    justifyContent: "flex-end",
  },
  bubbleRowCenter: {
    justifyContent: "center",
  },
  bubble: {
    maxWidth: "85%",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    // Every bubble reserves the selection border's space up front, transparent
    // until selected. Adding the border only on selection would resize the
    // bubble by 3px and reflow its text on every tap; now selection changes
    // nothing but a color.
    borderWidth: SELECTION_BORDER_WIDTH,
    borderColor: "transparent",
    borderStyle: "solid",
  },
  bubbleAgent: {
    backgroundColor: "#1c1c1e",
    borderBottomLeftRadius: 4,
  },
  bubbleOperator: {
    backgroundColor: "#1a4a7a",
    borderBottomRightRadius: 4,
  },
  bubbleForeign: {
    borderRadius: 12,
  },
  // Daemon-written lifecycle events (spawn, twin, revive, bind rejection). No
  // fill and a dashed outline so they read as stage directions rather than as
  // something the home agent said — the agent bubble's solid fill is what made
  // them look authored. Everything else (padding, the attribution-header /
  // content / timestamp stack) is deliberately identical to a normal bubble.
  // Mirrored by `.system` in the HTML export.
  bubbleSystem: {
    backgroundColor: "transparent",
    // Explicitly 1px, not the shared selection width — a hairline dash reads as
    // an outline while 1.5 starts reading as a frame, and it matches the
    // export's `.system`. Constant across selected/unselected either way, so it
    // costs nothing in jitter.
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: "#3a3a3c",
    borderRadius: 12,
  },
  // Color only — the width is already reserved by `bubble`, so selecting a
  // message can't change its dimensions.
  bubbleSelected: {
    borderColor: "#5b9bd5",
  },
  // Row so the copy button can sit beside the attribution without swallowing
  // its press target — tapping the label still selects/deep-links the seq.
  //
  // The gap below the header belongs to this row, not to the label: as the
  // label's own marginBottom it made the label's box 3px taller than its text,
  // and centering that box against the button pushed the button half a margin
  // low.
  bubbleSourceRow: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    marginBottom: 3,
  },
  bubbleSourcePress: {
    alignSelf: "flex-start",
  },
  bubbleSource: {
    color: "#4caf50",
    fontSize: 11,
    fontFamily: "monospace",
  },
  // The foreign speaker's nid navigates, so it reads as a link; the
  // (nid:seq) that follows it only selects and stays plain.
  bubbleSourceLink: {
    textDecorationLine: "underline",
  },
  bubbleSourceAfterLink: {
    marginLeft: 4,
  },
  // The daemon isn't a speaker, so its attribution sits in the dim palette
  // rather than the green reserved for agents and the operator.
  bubbleSourceSystem: {
    color: "#8a8a8e",
  },
  bubbleTimePress: {
    alignSelf: "flex-end",
    marginTop: 4,
  },
  bubbleTime: {
    color: "#666",
    fontSize: 11,
    textAlign: "right",
  },
  inputRow: {
    flexDirection: "row",
    padding: 8,
    paddingBottom: Platform.OS === "web" ? 8 : 24,
    borderTopWidth: 1,
    borderTopColor: "rgb(216, 216, 216)",
    backgroundColor: "#1a1a1a",
    alignItems: "flex-end",
  },
  input: {
    flex: 1,
    backgroundColor: "#111",
    color: "#e0e0e0",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    fontSize: 15,
    borderWidth: 1,
    borderColor: "#555",
    maxHeight: 120,
    minHeight: 36,
  },
  sendButton: {
    marginLeft: 8,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#1c1c1e",
    borderWidth: 1,
    borderColor: "#555",
    justifyContent: "center",
    alignItems: "center",
    ...(Platform.OS === "web"
      ? { transition: "box-shadow 160ms ease, border-color 160ms ease" }
      : {}),
  } as any,
  sendText: {
    fontSize: 20,
    lineHeight: 20,
    // Orient the butterfly like 🚀 — flying northeast (up-and-to-the-right).
    // Translate (screen-space, before the rotate) nudges it down + left to
    // pull the tilted glyph back to the circle's optical center.
    transform: [{ translateX: -1 }, { translateY: 1 }, { rotate: "45deg" }],
  },
  sendTextInactive: {
    opacity: 0.35,
  },
  attachButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#1c1c1e",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 8,
    borderWidth: 1,
    borderColor: "#555",
    ...(Platform.OS === "web"
      ? { transition: "box-shadow 160ms ease, border-color 160ms ease" }
      : {}),
  } as any,
  attachText: {
    fontSize: 20,
    lineHeight: 20,
    // 🧫 renders low in its em box; lift it slightly to optical center.
    marginTop: -3,
  },
  // Pink "active" glow on the *circle* — same multi-layer intensity as the
  // 🔮 fuzzy-search and 🦠 menu affordances, so the input controls read as
  // the same family. Applied as a box-shadow on the button, not the glyph.
  circleGlowActive: {
    borderColor: "rgba(255, 130, 180, 0.6)",
    ...(Platform.OS === "web"
      ? {
          boxShadow: [
            "0 0 10px rgba(255, 130, 180, 0.9)",
            "0 0 25px rgba(255, 110, 165, 0.7)",
            "0 0 50px rgba(255, 100, 155, 0.4)",
          ].join(", "),
        }
      : {
          shadowColor: "rgb(255, 130, 180)",
          shadowOpacity: 0.9,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 0 },
        }),
  } as any,
  // Greenish-cyan variant for the 🦋 send button when sendable.
  circleGlowSend: {
    borderColor: "rgba(90, 230, 200, 0.6)",
    ...(Platform.OS === "web"
      ? {
          boxShadow: [
            "0 0 10px rgba(90, 230, 200, 0.9)",
            "0 0 25px rgba(70, 215, 190, 0.7)",
            "0 0 50px rgba(60, 200, 180, 0.4)",
          ].join(", "),
        }
      : {
          shadowColor: "rgb(90, 230, 200)",
          shadowOpacity: 0.9,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 0 },
        }),
  } as any,
  payloadsContainer: {
    marginTop: 6,
    gap: 4,
  },
  filePayload: {
    backgroundColor: "rgba(255,255,255,0.1)",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  filePayloadText: {
    color: "#6cf",
    fontSize: 13,
  },
  pendingPayloadsRow: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingTop: 8,
    gap: 8,
    backgroundColor: "#111",
  },
  pendingPayloadThumb: {
    position: "relative",
    width: 60,
    height: 60,
  },
  pendingPayloadImage: {
    width: 60,
    height: 60,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#555",
  },
  pendingPayloadRemove: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#c00",
    justifyContent: "center",
    alignItems: "center",
  },
  pendingPayloadRemoveText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 16,
  },
  switcherOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  switcherContent: {
    backgroundColor: "#1e1e1e",
    borderRadius: 12,
    paddingTop: 20,
    paddingHorizontal: 20,
    paddingBottom: 8,
    width: "100%",
    maxWidth: 400,
    maxHeight: "70%",
  },
  switcherTitleRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  switcherTitle: {
    color: "#e0e0e0",
    fontSize: 18,
    fontWeight: "600",
  },
  switcherListLink: {
    color: "#8fd4b4",
    fontSize: 14,
  },
  switcherList: {
    flexGrow: 0,
    // Room for the active row's outline, which a scroll container would clip;
    // the negative margin keeps rows aligned with the title.
    padding: 4,
    margin: -4,
  },
  switcherItem: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: "#2a2a2a",
    marginBottom: 8,
  },
  // An outline set off from the row, not a border: an awaiting glow's rim is
  // painted just inside the border, and a green border against it vanished.
  switcherItemActive: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "#4caf50",
    outlineOffset: 2,
  } as any,
  switcherItemEnded: {
    opacity: 0.5,
  },
  switcherItemSummary: {
    color: "#9a9aa0",
    fontSize: 12,
    lineHeight: 12,
    whiteSpace: "nowrap",
  },
  switcherEmpty: {
    color: "#888",
    fontSize: 14,
    textAlign: "center",
    paddingVertical: 20,
  },
  switcherCancel: {
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 4,
  },
  switcherCancelText: {
    color: "#888",
    fontSize: 15,
  },
  lightboxBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.95)",
    justifyContent: "center",
    alignItems: "center",
    padding: 8,
  },
  lightboxImage: {
    width: "100%",
    height: "92%",
  },
  lightboxHint: {
    color: "#888",
    fontSize: 14,
    marginTop: 20,
  },
  reloadButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginRight: 4,
  },
  reloadText: {
    fontSize: 20,
    ...(Platform.OS === "web" ? { transition: "text-shadow 160ms ease" } : {}),
  } as any,
  reloadTextActive: {
    ...(Platform.OS === "web"
      ? {
          textShadow: [
            "0 0 10px rgba(140, 230, 170, 0.9)",
            "0 0 25px rgba(120, 215, 155, 0.7)",
            "0 0 50px rgba(100, 200, 145, 0.4)",
            "0 2px 15px rgba(130, 220, 165, 0.6)",
          ].join(", "),
        }
      : {
          textShadowColor: "rgba(140, 230, 170, 0.8)",
          textShadowOffset: { width: 0, height: 0 },
          textShadowRadius: 16,
        }),
  } as any,
});
