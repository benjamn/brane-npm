/** A list card's now-playing row: the dial, the file (tap: that narrative's
 *  Files tab on it), the clock, and ✕ to eject. Rendered only while the
 *  narrative holds a track, so a card with nothing on the jukebox is as it
 *  was. Every tap here stops at the row: the card's own click opens the
 *  narrative. */
import { useRouter } from "expo-router";
import { Platform } from "react-native";
import { formatClock } from "@shared/audio-dial";
import { trackTitle } from "@shared/now-playing";
import { ejectTrack, useJukeboxEntry } from "@/lib/jukebox";
import NowPlayingDial from "./NowPlayingDial";

export default function NowPlayingRow({ nid }: { nid: string }) {
  const entry = useJukeboxEntry(nid);
  const router = useRouter();
  if (!entry || Platform.OS !== "web") return null;
  const { track, position, duration, status } = entry;

  const open = (e: React.MouseEvent) => {
    e.stopPropagation();
    const q = new URLSearchParams();
    q.set("tab", "files");
    q.set("path", track.path);
    router.push(`/${nid}?${q.toString()}`);
  };

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10 }}
    >
      <NowPlayingDial nid={nid} size={28} />
      <button
        onClick={open}
        title={track.path}
        style={{
          flex: 1,
          minWidth: 0,
          background: "none",
          border: "none",
          padding: 0,
          textAlign: "left",
          cursor: "pointer",
          color: status === "error" ? "#ff785a" : "#cfd8d3",
          fontSize: 13,
          lineHeight: "18px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {trackTitle(track.path)}
      </button>
      <span style={{ color: "#8a9590", fontSize: 12, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
        {status === "error" ? "can't play" : `${formatClock(position)} / ${formatClock(duration)}`}
      </span>
      <button
        aria-label="Eject"
        title="Eject"
        onClick={(e) => { e.stopPropagation(); ejectTrack(nid); }}
        style={{ background: "none", border: "none", color: "#8a9590", fontSize: 15, lineHeight: "18px", padding: "2px 4px", cursor: "pointer" }}
      >
        ✕
      </button>
    </div>
  );
}
