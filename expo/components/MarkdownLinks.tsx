import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useBrane } from "@/app/_layout";
import type { ProtocolNamespace } from "@shared/protocol-names";

/** What `MarkdownContent` needs to turn a bare `claude-4c7289d1` or `/ramify`
 *  into a link: the sets that say which ones are real, and what tapping one
 *  does. Every markdown host on a screen wants the same four values, so they
 *  flow through context once per screen instead of being threaded through
 *  each host's props — the pattern under which one host forgets one prop and
 *  linkification quietly goes dark there (as Files did for `/command`). */
export interface MarkdownLinks {
  knownNarrativeIds?: Set<string>;
  /** Protocol names that exist on this daemon; only these linkify. Defaults
   *  to the daemon's protocol list from `useBrane()`. */
  knownProtocols?: Set<string>;
  /** For each protocol name, the namespaces that have it, most local first,
   *  from the same library as `knownProtocols`: what a tapped `/command`
   *  opens (`protocolReaderTarget`). Defaults to `useBrane()`'s. */
  protocolLayers?: Record<string, ProtocolNamespace[]>;
  onNarrativePress?: (nid: string, seq?: number) => void;
  onProtocolPress?: (name: string) => void;
}

const MarkdownLinksContext = createContext<MarkdownLinks>({});

/** Supplies link handling to every `MarkdownContent` beneath it. Nests: a
 *  provider inside another overrides only the fields it sets, so a modal that
 *  must close itself before navigating can wrap its subtree with just a new
 *  `onNarrativePress` and inherit the rest. */
export function MarkdownLinksProvider({ children, ...own }: MarkdownLinks & { children: ReactNode }) {
  const parent = useContext(MarkdownLinksContext);
  const { protocols, protocolLayers: braneLayers } = useBrane();
  const { knownNarrativeIds, knownProtocols, protocolLayers, onNarrativePress, onProtocolPress } = own;
  const value = useMemo<MarkdownLinks>(() => ({
    knownNarrativeIds: knownNarrativeIds ?? parent.knownNarrativeIds,
    knownProtocols: knownProtocols ?? parent.knownProtocols ?? protocols,
    protocolLayers: protocolLayers ?? parent.protocolLayers ?? braneLayers,
    onNarrativePress: onNarrativePress ?? parent.onNarrativePress,
    onProtocolPress: onProtocolPress ?? parent.onProtocolPress,
  }), [parent, protocols, braneLayers, knownNarrativeIds, knownProtocols, protocolLayers, onNarrativePress, onProtocolPress]);
  return <MarkdownLinksContext.Provider value={value}>{children}</MarkdownLinksContext.Provider>;
}

export function useMarkdownLinks(): MarkdownLinks {
  return useContext(MarkdownLinksContext);
}
