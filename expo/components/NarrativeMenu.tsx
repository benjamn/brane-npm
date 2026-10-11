import type { ConnectionParams } from "@/lib/api";
import { fetchNarrativeExportHtml } from "@/lib/api";
import { readRecolorSalt } from "@/lib/recolor";
import type { ContextMenuItem } from "./ContextMenu";
import { narrativeMenuItems as buildItems, type NarrativeMenuOptions } from "@shared/narrative-menu";
import type { SeqSelectionMode } from "@shared/export-selection";

export { revivesAsTwin } from "@shared/narrative-menu";

/** The menu's shape lives in `src/shared/narrative-menu.ts` — pure, so the node
 *  suite can check that the two surfaces offering it can't drift. This wrapper
 *  exists only to pin its item type to the component's `ContextMenuItem`: the
 *  two are structurally identical, and this is where a change to either would
 *  stop compiling. */
export function narrativeMenuItems(opts: NarrativeMenuOptions): ContextMenuItem[] {
  return buildItems(opts);
}

/** Export → a standalone HTML document in a new tab. The one menu action that
 *  is neither a plain API call nor pure modal state, so it lives beside the
 *  menu both surfaces build rather than in either one of them. The device's
 *  🎨 Recolor salt rides along, so the export shows the palette the operator
 *  is looking at — this is the one place the salt leaves the browser.
 *
 *  `seqs` is the chat's message selection, and `mode` which side of it to
 *  export: an excerpt of exactly those messages, or the conversation with
 *  exactly those left out. The list card, which has no selection, passes
 *  nothing and gets the whole conversation as it always did. */
export async function openNarrativeExport(
  conn: ConnectionParams,
  nid: string,
  seqs?: number[] | null,
  mode: SeqSelectionMode = "only",
): Promise<void> {
  try {
    const blob = await fetchNarrativeExportHtml(conn, nid, readRecolorSalt(nid), seqs, mode);
    window.open(URL.createObjectURL(blob), "_blank");
  } catch (err) {
    console.error("Export failed:", err);
  }
}
