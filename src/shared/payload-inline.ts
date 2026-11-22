/**
 * What a payload is allowed to *become* in a browser.
 *
 * Every daemon URL carries `?token=` in its query string (see
 * `api-request.ts` for why it is there rather than in a header). That is
 * harmless while the response is data — an `<img>`, a `fetch` — and stops
 * being harmless the moment the browser makes a *document* of it: the token
 * is then in the address bar, in history, and in the base URL that "Save
 * Page As" resolves the page's relative links against, which is how a daemon
 * token gets written into a saved file.
 *
 * So there is one rule, and both halves of the system have to agree on it:
 * the app renders image payloads inline, plays video payloads in a native
 * `<video>`, and hands everything else over as a file; the daemon serves
 * everything else with `Content-Disposition: attachment` so a payload URL
 * that reaches a browser some other way still cannot become a page.
 *
 * Videos are their own table, not more rows in the image one, because the
 * image table has two more readers that must not see them: the lightbox
 * steps through images only, and the HTML export embeds each image as a
 * data URI, which for a video would be megabytes in the file. To both of
 * those a video is still a file.
 */

/** The extensions the app renders inline, with the type each is served and
 *  embedded as. Everything else is a file to be handed over — including
 *  formats a browser *could* display (`.pdf`, `.txt`, `.html`): "can the
 *  browser render it" is not the question, "does brane render it inline" is.
 *
 *  One table rather than a predicate beside a lookup, because the HTML export
 *  needs both answers and a disagreement between them is silent — an image
 *  that passes the filter but misses the type is simply dropped from the
 *  export with nothing said. */
export const INLINE_PAYLOAD_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

/** The extensions the chat plays in a `<video>`, with the type each is
 *  served as. Which of them actually *play* is the browser's business, and
 *  depends on the codec inside, not the container: H.264 in `.mp4` plays
 *  everywhere, HEVC in `.mov` in Safari, VP9 in `.webm` everywhere but older
 *  iOS. A file that won't play still gets the player's own error state and
 *  the download link beside it. */
export const VIDEO_PAYLOAD_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

/** The lowercased extension of a path, `""` when it has none. Hand-rolled
 *  because this module is shared with the app, where `node:path` is not. */
export function payloadExtname(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "";
  const ext = path.slice(dot).toLowerCase();
  // A dot in a *directory* name is not this file's extension.
  return ext.includes("/") ? "" : ext;
}

/** Whether this payload renders inline (an image) rather than downloading. */
export function isInlinePayload(path: string): boolean {
  return payloadExtname(path) in INLINE_PAYLOAD_MIME;
}

/** Whether this payload plays in the chat's `<video>` rather than
 *  downloading. Not an inline payload in the sense above: the lightbox and
 *  the export still treat it as a file. */
export function isVideoPayload(path: string): boolean {
  return payloadExtname(path) in VIDEO_PAYLOAD_MIME;
}

/** Whether the daemon may serve this payload without
 *  `Content-Disposition: attachment`: an image or a video. */
export function servesPayloadInline(path: string): boolean {
  return isInlinePayload(path) || isVideoPayload(path);
}

/** Control characters, which a header has no way to carry: a CR would end
 *  it outright. Stripped rather than escaped — none of them belong in a
 *  filename in the first place. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** The `Content-Disposition` value that hands a payload over as a file.
 *
 *  The header is a quoted-string, so a quote in a filename has to be escaped
 *  or it ends the parameter early; anything non-ASCII additionally
 *  gets the RFC 5987 `filename*` form, since the plain parameter has no
 *  encoding of its own. Both parameters are sent together on purpose — a
 *  browser that understands `filename*` prefers it, and one that doesn't
 *  still gets a usable ASCII name. */
export function attachmentDisposition(filename: string): string {
  // Path separators and control characters never belong in a download name;
  // a payload filename comes from whoever narrated it.
  const safe = filename.replace(/[\\/]/g, "_").replace(CONTROL_CHARS, "") || "download";
  // Backslashes are gone with the separators above, so a quote is the only
  // character left that could end the quoted string early.
  const quoted = safe.replace(/"/g, '\\"');
  const ascii = /^[\x20-\x7e]*$/.test(safe);
  return ascii
    ? `attachment; filename="${quoted}"`
    : `attachment; filename="${asciiFallback(safe)}"; filename*=UTF-8''${encodeRFC5987(safe)}`;
}

/** A best-effort ASCII name for the plain `filename` parameter. */
function asciiFallback(name: string): string {
  const stripped = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return stripped.replace(/^_+$/, "") || "download";
}

function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
