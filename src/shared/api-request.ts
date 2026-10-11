/** The rules a daemon API request follows, kept away from `fetch` so they can
 *  be tested without a browser — the same reason `view-url.ts` is window-free.
 *
 *  These are not stylistic preferences. Each one was a failure observed on a
 *  741ms-RTT satellite link (`claude-4gqgp27l:9`), where the app's four
 *  opening requests were aborted at exactly 10.00s having transferred zero
 *  bytes, each still waiting on a CORS preflight that had never returned. The
 *  reason the rules live here rather than inline is that **breaking them is
 *  invisible on a fast network**: put an `Authorization` header back on a GET
 *  and every LAN test still passes, while the app becomes unusable on a bad
 *  link. A regression that only reproduces at 35,000 feet needs a unit test.
 */

/** Content types the CORS spec safelists. Anything else on a request makes it
 *  "not simple" and forces a preflight round trip before the request may be
 *  sent at all. `application/json` is famously absent. */
const SAFELISTED_CONTENT_TYPES = [
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
];

/** Header names a request may carry and still be CORS-simple. */
const SAFELISTED_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-language",
  "content-type", // only with a safelisted value — checked separately
  "range",
]);

const SIMPLE_METHODS = new Set(["GET", "HEAD", "POST"]);

/** Whether the browser must send a preflight `OPTIONS` and wait for its answer
 *  before this cross-origin request may begin.
 *
 *  This is the whole cost model. A preflight is not "some overhead": it is a
 *  full round trip — and, on a cold connection, its own TCP and TLS handshake
 *  — that happens *before* the request you wanted exists on the wire. At LAN
 *  latency it is unmeasurable. At 741ms it is the difference between an app
 *  that loads and one that does not. */
export function requiresPreflight(
  method: string,
  headers: Record<string, string> = {},
): boolean {
  if (!SIMPLE_METHODS.has(method.toUpperCase())) return true;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!SAFELISTED_HEADERS.has(lower)) return true;
    if (lower === "content-type") {
      const essence = value.split(";")[0].trim().toLowerCase();
      if (!SAFELISTED_CONTENT_TYPES.includes(essence)) return true;
    }
  }
  return false;
}

/** No headers, so a request stays CORS-simple. The emptiness is the point;
 *  see `requiresPreflight`. */
export const NO_HEADERS: Record<string, string> = {};

/** For requests that carry a body. This preflights, and that is a considered
 *  choice rather than an oversight: the alternative is labelling JSON as
 *  `text/plain` to slip past CORS, and a Content-Type that lies is a trap for
 *  whoever reads the code next. Bodied requests are also the rare ones — the
 *  app reads far more than it writes — and the daemon's `Access-Control-Max-Age`
 *  makes the preflight they do need a daily cost rather than a per-request one. */
export const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
};

/** Put the bearer token in the query string instead of an `Authorization`
 *  header. The daemon has always accepted it there (`src/daemon/server.ts`,
 *  checked immediately after the `Bearer` header), and it is what keeps a
 *  bodiless request simple.
 *
 *  On the token being in a URL: it arrived in one. The meld URL that opens the
 *  app carries `?token=`, so it is already in the address bar and in history,
 *  and these requests address the operator's own daemon — there is no third
 *  party to leak a Referer to. This moves the token nowhere it has not been. */
export function withToken(path: string, token: string): string {
  const [base, hash] = splitHash(path);
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}token=${encodeURIComponent(token)}${hash}`;
}

/** A fragment is not sent to the server, so a token appended after one would
 *  authenticate nothing. Split it off and put it back at the end. */
function splitHash(path: string): [string, string] {
  const i = path.indexOf("#");
  return i === -1 ? [path, ""] : [path.slice(0, i), path.slice(i)];
}

/** How long a request may take before it is abandoned.
 *
 *  Was 10s, which is generous on a LAN and unreachable on a satellite link: at
 *  741ms RTT roughly 0.75s of TCP handshake and 1.5s of TLS elapse before a
 *  request byte moves, and TCP needs about ten round trips to open its window.
 *  60s costs a healthy network nothing — a fast request still returns fast,
 *  since this is a ceiling and not a delay. */
export const DEFAULT_TIMEOUT_MS = 60_000;

export const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

/** Only replay requests that cannot have had an effect.
 *
 *  A timed-out POST is genuinely ambiguous: the daemon may have received it,
 *  spawned the agent, and simply been too slow to say so. Retrying that
 *  silently spawns a second one. Reporting the error is the lesser harm, and
 *  it is the operator's call to make. */
export function isRetryableMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD";
}

/** Retry transport failures only — cases where no response ever arrived.
 *
 *  An HTTP error is an answer, not a failure to communicate: a 404 is a fact
 *  that will not change on a second ask, and a 500 may have had effects. Only
 *  a request that never landed is safe to send again. */
export function isRetryableError(err: unknown): boolean {
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    return err.name === "AbortError";
  }
  if (err instanceof Error && err.name === "AbortError") return true;
  // `fetch` reports network failure as a bare TypeError.
  return err instanceof TypeError;
}

/** Exponential backoff. A link that just dropped a request is often still
 *  congested; retrying instantly mostly adds to the pile. */
export function retryDelayMs(attempt: number): number {
  return RETRY_BASE_MS * 2 ** attempt;
}
