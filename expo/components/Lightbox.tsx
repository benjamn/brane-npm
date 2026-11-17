import { useEffect, useRef } from "react";
import { View, Text, Image, Pressable, Modal, StyleSheet, Platform } from "react-native";
import { galleryPosition, swipeStep, keyStep, TAP_SLOP } from "@shared/lightbox-gallery";

/**
 * A full-screen image, and a way to step to the images either side of it.
 *
 * `gallery` is the ordered list the open image belongs to (for the chat,
 * every image payload loaded, oldest first: `galleryPaths`). When `uri` is
 * in it, ‹ / › buttons, the ← / → keys and a horizontal swipe move to its
 * neighbors without closing, and a counter says where you are. An image
 * that isn't in the gallery (one opened from the Files view) shows alone,
 * as the lightbox always did.
 *
 * Tapping anywhere else closes it, and so does Esc (RNW's `Modal` maps it to
 * `onRequestClose`). The backdrop is a surface, not a control, so it stays
 * out of the tab order; the ✕ is the keyboard's way out.
 */
export default function Lightbox({
  uri,
  gallery,
  onNavigate,
  onClose,
}: {
  /** The image to show; `null` closes the lightbox. */
  uri: string | null;
  gallery: readonly string[];
  onNavigate: (uri: string) => void;
  onClose: () => void;
}) {
  const { index, count, prev, next } = uri !== null
    ? galleryPosition(gallery, uri)
    : { index: -1, count: 0, prev: null, next: null };

  // Keys, while open. Capture phase on window, so the chat's own
  // document-level key handling never sees an arrow meant for the lightbox.
  useEffect(() => {
    if (Platform.OS !== "web" || uri === null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const step = keyStep(e.key);
      if (step === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const target = step < 0 ? prev : next;
      if (target) onNavigate(target);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [uri, prev, next, onNavigate]);

  // Fetch the neighbors ahead of time, so a step shows the image at once
  // rather than a black screen while it downloads.
  useEffect(() => {
    for (const neighbor of [prev, next]) {
      if (neighbor) Image.prefetch(neighbor).catch(() => {});
    }
  }, [prev, next]);

  // A touch that travelled is a swipe (or an abandoned one), never a tap: it
  // must not also close the lightbox or press an arrow. Judged during the
  // move, so it's settled before any press fires on release.
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(false);
  const touchHandlers = {
    onTouchStart: (e: any) => {
      movedRef.current = false;
      const touch = e.nativeEvent;
      touchStartRef.current = { x: touch.pageX, y: touch.pageY };
    },
    onTouchMove: (e: any) => {
      const start = touchStartRef.current;
      if (!start) return;
      const touch = e.nativeEvent;
      if (Math.abs(touch.pageX - start.x) > TAP_SLOP || Math.abs(touch.pageY - start.y) > TAP_SLOP) {
        movedRef.current = true;
      }
    },
    onTouchEnd: (e: any) => {
      const start = touchStartRef.current;
      touchStartRef.current = null;
      if (!start) return;
      const touch = e.nativeEvent;
      const step = swipeStep(touch.pageX - start.x, touch.pageY - start.y);
      const target = step < 0 ? prev : step > 0 ? next : null;
      if (target) onNavigate(target);
    },
    onTouchCancel: () => { touchStartRef.current = null; },
  };
  const ifTapped = (fn: () => void) => () => {
    if (movedRef.current) movedRef.current = false;
    else fn();
  };

  const inGallery = index >= 0 && count > 1;

  return (
    <Modal visible={uri !== null} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.root} {...touchHandlers}>
        <Pressable style={styles.backdrop} tabIndex={-1} onPress={ifTapped(onClose)}>
          {uri && (
            <Image
              source={{ uri }}
              aria-label={inGallery ? `Image ${index + 1} of ${count}` : "Image"}
              style={styles.image}
              resizeMode="contain"
            />
          )}
          <Text style={styles.caption} aria-live="polite">
            {inGallery ? `${index + 1} / ${count} · Tap to close` : "Tap anywhere to close"}
          </Text>
        </Pressable>
        {prev && (
          <Pressable
            role="button"
            aria-label="Previous image"
            style={[styles.arrow, styles.arrowLeft]}
            onPress={ifTapped(() => onNavigate(prev))}
          >
            <Text style={styles.arrowText}>‹</Text>
          </Pressable>
        )}
        {next && (
          <Pressable
            role="button"
            aria-label="Next image"
            style={[styles.arrow, styles.arrowRight]}
            onPress={ifTapped(() => onNavigate(next))}
          >
            <Text style={styles.arrowText}>›</Text>
          </Pressable>
        )}
        <Pressable role="button" aria-label="Close image" style={styles.close} onPress={onClose}>
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.95)",
  },
  backdrop: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 8,
  },
  image: {
    width: "100%",
    height: "92%",
  },
  caption: {
    color: "#888",
    fontSize: 14,
    marginTop: 20,
  },
  arrow: {
    position: "absolute",
    top: "50%",
    marginTop: -40,
    width: 48,
    height: 80,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(40, 40, 40, 0.6)",
  },
  arrowLeft: {
    left: 8,
  },
  arrowRight: {
    right: 8,
  },
  arrowText: {
    color: "#ddd",
    fontSize: 40,
    lineHeight: 44,
    marginTop: -4,
  },
  close: {
    position: "absolute",
    top: 12,
    right: 12,
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(40, 40, 40, 0.6)",
  },
  closeText: {
    color: "#ddd",
    fontSize: 18,
  },
});
