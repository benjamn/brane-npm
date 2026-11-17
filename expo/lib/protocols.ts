import { useCallback, useEffect, useRef, useState } from "react";
import type { ProtocolNamespace } from "@shared/protocol-names";
import { listProtocols, type ConnectionParams } from "@/lib/api";

/** What a screen needs to link and open `/commands`: every name that resolves
 *  to a file (bare and qualified), and for each bare name the namespaces that
 *  have it, most local first — what `protocolReaderTarget` reads. */
export interface ProtocolView {
  commands: Set<string>;
  layers: Record<string, ProtocolNamespace[]>;
  /** False until this view's own fetch has answered. A screen falls back to
   *  the connection-wide view meanwhile (and for good, if the fetch fails),
   *  so its links never start dark. */
  loaded: boolean;
  /** Protocol files here awaiting the operator's approval: not in force, and
   *  so not linked, until approved (docs/protocols.md#approval). */
  pending: PendingProtocol[];
  /** Fetch again: after an approval, say. */
  refresh: () => void;
}

export interface PendingProtocol {
  from: ProtocolNamespace;
  /** The protocol's name: the file's, less `.md`. */
  name: string;
  path: string;
  sha256: string;
  /** An earlier version was approved; this one isn't. */
  changed: boolean;
}

export const EMPTY_PROTOCOL_VIEW: ProtocolView = { commands: new Set(), layers: {}, loaded: false, pending: [], refresh: () => {} };

/** The protocol library as narrative `nid` sees it (its fold's, then the
 *  operator's, then brane's), or without `nid` the operator's and brane's.
 *  Fetched once per connection and narrative: a protocol file added later
 *  shows up when the screen next mounts. It starts empty and unloaded. */
export function useProtocolView(conn: ConnectionParams | null, nid?: string): ProtocolView {
  const [view, setView] = useState<ProtocolView>(EMPTY_PROTOCOL_VIEW);
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration((g) => g + 1), []);
  const shownFor = useRef<unknown[]>([]);
  useEffect(() => {
    // A different narrative's view is not this one's, even for a moment; a
    // refresh of the same one keeps showing what it had until it answers.
    if (shownFor.current[0] !== conn || shownFor.current[1] !== nid) setView(EMPTY_PROTOCOL_VIEW);
    shownFor.current = [conn, nid];
    if (!conn) return;
    let cancelled = false;
    listProtocols(conn, nid)
      .then(({ protocols, commands, ignored }) => {
        if (cancelled) return;
        // A daemon too old to report layers serves built-ins only; leaving
        // `layers` empty tells `protocolReaderTarget` so.
        const layers: Record<string, ProtocolNamespace[]> = {};
        for (const p of protocols) if (p.layers) layers[p.name] = p.layers.map((l) => l.from);
        const pending: PendingProtocol[] = ignored
          .filter((i) => i.pending && i.from !== "brane")
          .map((i) => ({
            from: i.from,
            name: (i.path.split("/").pop() ?? i.path).replace(/\.md$/, ""),
            path: i.path,
            sha256: i.pending!.sha256,
            changed: i.pending!.changed,
          }));
        setView({ commands: new Set(commands), layers, loaded: true, pending, refresh });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [conn, nid, generation, refresh]);
  return view;
}
