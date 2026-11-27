# The Request Layer

Every call from the app to a daemon is **cross-origin** — the bundle is served
from `brane.organelle.dev` (or another daemon's copy of it) while the daemon
answers on its own Tailscale host. That fact is free on a LAN and decisive on
a bad link, because CORS makes the browser *ask permission before asking the
question*: a request that is not "simple" gets a preflight `OPTIONS` and may
not be sent until the answer comes back.

The cost was measured rather than assumed. On in-flight satellite wifi at
**741 ms RTT** (`tailscale ping`, direct path — not a DERP relay and not the
travel router), the app's four opening requests — narratives, folds, branes,
protocols — were each aborted at exactly **10.00 s having transferred zero
bytes**, every one still waiting on a preflight that had never returned.
Nothing was slow. Nothing had started.

Three things were wrong, and only the third is the one you would guess:

| | Was | Is |
|---|---|---|
| Bodiless requests | `Authorization` + `Content-Type: application/json` → preflight | no headers at all, token in `?token=` → **no preflight** |
| Preflight caching | no `Access-Control-Max-Age`; Chrome's default is **5 s** | `86400`, so a bodied request's preflight is a daily cost |
| Timeout | 10 s, no retry | 60 s, with backoff on transport failures |

`src/shared/api-request.ts` holds the rules, window-free so they can be tested
without a browser — the same arrangement as `view-url.ts`, and for a sharper
reason. **Breaking these rules is invisible on a fast network.** Put an
`Authorization` header back on a GET and every local test still passes while
the app becomes unusable at altitude, so the invariant is pinned by
`src/test/api-request.test.ts`, which reads `expo/lib/api.ts` and asserts that
no request sets that header and that `JSON_HEADERS` appears only where a
`body:` does.

| Piece | Does |
|---|---|
| `requiresPreflight()` | The CORS cost model itself — safelisted methods, headers, and content types |
| `withToken()` | Token into the query string, joining an existing one with `&` and staying in front of a `#` |
| `isRetryableMethod()`, `isRetryableError()` | What may be replayed |
| `DEFAULT_TIMEOUT_MS` | 60 s |
| `controlDialTimeoutMs()` | The control socket's dial: 5 s, 10 s, then 15 s, lengthening with each dial that never opened |
| `guardResponseBody()`, `readBodyWithIdleTimeout()` | The same deadline over the body: abort when no chunk arrives for that long |
| `setCorsHeaders()` | `src/daemon/server.ts`; exported for `src/test/cors-preflight.test.ts` |

Three decisions are less obvious than they look:

**The token moves to the URL, and that is not a downgrade.** It arrived in a
URL — the meld link that opens the app carries it (in the fragment, since the
[View URLs](view-urls.md) change; before that, as `?token=`). These requests
address the operator's own daemon, so no third party sees a `Referer` for
them, and the query string here goes to the daemon and nowhere else. The daemon
has always accepted the parameter, checked immediately after the `Bearer`
header; nothing on the server needed to change to allow it.

**Bodied requests still preflight, deliberately.** `application/json` is not a
CORS-safelisted content type, and the way to dodge that is to label JSON as
`text/plain` — a Content-Type that lies, and a trap for whoever reads the code
next. The app reads far more than it writes, so the honest header is cheap;
`Access-Control-Max-Age` is what makes it rare.

**Only idempotent requests retry.** A timed-out `POST /api/spawn` is genuinely
ambiguous — the daemon may have spawned the agent and merely been too slow to
say so. Replaying that spawns a second one. An HTTP error is likewise an
*answer* and never retried: a 404 will not change on a second ask, and a 500
may have had effects. Only a request that provably never landed is safe to
send again.

<a id="a-slow-request-is-not-re-sent"></a>
**A slow request is not re-sent; a stuck dial is.** Every attempt of a
request waits the whole timeout for its response to begin. An earlier
version of this layer gave the first attempts only 8 s and then 20 s, on the
theory that a connection opened while the path was dark sits in TCP's SYN
backoff (1, 2, 4, 8, 16, 32 s) and a fresh one would be answered sooner. It
was taken out before release: a GET the daemon is still working on would be
cancelled and sent again, two or three times, and the incident it was meant
for (2026-11-26, the phone unable to reach any daemon until its Tailscale
was restarted) turned out to be the phone's Tailscale replying through a
relay it had already left, which no fresh connection fixes. The control socket's dial is the exception,
because a WebSocket that has not opened has sent the daemon nothing: it is
closed and re-dialed if it hasn't opened in 5 s, then 10, then 15
(`controlDialTimeoutMs`), and a dial that timed out is followed by the next
at once, not after the usual 2 s.

<a id="the-deadline-covers-the-body"></a>
**The deadline covers the body.** `fetch` resolves when the headers arrive,
and the timer that guarded it used to be cleared there, so a response whose
body stalled halfway (a tailnet path that dropped after the first packets)
left `res.json()` pending forever: no error, no retry, a spinner. It was
reproduced against a server that sends headers and half a body and then
nothing: the read was still pending at twenty times the timeout and settled
only when the connection was killed. `guardResponseBody()` now wraps every
response `fetchAttempts` returns: `json`, `text`, `arrayBuffer` and `blob`
read through `readBodyWithIdleTimeout()`, which aborts the request when no
chunk has arrived for the request's timeout. It is an idle deadline, not a
total one, so a large body on a slow link that keeps moving is never cut
off. A caller that streams `res.body` itself is left alone. Pinned by the
stalling-server cases in `src/test/api-request.test.ts`.

**HTTP/2 would help and is not available.** One connection instead of Chrome's
six means one TLS handshake instead of six, which is worth real time at this
RTT. But all three WebSocket endpoints ride the HTTP/1.1 `Upgrade` mechanism,
which HTTP/2 replaces with extended CONNECT (RFC 8441) — and `ws` does not
implement the server side. ALPN is negotiated per origin, not per request, so
advertising h2 would take the control channel, the MCP bridge and terminal
mirroring down with it. It stays on the table as its own change, gated on a
WebSocket transport that survives it.
