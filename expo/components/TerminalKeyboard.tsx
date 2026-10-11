import { useRef, useState, useCallback } from "react";

interface TerminalKeyboardProps {
  sendKeys: (keys: string) => void;
}

interface KeyDef {
  label: string;
  shiftLabel?: string;
  tmux: string;
  shiftTmux?: string;
  width?: number; // flex multiplier (default 1)
  type?: "shift" | "ctrl" | "alt";
}

const ROW1: KeyDef[] = [
  { label: "`", shiftLabel: "~", tmux: "`", shiftTmux: "~" },
  { label: "1", shiftLabel: "!", tmux: "1", shiftTmux: "!" },
  { label: "2", shiftLabel: "@", tmux: "2", shiftTmux: "@" },
  { label: "3", shiftLabel: "#", tmux: "3", shiftTmux: "#" },
  { label: "4", shiftLabel: "$", tmux: "4", shiftTmux: "$" },
  { label: "5", shiftLabel: "%", tmux: "5", shiftTmux: "%" },
  { label: "6", shiftLabel: "^", tmux: "6", shiftTmux: "^" },
  { label: "7", shiftLabel: "&", tmux: "7", shiftTmux: "&" },
  { label: "8", shiftLabel: "*", tmux: "8", shiftTmux: "*" },
  { label: "9", shiftLabel: "(", tmux: "9", shiftTmux: "(" },
  { label: "0", shiftLabel: ")", tmux: "0", shiftTmux: ")" },
  { label: "-", shiftLabel: "_", tmux: "-", shiftTmux: "_" },
  { label: "=", shiftLabel: "+", tmux: "=", shiftTmux: "+" },
  { label: "\u232b", tmux: "BSpace" },
];

const ROW2: KeyDef[] = [
  { label: "q", tmux: "q", shiftTmux: "Q" },
  { label: "w", tmux: "w", shiftTmux: "W" },
  { label: "e", tmux: "e", shiftTmux: "E" },
  { label: "r", tmux: "r", shiftTmux: "R" },
  { label: "t", tmux: "t", shiftTmux: "T" },
  { label: "y", tmux: "y", shiftTmux: "Y" },
  { label: "u", tmux: "u", shiftTmux: "U" },
  { label: "i", tmux: "i", shiftTmux: "I" },
  { label: "o", tmux: "o", shiftTmux: "O" },
  { label: "p", tmux: "p", shiftTmux: "P" },
  { label: "[", shiftLabel: "{", tmux: "[", shiftTmux: "{" },
  { label: "]", shiftLabel: "}", tmux: "]", shiftTmux: "}" },
];

const ROW3: KeyDef[] = [
  { label: "a", tmux: "a", shiftTmux: "A" },
  { label: "s", tmux: "s", shiftTmux: "S" },
  { label: "d", tmux: "d", shiftTmux: "D" },
  { label: "f", tmux: "f", shiftTmux: "F" },
  { label: "g", tmux: "g", shiftTmux: "G" },
  { label: "h", tmux: "h", shiftTmux: "H" },
  { label: "j", tmux: "j", shiftTmux: "J" },
  { label: "k", tmux: "k", shiftTmux: "K" },
  { label: "l", tmux: "l", shiftTmux: "L" },
  { label: ";", shiftLabel: ":", tmux: ";", shiftTmux: ":" },
  { label: "'", shiftLabel: '"', tmux: "'", shiftTmux: '"' },
  { label: "\\", shiftLabel: "|", tmux: "\\", shiftTmux: "|" },
];

const ROW4: KeyDef[] = [
  { label: "Shift", tmux: "", type: "shift", width: 1.8 },
  { label: "z", tmux: "z", shiftTmux: "Z" },
  { label: "x", tmux: "x", shiftTmux: "X" },
  { label: "c", tmux: "c", shiftTmux: "C" },
  { label: "v", tmux: "v", shiftTmux: "V" },
  { label: "b", tmux: "b", shiftTmux: "B" },
  { label: "n", tmux: "n", shiftTmux: "N" },
  { label: "m", tmux: "m", shiftTmux: "M" },
  { label: ",", shiftLabel: "<", tmux: ",", shiftTmux: "<" },
  { label: ".", shiftLabel: ">", tmux: ".", shiftTmux: ">" },
  { label: "/", shiftLabel: "?", tmux: "/", shiftTmux: "?" },
];

