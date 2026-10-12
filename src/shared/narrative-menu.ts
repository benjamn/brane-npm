/**
 * The 🦠 menu's *shape* — icons, labels, and which items a given narrative
 * gets — in one place, so the two surfaces that offer it (the detail header's
 * 🦠 button and the list card's status badge) cannot drift apart. Adding an
 * item here adds it to both; that is the whole point of the module.
 *
 * Lives in `shared/` rather than beside the components because it is pure: no
 * React, no window, no network. That makes the "cannot drift" claim something
 * the node suite can actually check (`src/test/narrative-menu.test.ts`) rather
 * than something a comment asserts.
 */

/** Structurally the app's `ContextMenuItem`, declared here so this module stays
 *  free of the component layer. The two are checked against each other where
 *  `expo/components/NarrativeMenu.tsx` re-exports this builder. */
export interface NarrativeMenuItem {
  label: string;
  icon?: string;
  onPress: () => void;
}

/** Roles with no tmux process to resume: reviving them means twinning instead —
 *  an external session (an MCP client that connected without `brane spawn`) or
 *  an absorbed import, neither of which has an agent to restart.
 *
 *  Stated once because three places need to agree on it: the pane that turns
 *  Revive into Twin, the detail screen that must not rewrite its view for a
 *  revive that is really going to open a dialog, and the list that should ask
 *  the same question the detail screen asks. */
export function revivesAsTwin(role?: string | null): boolean {
  return role === "external" || role === "absorbed";
}

/** Which side of the chat's message selection an Export item asks for.
 *  `"all"` ignores the selection entirely — it is what the item means when
 *  there is nothing selected, and what the list card's Export always means. */
export type ExportScope = "all" | "selected" | "excluded";

export interface NarrativeMenuOptions {
  role?: string | null;
  status?: string | null;
  mcpConnected?: boolean | null;
  archived?: boolean;
  /** Whether the app is currently served from a daemon's own bundle. */
  isIsolated?: boolean;
  /** False when there is nowhere for Isolate to go: a daemon's own bundle
   *  whose daemon reported no app host (`app_domain` in `/api/status`). The
   *  item is left out rather than offered as a link to a host the app made
   *  up. A shared app can always hop in to the daemon, so it is never false
   *  there. */
  canIsolate?: boolean;
  /** How many messages the chat currently has selected. Nonzero splits Export
   *  into the two sides of that selection, and says so on each item — the
   *  selection lives in the detail screen, and this is the only place the menu
   *  learns of it. The list card has no selection and passes nothing. */
  selectedCount?: number;
  onMeld: () => void;
  onIsolate: () => void;
  /** Export, told which side of the selection was asked for. `"all"` is the
   *  only scope a menu with no selection offers, and is what every Export was
   *  before a selection could be exported. */
  onExport: (scope: ExportScope) => void;
  /** Reshuffle the hues foreign speakers wear in this narrative — a view
   *  preference kept on this device, not a change to the narrative. */
  onRecolor: () => void;
  onTwin: () => void;
  onRevive: () => void;
  onEnd: () => void;
  onArchiveToggle: () => void;
}

export function narrativeMenuItems({
  role,
  status,
  mcpConnected,
  archived = false,
  isIsolated = false,
  canIsolate = true,
  selectedCount = 0,
  onMeld,
  onIsolate,
  onExport,
  onRecolor,
  onTwin,
  onRevive,
  onEnd,
  onArchiveToggle,
}: NarrativeMenuOptions): NarrativeMenuItem[] {
  const isEnded = status === "ended" && !mcpConnected;
  // External narratives have no tmux process — no in-place End/Revive applies;
  // their only lifecycle action is Twin (continue into a brane-managed agent).
  // Absorbed imports twin as well, but they reach it *through* Revive, which is
  // why they keep the item and `external` does not: an import is a transcript
  // you continue, an external session is one you can only fork.
  const isExternal = role === "external";
  return [
    { icon: "🖖", label: "Meld", onPress: onMeld },
    ...(canIsolate
      ? [{
          icon: isIsolated ? "🏘️" : "🏠",
          label: isIsolated ? "Unisolate" : "Isolate",
          onPress: onIsolate,
        }]
      : []),
    // With a selection, Export becomes two items — the picks, or everything but
    // the picks — because a selection is as often "these are the interesting
    // ones" as "these are the ones nobody else should read". Both items name
    // the same N: it is the count the operator can see highlighted, and the
    // complement's own message count exists only on the daemon.
    //
    // 📤 rather than ✂️ for the second: scissors in a menu that also holds
    // Archive read as a deletion, and an export removes nothing from anything.
    ...(selectedCount > 0
      ? [
          {
            icon: "📨",
            label: `Export ${selectedCount} selected`,
            onPress: () => onExport("selected"),
          },
          {
            icon: "📤",
            label: `Export ${selectedCount} excluded`,
            onPress: () => onExport("excluded"),
          },
        ]
      : [{ icon: "📨", label: "Export", onPress: () => onExport("all") }]),
    // Recolor sits with Export rather than the lifecycle verbs below it: both
    // act on how the narrative is *seen*, and neither touches the daemon.
    { icon: "🎨", label: "Recolor", onPress: onRecolor },
    // Twin is available on every narrative — fork/continue it into a
    // new brane-managed agent (UI-gated via the spawn dialog). A plain verb
    // like its neighbors; the /twin protocol syntax belongs to the dialog the
    // press opens and to the line the resulting narrative starts with.
    { icon: "🧬", label: "Twin", onPress: onTwin },
    ...(isExternal
      ? []
      : [
          isEnded
            ? { icon: "🐦‍🔥", label: "Revive", onPress: onRevive }
            : { icon: "🫠", label: "End", onPress: onEnd },
        ]),
    {
      icon: archived ? "📂" : "🗄️",
      label: archived ? "Unarchive" : "Archive",
      onPress: onArchiveToggle,
    },
  ];
}
