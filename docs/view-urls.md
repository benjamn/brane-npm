# View URLs

The query string of a narrative screen is not decoration — it is the only way
a view travels. Active tab, pinned tabs, open file and line range are kept in
`sessionStorage`, which is **origin-scoped**, and two menu items cross an
origin: **Isolate** hops between a shared app's origin and a daemon's own
bundle, and **Meld** hands a URL to another device. Whatever is not in the URL
does not arrive.

`src/shared/view-url.ts` holds the contract, window-free so it can be tested
without a browser (`src/test/view-url.test.ts` runs it over a grid of every
tab, pin subset, path and line spec):

| Piece | Does |
|---|---|
| `viewParams()` | The view as params, `undefined` for anything at its default — which is how `router.setParams` clears one |
| `parseActiveTab()`, `parsePinnedTabs()`, `parseLineSpec()` | Read them back. Writer and reader live together on purpose: a param whose two halves sit in different modules drifts |
| `isIsolated(pageHost, daemonHost)` | Whether this page is the daemon's own bundle: `location.host` against the connection's host, no constant in it |
| `buildViewUrl(target, opts)` | The same narrative, same view, somewhere else |
| `buildIsolateUrl()` / `buildMeldUrl()` | The same builder with one bit different — see below. Isolate is `null` from a daemon's bundle that reported no app host |
| `withoutConnectionParams()`, `withoutConnectionHash()` | Strip `host`/`token` from the query string and from the fragment, and leave everything else |
| `connectionFragment()` | `#host=…&token=…` for the shared app, `#token=…` for a daemon's own bundle — the one place the connection is written into a URL, used by `buildViewUrl` and by `brane meld` |

**Isolate flips the origin kind; Meld stays on it.** Isolate exists to change
which app serves you. Meld aims at another *device* — hand a phone a shared-app
link while the operator is reaching the daemon directly, and the phone loads an
app that has never heard of that daemon.

**The app knows no host.** There is no constant naming `brane.organelle.dev`
in the bundle, and `src/test/app-host-literal.test.ts` keeps it that way.
"Isolated" means *this page is served by the daemon it is connected to*:
`window.location.host` equal to the connection's host, which a daemon's own
bundle fills from the same `location.host`. Everything else is a shared app,
whichever host serves it: the hosted shell, a staging hostname, a fork's
deployment, a dev server on `localhost`. From a shared app, Meld stays on
*that* origin and Isolate hops in to the daemon; neither needs to be told a
host. From a daemon's bundle, Isolate hops *out* to whatever the daemon
reports as its `app_domain` in `GET /api/status` (`useAppHost`,
`expo/lib/appHost.ts`, fetched before the tap, since a `window.open` after an
await is a popup the browser blocks). A daemon that reports none, or cannot
be reached for it, has no way out, and the menu leaves Isolate out rather
than hand you a link to a host the app made up. `brane meld` reads the same
config, so a fork changes `CONFIG_DEFAULTS.app_domain` and both its CLI and
its daemons name its own shell. None of this is trust: the daemon accepts any
origin (`SECURITY.md`, Authentication); the host only decides which copy of
the app a browser loads.

**Back undoes a jump, never a view change.** A jump pushes a history entry: to
a different narrative (from the list, an `@nid` link, the switcher, Revive or
Twin), and to a message by `nid:seq`, *including one in the narrative you are
already reading*. That last case is what makes a `/summarize` summary usable as
a table of contents: tap a citation, read, press Back, and you are where you
were, ready for the next one. Changing the view *within* a narrative (tab,
pins, Files path and line, the `?scrollToSeq=` selection) goes through
`router.setParams`, which Expo Router's linking writes with `replaceState`,
since the stack did not grow. So the URL keeps that state and Back returns to
it, but it never costs an extra Back: browsing ten files is one entry, not ten.
A bare link to the narrative you are in, with no seq, goes nowhere. The list
is a jump too: **All narratives** in the switcher pushes it, so Back returns
to the narrative, whether or not a list was already beneath. So does a
swipe down on the narrative's header card, which dismisses it. So does
**Archive** in the narrative's 🦠 menu, once the daemon has confirmed it (the
pushed list fetches on mount, and nothing is broadcast to correct a fetch that
raced the archive); Back returns to the archived narrative. Archiving from the
list's own menu just drops the row and goes nowhere. The header has no
← of its own; Back is the browser's.

