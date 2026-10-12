/** An `Origin` header as a Devices list shows it: the host, port included
 *  when it has one, without the scheme. `https://main.brane.organelle.dev`
 *  reads "via main.brane.organelle.dev"; a daemon's own bundle reads "via
 *  mac.tail1234.ts.net:47443". Anything that is not a URL is shown as it
 *  came (already stripped of control characters by the store). */
export function originHost(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/** A host as `app_domain` or `--app` may give it: a bare host, or a URL whose
 *  host is taken (`https://main.brane.organelle.dev/` reads as the host), with
 *  a port kept if there is one, lower-cased. Every reader of `app_domain`
 *  goes through this — `brane meld`, `GET /api/status`, the app — so a value
 *  stored in URL form by `brane config` builds the same link everywhere,
 *  rather than a QR that works beside an Isolate link that reads
 *  `https://https://…`. Empty in, empty out. */
export function cleanAppHost(value: string): string {
  const trimmed = value.trim();
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(trimmed);
  return (m ? m[1] : trimmed.replace(/[/?#].*$/, "")).toLowerCase();
}