const ROW5: KeyDef[] = [
  { label: "Ctrl", tmux: "", type: "ctrl", width: 1.4 },
  { label: "Alt", tmux: "", type: "alt", width: 1.2 },
  { label: "Tab", tmux: "Tab", width: 1.2 },
  { label: "", tmux: "Space", width: 4 },
  { label: "\u2190", tmux: "Left" },
  { label: "\u2193", tmux: "Down" },
  { label: "\u2191", tmux: "Up" },
  { label: "\u2192", tmux: "Right" },
];

const ALL_ROWS = [ROW1, ROW2, ROW3, ROW4, ROW5];

export default function TerminalKeyboard({ sendKeys }: TerminalKeyboardProps) {
  // Ref is source of truth (synchronous); state drives rendering
  const modRef = useRef({ shift: false, ctrl: false, alt: false });
  const [modState, setModState] = useState({ shift: false, ctrl: false, alt: false });
  const [pressedKey, setPressedKey] = useState<string | null>(null);
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchedRef = useRef(false);

  const handleModToggle = useCallback((type: "shift" | "ctrl" | "alt") => {
    modRef.current[type] = !modRef.current[type];
    setModState({ ...modRef.current });
  }, []);

  const handleKeyPress = useCallback(
    (def: KeyDef) => {
      const { shift, ctrl, alt } = modRef.current;
      let key = shift && def.shiftTmux ? def.shiftTmux : def.tmux;

      if (ctrl && key.length === 1 && /[a-zA-Z]/.test(key)) {
        sendKeys(`C-${key.toLowerCase()}`);
      } else if (alt && key.length === 1) {
        sendKeys(`M-${key.toLowerCase()}`);
      } else {
        sendKeys(key);
      }
    },
    [sendKeys],
  );

  const renderKey = (def: KeyDef, rowIdx: number, keyIdx: number) => {
    const isMod = def.type === "shift" || def.type === "ctrl" || def.type === "alt";
    const isActive = isMod && modState[def.type!];

    // Show shifted label when shift is active
    let displayLabel: string;
    if (isMod) {
      displayLabel = def.label;
    } else if (modState.shift) {
      displayLabel = def.shiftLabel || (def.label.length === 1 ? def.label.toUpperCase() : def.label);
    } else {
      displayLabel = def.label;
    }

    const keyId = `${rowIdx}-${keyIdx}`;
    const isPressed = pressedKey === keyId;

    const handleTouch = (e: React.TouchEvent) => {
      e.preventDefault();
      touchedRef.current = true;
      fireTap();
    };
    const handleMouse = (e: React.MouseEvent) => {
      e.preventDefault();
      if (touchedRef.current) { touchedRef.current = false; return; }
      fireTap();
    };
    const fireTap = () => {
      if (isMod) {
        handleModToggle(def.type!);
      } else {
        handleKeyPress(def);
        // Flash press indicator
        if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
        setPressedKey(keyId);
        pressTimerRef.current = setTimeout(() => setPressedKey(null), 180);
      }
    };

    return (
      <div
        key={keyId}
        onTouchStart={handleTouch}
        onMouseDown={handleMouse}
        style={{
          flex: def.width || 1,
          height: "min(36px, 6vh)" as any,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: isActive ? "#2e7d32" : isPressed ? "#4444cc" : "#2a2a2a",
          border: `1px solid ${isActive ? "#4caf50" : isPressed ? "#7c7cff" : "#3a3a3a"}`,
          borderRadius: 4,
          boxShadow: isPressed ? "0 0 8px rgba(120, 120, 255, 0.8)" : "none",
          cursor: "pointer",
          userSelect: "none",
          WebkitUserSelect: "none" as any,
          touchAction: "manipulation",
          transition: "background-color 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease",
        }}
      >
        <span
          style={{
            color: isActive || isPressed ? "#fff" : "#ccc",
            fontSize: isMod || def.tmux.length > 1 ? 11 : 14,
            fontFamily: "monospace",
            fontWeight: isMod ? "600" : "400",
            pointerEvents: "none",
          }}
        >
          {displayLabel}
        </span>
      </div>
    );
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "min(3px, 0.5vh)" as any,
        padding: "min(4px, 0.6vh) 3px" as any,
        backgroundColor: "#1a1a1a",
        borderTop: "1px solid rgb(216, 216, 216)",
        flexShrink: 0,
      }}
    >
      {ALL_ROWS.map((row, rowIdx) => (
        <div
          key={rowIdx}
          style={{
            display: "flex",
            flexDirection: "row",
            gap: "min(3px, 0.5vh)" as any,
          }}
        >
          {row.map((def, keyIdx) => renderKey(def, rowIdx, keyIdx))}
        </div>
      ))}
    </div>
  );
}
