/**
 * Handing a daemon file to the operator.
 *
 * Never by navigating to it. Every daemon URL carries `?token=`, and a URL
 * the browser turns into a document puts that token in the address bar and
 * in the base URL "Save Page As" resolves the page's relative links against
 * — which is how a saved file ends up containing the token. Fetching the
 * bytes and saving them from a `blob:` URL keeps the token in the request,
 * where it belongs; the object URL the operator's browser sees carries
 * nothing at all.
 *
 * The daemon's own `Content-Disposition: attachment` (see
 * `src/shared/payload-inline.ts`) is the other half of this: it is what
 * stops a payload URL reaching a browser by some other route from becoming
 * a page. Either one alone fixes the case we hit; both is what keeps it
 * fixed.
 */

/** How long the `blob:` URL has to outlive the click. Revoking it in the
 *  same tick cancels the download in Safari, and holding it forever leaks
 *  the blob for the life of the tab. */
const OBJECT_URL_TTL_MS = 60_000;

/** Fetch `url` and save it as `filename`. Web only — there is no anchor to
 *  click anywhere else, and every call site is already inside a web guard.
 *
 *  The fetch is a bodiless GET with no custom headers, so it stays
 *  preflight-free like every other read (see `src/shared/api-request.ts`).
 *  Throws if the daemon refuses; callers decide whether that is worth
 *  saying out loud. */
export async function downloadUrl(url: string, filename: string): Promise<void> {
  if (typeof document === "undefined") {
    throw new Error("downloadUrl is web-only");
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  a.rel = "noopener";
  // Safari starts the download from a node that is in the document.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), OBJECT_URL_TTL_MS);
}

/** The name to save a `/api/payloads/<nid>/<file>` or fold path under. */
export function downloadNameFor(path: string): string {
  return path.split("/").pop() || "download";
}
