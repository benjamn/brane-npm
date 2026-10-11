# Link Previews

A brane URL pasted into iMessage, Slack, Discord or Telegram gets a card,
and the card is built from the HTML the URL serves — by a fetcher that
never runs the bundle. That bounds what the card can be, and the bound is
by design: the daemon's host and token ride in the fragment ([View
URLs](view-urls.md)), which no fetcher sends, and the daemon itself is
tailnet-only. So a card can carry what brane *is* and what it looks like,
never a narrative's title, summary or messages. (iMessage is the one app
that unfurls on the *sender's* device, which is on the tailnet — but a
direct-daemon link still serves the same shell, so it sees the same card.)

The card is `og:*` and `twitter:card` tags in **`expo/public/index.html`**,
the template that actually ships, with `app/+html.tsx` kept in step the way
the KaTeX and manifest links are. The picture is the 膜 — a still of the
real `Membrane` component, not a hand-ported approximation of its shader —
at `public/og/membrane.v<N>.png` (1200×630, the size every unfurler renders
as a large card), plus `public/apple-touch-icon.png` (180×180, which is
what iMessage's small card and an iOS home-screen add use; the SVG favicon
counts for neither). `expo/scripts/og-membrane/render.mjs` produces both
by mounting the component alone in a headless Chromium and screenshotting
it; each run rolls a fresh scheme, so run it until a frame pleases, then
**bump the version in the filename and in both `og:image` tags** — iMessage
caches a preview by URL until the URL changes. `src/test/link-preview.test.ts`
pins that the two heads agree, that the URL names a file `public/` ships at
the declared size, and that the name is versioned.

Two things are less obvious than they look:

**The image URL is absolute, on the shared host.** A daemon's own bundle
serves this same `index.html`, and a phone unfurling a direct-daemon link
can still fetch `https://brane.organelle.dev/og/…` — a relative path would
point at the daemon, which the fetcher may or may not reach.

**Stills only.** iMessage, Telegram, Discord and Facebook will animate an
`og:video` loop, and Slack alone offers an interactive card, through a
registered app. Neither is used: the card is a picture, by decision
(claude-hun39p6w:10).