Back is instant and complete because the Stack keeps the screens behind the
top one mounted. The list behind a narrative still holds its search query and
results, and the narrative behind another (or behind a later copy of itself)
still holds its scroll, selection and open file. Nothing is rebuilt from
storage. A deep stack is left mounted on purpose: on the web, a new tab is the
way out of one. Because two mounted screens can watch the same narrative,
`subscribe`/`unsubscribe` in `expo/lib/connection.ts` are refcounted. Otherwise
the top screen's unmount would silence the one that Back returns to.

Staying mounted has a cost: a screen behind the top still runs its effects, so
a listener it registers on `document` still hears every event on the page,
including taps on the screen in front. And `router.setParams` is the *global*
router: it writes to whichever route is focused, not to the screen that
called it. So a backgrounded screen that reacts to a document event by writing
its view writes it into the URL of the screen you are looking at, and that
screen's URL-sync effect adopts it. That is how tapping a Terminal pane once
opened and pinned Chat: the narrative underneath was on its Chat tab, its
pane-select handler pinned the outgoing Chat, and the pin landed on top. Every
document-level listener in `[nid].tsx` is therefore gated on `useIsFocused()`,
the same rule #342 applied to keystrokes.

**Why a same-narrative jump is a new screen, not a scroll.** Expo Router (v55,
React Navigation 7) has no way to add a history entry without growing a stack:
no `pushParams`, and `singular`/`getId` reuse a screen by moving it, which
shrinks the stack. A scroll-in-place jump with its own `pushState` was tried
(#554) and the Back entry was set aside, because the router keeps its own model
of the history stack. An entry it didn't write makes browser Back `resetRoot`
the stack (unmounting what's under it) and made the header's own ← (since
removed; the browser's Back is the only one) miscount its `history.go(n)`.
Re-rendering the screen costs a React render, not a page load.

**Seed from the URL, then overlay live state.** Seeding carries params the
screen doesn't model (`scrollToSeq`). The overlay wins on everything it does
own, because a tab layout restored from `sessionStorage` deliberately never
writes itself back to the URL (`router.setParams` there can run before the root
layout mounts and blank the screen). A copy of `window.location.search` alone
would miss exactly that case.

**Connection params are never carried, only re-set.** They describe the origin
building the link. And the receiving side cleans them: `clearMeldUrl` in
`app/_layout.tsx` strips `host`/`token` from the address bar once the meld has
been used — with `withoutConnectionParams` and `withoutConnectionHash`, *not*
by resetting to the bare pathname, which would throw away the view that just
arrived.

**The connection rides in the fragment; the view rides in the query string.**
A query string is part of the HTTP request. On a shared-app link that meant
the daemon's bearer token and tailnet hostname reached the shell host's edge
with every meld; on an Isolate hop it landed in the daemon's own request
log; and a meld URL pasted into iMessage or Slack handed it to the link
unfurler. A fragment is never sent to any server, so `#host=…&token=…` is what
every link carries now (`connectionFragment`), and `?token=` is read only for
old QR codes and bookmarks. The view stays in the query string because it is
harmless to share and because the fragment belongs to the connection.

**The fragment must be consumed before Expo Router reads the URL.** On web the
router parses the initial URL's hash into a route param named `#` and appends
it again every time it writes the URL (`appendQueryAndHash` in its
`getPathFromState` fork, and `routeInfo`). Consume it in a `useEffect` and
strip it with `replaceState`, and the next `router.setParams` — a tab change,
a pin, an opened file — writes the token straight back into the address bar
and the back stack. So `expo/lib/api.ts` runs `consumeConnectionFromLocation`
at **module evaluation**: the credentials go into the `sessionStorage` slot
`parseConnectionParams` already falls back to, and the URL is rewritten
without them, view intact. Query params get the same treatment. Observed in a
headless browser (claude-7irbudpw:65): the router still restores the hash on
its *first* URL write, so the fragment is visible while the "Meld this
device?" dialog is up; `clearMeldUrl` removes it at confirm, and it did not
come back across an in-app card tap and two tab changes. So the module-level
consume is what gets the credentials into storage early, `clearMeldUrl` is
what actually clears the address bar, and `clearStoredConnection` still ends
the flow.
