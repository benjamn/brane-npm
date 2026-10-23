# Accessibility

What the web app does for a screen reader and a keyboard, the React Native
Web (RNW) quirks that shape how it is written, and the test that keeps it
that way. The CLI needs none of this: it is text in a terminal, and
`brane attach` puts the operator in tmux with the agent, which VoiceOver,
NVDA and the terminal emulators they work with already handle.

## Where it stands

The first pass made the list → narrative → read → reply loop
workable with a screen reader and a keyboard:

- **Every `Pressable` says what it is.** A `role` (`button`, `link`, `tab`,
  `radio`, `checkbox`), and an `aria-label` wherever the content is a glyph:
  the send 🦋 is "Send", the tab 📌 is "Pin Chat" / "Unpin Chat" with
  `aria-pressed`, the ↑/↓ is "Scroll Chat to top", the 🦠 is "Narrative
  menu" with `aria-expanded`. Text buttons take their name from their text
  and get the role only. A button that swaps its text for a spinner keeps a
  fixed `aria-label` and sets `aria-busy`.
- **Modal backdrops and cards are surfaces, not controls.** The
  tap-to-close backdrop and the card that stops propagation are `Pressable`s
  too; they take `tabIndex={-1}` so a keyboard never lands on them. The
  modal's Close button is the way out, and RN's `Modal` already renders
  `role="dialog" aria-modal="true"`.
- **The narrative cards on the list are links.** They were `<div onClick>`:
  no role, no tab stop, unreachable from a keyboard. They are now
  `role="link"` with `tabIndex={0}`, and Enter opens one when the card itself
  has focus (not the status button inside it). The search-hit rows under a
  card are the same.
- **Markdown headings are headings.** `Markdown.tsx` overrides the
  renderer's `heading` rule to put `role="heading"` and `aria-level` on the
  Text, which RNW renders as `<h1>`–`<h6>`, so a long narration can be walked
  by its headings.
- **Arrivals are announced.** The chat pane holds a polite live region
  (`aria-live="polite"`, a 1px clipped box) whose text is the newest event as
  "speaker: first 240 characters", in a node keyed by the event's seq so the
  same text twice in a row is still two announcements. It says nothing for
  the page that loads with the narrative, so opening one doesn't read its
  last message aloud, and nothing for what the operator sent themselves.
- **The tab labels are toggle buttons** with `aria-pressed` for the pane
  that is showing. Not a `tablist`: a tablist may own only tabs, and the
  pins and scroll arrows sit between these (axe `aria-required-children`).
  A bubble's timestamp button is named by its visible time, since a name
  that omits the visible text fails `label-content-name-mismatch`.
- **Toggles keep one name.** The pin 📌 is always "Pin Chat" and says its
  state with `aria-pressed`; the search 🔬 is always "Search narratives" with
  `aria-expanded`; the 🎹 is "On-screen keyboard" with `aria-pressed`. A
  label that flips under a pressed toggle says the state twice.
- **The fold rows in the Spawn dialog are a `radiogroup`** of `role="radio"`
  with `aria-checked`.
