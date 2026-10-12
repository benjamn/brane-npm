import { useEffect, useState } from "react";
import { probeDaemon, type ConnectionParams } from "@/lib/api";
import { cleanAppHost } from "@shared/app-origin";

/** What each daemon reports as its `app_domain`, by connection host, so the
 *  app asks once. The in-flight probe is cached too, so a screen that mounts
 *  many callers at once (the narrative list, one per card) shares one
 *  request rather than queueing one per row behind the browser's per-host
 *  limit. A daemon that could not be reached is *not* remembered: the next
 *  caller tries again. `null` is the answer of a daemon from before the
 *  field, or one whose config is empty. */
const known = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();

function probeAppHost(conn: ConnectionParams): Promise<string | null> {
  const key = conn.host;
  const cached = known.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  let pending = inFlight.get(key);
  if (!pending) {
    pending = probeDaemon(conn.host, conn.token)
      .then((status) => {
        const value = typeof status.app_domain === "string" ? cleanAppHost(status.app_domain) || null : null;
        known.set(key, value);
        return value;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

/** The shared app's host for the daemon `conn` reaches, read from
 *  `GET /api/status` — where a daemon's own bundle hops *out* to on Isolate
 *  (`buildIsolateUrl`, src/shared/view-url.ts). The app carries no host of
 *  its own, so a fork's daemon names the fork's shell. Fetched only when
 *  `wanted` (the page is isolated); a shared app never needs it. The value
 *  has to be in hand before the tap, since `window.open` after an await is
 *  a popup the browser blocks. Null until it is known, and again the moment
 *  `conn` changes to a daemon it is not known for, so a previous daemon's
 *  host is never shown for the next. */
export function useAppHost(conn: ConnectionParams | null, wanted: boolean): string | null {
  const key = conn?.host ?? null;
  const [host, setHost] = useState<string | null>(() => (key ? known.get(key) ?? null : null));
  useEffect(() => {
    if (!conn || !key || !wanted) {
      setHost(null);
      return;
    }
    setHost(known.get(key) ?? null);
    if (known.has(key)) return;
    let cancelled = false;
    probeAppHost(conn)
      .then((value) => {
        if (!cancelled) setHost(value);
      })
      .catch(() => {
        if (!cancelled) setHost(null);
      });
    return () => {
      cancelled = true;
    };
  }, [conn, key, wanted]);
  return host;
}
