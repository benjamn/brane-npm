import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Animated, Platform } from "react-native";

// The ♻️ glyph is 3-fold symmetric, so it only reads as "upright" at multiples
// of 120°. Stepping by a full detent keeps every resting position upright while
// still showing visible motion. SPIN_MS is the dwell between clockwise clicks.
export const RECYCLE_STEP = 120;
export const SPIN_MS = 300; // dwell between clockwise 120° clicks while spinning

const DEFAULT_TRANSITION = "transform 0.18s ease";

/**
 * Owns a rotation angle that steps one 120° detent clockwise every SPIN_MS
 * while `spinning` is true, then holds. The returned setter lets callers also
 * drive the angle directly when not spinning — e.g. a pull gesture winding it
 * counterclockwise, or a manual "click" of feedback on a button press.
 */
export function useDetentSpin(
  spinning: boolean,
): readonly [number, Dispatch<SetStateAction<number>>] {
  const [angle, setAngle] = useState(0);
  useEffect(() => {
    if (!spinning) return;
    const id = setInterval(() => setAngle((a) => a + RECYCLE_STEP), SPIN_MS);
    return () => clearInterval(id);
  }, [spinning]);
  return [angle, setAngle] as const;
}

/** Parse the duration (ms) out of a CSS transition string; "none" → 0. */
function transitionDurationMs(transition: string): number {
  const m = transition.match(/([\d.]+)s/);
  return m ? Number(m[1]) * 1000 : 0;
}

/**
 * The spinning ♻️ glyph. On web it's a rotated `<span>` driven by a CSS
 * transition (so the caller's transition string — including "none" for 1:1
 * drag tracking — is honored exactly). On native it animates toward `angle`
 * with a matching duration.
 */
export function RecycleGlyph({
  angle,
  transition = DEFAULT_TRANSITION,
  fontSize = 26,
  opacity = 1,
}: {
  angle: number;
  transition?: string;
  fontSize?: number;
  opacity?: number;
}) {
  if (Platform.OS === "web") {
    return (
      <span
        style={{
          fontSize,
          display: "inline-block",
          opacity,
          transform: `rotate(${angle}deg)`,
          transition,
        }}
      >
        {"♻️"}
      </span>
    );
  }
  return <NativeRecycleGlyph angle={angle} transition={transition} fontSize={fontSize} opacity={opacity} />;
}

function NativeRecycleGlyph({
  angle,
  transition,
  fontSize,
  opacity,
}: {
  angle: number;
  transition: string;
  fontSize: number;
  opacity: number;
}) {
  const rot = useRef(new Animated.Value(angle)).current;
  useEffect(() => {
    const duration = transitionDurationMs(transition);
    if (duration === 0) {
      rot.setValue(angle);
      return;
    }
    const anim = Animated.timing(rot, { toValue: angle, duration, useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [angle, transition, rot]);
  const rotate = rot.interpolate({
    inputRange: [0, 360],
    outputRange: ["0deg", "360deg"],
    extrapolate: "extend",
  });
  return <Animated.Text style={{ fontSize, opacity, transform: [{ rotate }] }}>{"♻️"}</Animated.Text>;
}