- **The terminal's on-screen keys are named.** Each key `<div>` is
  `role="button"` with the glyph keys spelled out ("Backspace", "Left
  arrow", "Space") and `aria-pressed` on the modifiers. The quick bar's
  🎹, 🥫 and 🦾 buttons are "On-screen keyboard", "Macros" and "Terminal
  controls".
- **Images are named.** RN `Image`s carry `aria-label`; the markdown and
  Files-view `<img>`s already had `alt`.

Still open, in rough order of value:

- **Zoom.** Both viewport tags set `maximum-scale=1, user-scalable=no`, which
  fails WCAG 1.4.4. iOS has ignored the directive since iOS 10, which is why
  the pin script in `expo/public/index.html` and `noPan.ts` already have
  pinch-zoomed branches; Android Chrome honors it. The fix is to drop it
  and add `touch-action: manipulation` on `html, body`, which removes
  double-tap zoom (the accidental one) and keeps pinch. Its own PR.
- **The terminal mirror.** A `<pre>` of per-line `<div>`s inside a
  focusable container that swallows keystrokes: readable as static text,
  but updates are not announced and the cursor is invisible. It needs a
  design of its own, probably a text-mode alternative that announces the
  last changed lines.
- **Focus is invisible.** The composer and the terminal container set
  `outline: none` with no `:focus-visible` replacement.
- **No landmarks.** No `<main>` or `<nav>`, the list and chat are not
  list-semantic, and the tab bar is not a real `tablist` / `tabpanel` pair.

## RNW quirks that shape the code

Checked by rendering the props through `react-native-web` 0.21 in Node
(`renderToStaticMarkup`) before trusting them — a cheap way to see the DOM
a prop combination produces.

- **`role="button"` on a `Pressable` renders a real `<button>`**, not a
  `<div role="button">`. The chat's tap routing already expects this: its
  `INTERACTIVE_SELECTOR` (`button, [role="button"], …`) is what keeps a
  press on a control from re-pointing the keyboard at the pane the control
  sits in. So giving a Pressable a role also makes a tap on it *not* select
  its pane, which is right for a control and a (small) change for the Files
  view's directory rows, which were pane surface before.
- **A real `<button>` brings the UA stylesheet's button font with it.**
  RNW's View reset covers box properties (margin, padding, border,
  display) and not `font`, `line-height`, `text-align` or `color`, so
  inside a `role="button"` Pressable those are the browser's
  `<button>` defaults: `font: -webkit-small-control` (13.33px in
  Chromium, 11px in WebKit), `line-height: normal`, `text-align:
  center`. RNW `Text` sets its own font and color, so text is unaffected
  — but a plain `<div>` holding an inline `Text` is a block with a
  *strut* from the font it inherits, and the line box can never be shorter
  than that strut, whatever `lineHeight` the Text declares. That is how
  #635 shrank the narrative header's summary row: the row's height had
  only ever been the `<body>` default 16px serif strut (≈18px), the
  `lineHeight: 12` on the Text never in effect; as a `<button>` child the
  strut became 15px (Chromium) / 13px (WebKit) and the summary landed on
  the meta line. #637 patched the `text-align` half of the same leak
  without seeing the other half. The fix made the three summary
  scrollers flex containers (`SUMMARY_LINE_HEIGHT`, `NarrativeMeta.tsx`):
  a flex item is blockified, has no strut, and its own `lineHeight` is
  the row. The rule: **a raw `<div>` with inline `Text` inside a
  Pressable takes its line box from the Pressable's element**, so give
  it `display: flex` (or make it a `View`) and declare the height.
- **`focusable={false}` does nothing on a `Pressable`.** Not because RNW
  drops the prop (`createDOMProps` honors it on a plain `View`) but because
  RNW's `Pressable` sets `tabIndex` itself, `disabled ? -1 : 0`
  (`react-native-web/dist/exports/Pressable/index.js`), and only an explicit
  `tabIndex` wins. So `tabIndex={-1}` is the opt-out, RN's types accept it,
  and an RNW upgrade is not going to change this.
- **`Image` reads `aria-label`, not `alt`.** RNW's `Image` builds its
  `<img alt>` from `aria-label` / `accessibilityLabel`; an `alt` prop is
  dropped.
- **`role="heading"` + `aria-level` renders `<h{n}>`.** RNW's text reset
  (`margin: 0; font: 14px …`) and the inline heading style override the
  UA's heading styles, so the look doesn't change.

## The test

`src/test/pressable-roles.test.ts` reads `expo/app` and `expo/components`
and fails on any `Pressable` (or `Touchable*`) whose opening tag has neither
a `role` / `accessibilityRole` nor `tabIndex={-1}`, and on any `<div>` or
`<span>` with an `onClick` and no `role` — the shape the list's cards had,
which no Pressable rule would have caught. A wrapper whose click handler only
stops propagation says so with `role="presentation"`. It reads source, so it
skips on an installed package (see [Doctor](doctor.md)).

## Checking it

With no screen reader to hand, the accessibility tree is the next best
thing. Chromium's CDP `Accessibility.getFullAXTree` lists every node with
its role and computed name; a session that melds the daemon with its own
agent token (read-only routes are enough to render the list and a chat)
can drive the Playwright-cached `chrome-headless-shell` from Node with no
package installed, and compare the tree with what a sighted operator sees in
a screenshot from the same page. The first pass was checked that way: zero
unnamed buttons, the tab list, three `<h2>`s in a narration, the live
region present and empty on load.

Lighthouse's accessibility category runs the same way (`npx lighthouse
--only-categories=accessibility --disable-storage-reset`, `CHROME_PATH` at
that binary, `--chrome-flags="--user-data-dir=…"` at the melded profile;
copy the profile without its `Service Worker` directory first, or the
precache serves the previous bundle). What it still flags after the first
pass is pre-existing: seven `color-contrast` items (`#666` on `#111` and
`#1c1c1e`, the `#5e8a72` fold path, `#4caf50` on the awaiting glow),
`meta-viewport`, and the copy buttons' 17×15 px `target-size`.
