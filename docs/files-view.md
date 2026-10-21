# Files View

How the daemon serves a narrative's fold to the Files tab, what it can show, and how 🔎 searches a binary.

## Files API

`GET /api/files?nid=<nid>&path=<rel>` browses the filesystem under a narrative's `fold_path`. The route is `browseFold()` (`src/files/browse.ts`), a pure function of (fold, path, options) so the suite drives it without HTTP. The response is discriminated on `type`:

- `{ type: "directory", path, entries: [{ name, is_dir, size, mtime, archive?, link? }], archive? }` — dotfiles hidden
- `{ type: "file", path, size, mtime, content, truncated?, binary?, highlight?, hex?, link?, notice?, archive? }`

`highlight` is a pre-tokenized Shiki payload (`{ lang, theme, bg, fg, tokens }`) so the client renders colored code without shipping a highlighter to the browser. Adding `&raw=1` streams the bytes instead of JSON, for any file: the `src` for images, PDFs and audio, and **Download** for a file too large to show (which, before, got JSON back). A raw answer of known size carries `Content-Length` and `Accept-Ranges: bytes`, and honors one `Range` (`bytes=a-b`, `bytes=a-`, `bytes=-n`) with a 206 and `Content-Range`; a window past the end is 416, and a header the daemon doesn't understand (several ranges, another unit) is ignored and the whole body sent, as the spec allows. A `.gz` body, whose size only decompressing would tell, is sent whole and chunked as before. The body is sent as exactly the bytes its size claims, so an archive member that lies about its length never disagrees with `Content-Length`. Ranges are what let a browser seek in audio, and what Safari requires before it plays any: it probes with `bytes=0-1` first (`parseRangeHeader`, `src/files/browse.ts`). `&offset=N` asks for the hex page at byte N of a binary file. A path may run through an archive (`dist/app.zip/src/main.ts`); what that means is [Files View Formats](#files-view-formats).

Path handling is traversal-confined: absolute paths are rejected, `#`/`?` fragments are stripped, the target is `resolve()`d and must equal the fold root or sit beneath it. The echoed `path` is normalized so breadcrumbs never render `fold/./blah`.

`GET /api/files/list?nid=<nid>` returns `{ files, truncated }` — a flat path list for the whole fold, feeding the client-side fuzzy finder. It does not descend into archives: that would mean opening every one in the fold to answer a keystroke.

## Files View Formats

What the Files view can show is one of brane's quiet advantages, so it is
kept as a census, and a format that renders is pinned by a test that builds
it byte by byte (`src/test/files-browse.test.ts`, which needs no `zip` or
`tar` binary, so it runs under `brane doctor` too).

| File | Shown as | By |
|---|---|---|
| Source and text | Shiki-highlighted code with line anchors | `CodeView` |
| Markdown (`.md`, `.mdx`, and `.md.gz`) | Rendered, math and diagrams included | `MarkdownContent` |
| Images, PDFs | Inline image; pdf.js pages | `<img>`, `PdfView` |
| Audio (`.mp3` `.m4a` `.aac` `.flac` `.ogg` `.opus` `.wav` `.aiff`) | A player, in place, that keeps playing while the tab is hidden or another narrative is on top (see [Audio keeps playing](#audio-keeps-playing)) | `AudioView` |
| **Anything else** | Hex, `xxd`-style, 16 KB a page, 16 bytes a row (8 on a phone), searchable to the last byte | `HexView` |
| `.zip` and its kin (`.jar` `.war` `.aar` `.apk` `.ipa` `.whl` `.epub` `.docx` `.xlsx` `.pptx` `.odt` `.nupkg` `.vsix` `.xpi` …) | A folder | `src/files/zip.ts` |
| `.tar`, `.tar.gz`/`.tgz`, `.tar.br`, `.tar.zst` (Node ≥ 22.15) | A folder | `src/files/tar.ts` |
| `.gz`, `.br`, `.zst` | What they compress, named by what's inside | `archiveFormatFor` |

**PDFs use pdf.js's legacy build.** `PdfView` imports `public/pdf.min.mjs`
and its worker at runtime, and both come from `pdfjs-dist/legacy/build/`
(`npm run sync:pdfjs` in `expo/`, output committed). The modern `build/`
calls `Map.prototype.getOrInsertComputed` with no fallback, so on a browser
without it the first `page.render` throws and every page stays blank. The
legacy build carries the core-js polyfills, worker included, for about 60 KB.

**Hex is the floor.** A file is binary when a NUL appears in its first 8000
bytes, git's rule, and it pages rather than truncating, so a 50 MB `.so` is
browsable where a 3 MB log still gets "too large". Before, anything that was
not an image or PDF was decoded as UTF-8 and shown as noise. Pages sit where
they belong in the file, in whatever order they were loaded, with a gap row
for each run between them (`⋯ 1,228,800 bytes not loaded`, and ↓ / ↑ to
load the 16 KB on either side); `hexSegments` in `src/shared/hex-pages.ts`
lays that out. The pages live in a `HexDoc` (`expo/lib/hexDoc.ts`) rather
than the view's state, because 🔎 loads them too.

## The jukebox

An audio file opens as a card with a dial (`AudioCard` in
`expo/components/FilesView.tsx`, `NowPlayingDial` beside it), not the
browser's `<audio controls>`: the browser's widget can't be styled, and a
control that lives inside one Files pane can't be seen from anywhere else.
Both were tried first (#623), and three things followed: nothing outside that
pane showed that audio was playing, coming back to the narrative by a push
mounted a second copy of the screen whose controls were wired to nothing
(every navigation is a push, [View URLs](view-urls.md)), and two panes could
play two files at once.

So the player left the pane. Tapping the dial puts the file on the
**jukebox**: one record for the whole app (`Jukebox` in
`src/shared/now-playing.ts`), keyed by narrative. A narrative holds at most
one track, with its own position and status; opening a second audio file in
the same narrative replaces it. Starting a track anywhere pauses every other
narrative's, which stays loaded where it stopped: many records on the rack,
one needle. The engine (`expo/lib/jukebox.ts`) keeps one detached `<audio>`
per narrative with a track, in no screen, so nothing a screen does can
unmount it, a paused track resumes at once, and it can be scrubbed while
paused. `Jukebox.setStatus` enforces the same one-playing rule on the store,
so no reader ever sees two. `src/test/now-playing.test.ts` pins the rack: a
load pauses the others and keeps their places, an eject is final even for the
element's trailing events, and a `timeupdate` wakes one narrative's
subscribers and no other's.

Controls follow the track, not the pane. A list card whose narrative holds a
track shows the dial under its status word (LIVE, IDLE, DEAD), hung there out
of the flow so the card grows by nothing: the dial alone, no clock and no
stop, since the card is for finding what's playing and pausing it. A tap on
the dial never opens the card. The narrative's own header shows the same dial
left of the 🦠 while that narrative holds a track, so the track you are
reading next to can be paused and resumed without leaving the chat, and the
narrative switcher shows it centered at the right of each row whose narrative
holds one. The Files card is the same dial, larger, with the title, the
clock, and **✕ Stop**, which takes the track off the jukebox; a track is
stopped in its narrative, not from the list.

Every dial but the Files card's is also the way back to the file. A
long-press (`LONG_PRESS_MS`, held within the tap slop) opens the track's file
in its narrative's Files tab: from the list card, or from another narrative's
switcher row, as a push (`fileHref`), so Back returns; from the header, or
the switcher row of the narrative you are in, through the screen's own
`updateFilesParams`, the way a file link in the chat opens, since that is a
view change and not a jump ([View URLs](view-urls.md)). The Files card has no
long-press: it is the file.

The dial is the progress ring, the play/pause button and the scrubber in one
(`src/shared/audio-dial.ts` holds the math, `src/test/audio-dial.test.ts`
pins it). The full circle is the track, the lit arc is elapsed, a tap plays or
pauses, a drag scrubs. The scrub is by angle: an invisible line from the
dial's center to the finger says where the playhead is, as a fraction of a
turn clockwise from 12 o'clock, so 3 o'clock is a quarter of the way through
however the finger got there, and a drag across 12 o'clock goes from the end
to the start, as the finger says. (The first draft was a knob, moving by the
turn the finger made; the operator asked for the angle itself.) A press
doesn't move the playhead, since it may be a tap: the scrub begins once the
finger leaves the tap slop. The seek is made on release; while the finger is
down a clock under the dial shows where it will land. The dial takes the
whole gesture (`touch-action: none`, pointer capture), so the list under it
doesn't scroll and the card under it doesn't open. Nothing on or around it
is selectable: iOS answers a long-press on a `user-select: none` element by
selecting the nearest text and raising the callout, so the dial cancels
`touchstart` natively (React's listener is passive), which also stops the
click a touch would synthesize, and it clears any selection a long-press
leaves. No touch on the dial reaches what holds it, either: the list's
pull-to-refresh listens natively on an ancestor, where a React
`stopPropagation` (run only once the event reaches React's root) is too late,
and a drag down on a card's dial used to pull the whole list with it. So the
dial stops every touch event on itself, natively; its own gestures are
pointer events and don't need them. Playback with the app in
the background is not promised, and on an iOS home-screen install it varies
by version.

The list of audio extensions lives twice, `MIME_TYPES` in
`src/daemon/server.ts` and `isAudioPath` in `FilesView.tsx`, and they are kept
in step by hand: the daemon's entry is what makes the JSON say
`binary: true` with no hex page (the `audio/*` arm of `rendersFromRaw`), and
the client's is what picks the card. The audio check sits before the "too
large" check in `FileView`: a song is past the inline limit by nature, and it
streams rather than loads. 🔎 is not offered on audio, as it isn't on images.
Media Session metadata (`title` from the file name, `artist` from its folder)
names the track that started last where the OS shows what's playing, and
wires play, pause and seek on earbuds and the lock screen; where the API is
missing, the element plays without it.

## Searching the bytes

🔎 on a hex file is the daemon's, not the DOM's. It used to search the text
of the pages already loaded, which missed three ways: nothing on an unloaded
page existed, a string that wrapped a row was split by the offset and hex
columns between its halves, and `cffaedfe` never matched a column that reads
`cf fa ed fe`. `GET /api/files/find` (`src/files/find.ts`) reads the bytes
themselves, through the `ByteSource` the hex page reads, so an archive member
or a `.gz` body is searched as it is shown.

A query is matched as its UTF-8 text, smart-case like 🔎 everywhere else,
and, when it is a run of hex pairs (`cf fa ed fe`, `cffaedfe`, `0xCAFE`), as
those bytes as well: `cafe` finds the word and 0xCA 0xFE both. A hit is
painted by byte range in the hex column and the gutter alike
(`expo/lib/hexFind.ts`), one range per row it spans.

**What a search returns is bounded by pages, not by the file.** Hits come
from at most the first 64 hex pages that have any (1 MB, as much as the view
will hold), and at most 5,000 of them. A one-byte query in a 2 GB binary
therefore stops after a megabyte of hits instead of reading two gigabytes
for hits nobody will visit; the status line pinned above the rows says so
and offers **Search on from 0x…**, the next window. The drum rolls over
every hit in the window and **fetches nothing while it rolls**: the page
under a hit loads when the drum comes to rest on it, and until then the
hit's gap row stands where it will be. Measured in headless Chromium: a
30-hit roll across a 40 MB file made no page requests while rolling and one
at rest.

The other bounds are against accidents: a token holder can already type into
every tmux session.

| Bound | Why |
|---|---|
| One pass per request (`ByteSource.chunks`), never re-reading a compressed prefix | Paged requests would re-inflate a `.gz` from its start each time |
| Stops at the reach limit, and says so (`stop: "reach"`) | `chunks` throws `ReachError` where `stream()` would end quietly |
| 30 s of scanning, then `stop: "time"` and a `next` to resume from | A slow disk or a vast file doesn't hold a request open indefinitely |
| At most 2 scans daemon-wide; a third supersedes the oldest (`FindSlots`) | The likeliest third is the same reader's next keystroke |
| The app debounces 200 ms and aborts the previous request, and a closed request stops the read | Typing `NEEDLE` is one scan, not six |
| Needles of at most 256 bytes | A needle is held in every chunk's carry, and nothing a reader types is longer |

Hits are reported in offset order across chunk seams, two needles included:
a hit is reported only once every needle that could start before it has been
seen whole. That is what makes the page count a running count and `next` a
resume point that skips nothing, and `src/test/files-find.test.ts` holds it
against a naive search over 200 randomized splits.

**An archive is a folder, and nothing is extracted.** A `ByteSource`
(`src/files/bytes.ts`) is anything the view can open: a file, an archive
member, a `.gz` body. Every renderer reads through `respondWithSource`, so a
member gets highlighting, images, hex and download for free. A zip is listed
from its central directory (one read, nothing inflated) and a member inflates
alone; a tar is one pass over its headers with the data skipped, cached per
(path, size, mtime) because a compressed tar has no index. Archives do not
nest: a zip inside a zip opens as hex.

The usual archive vulnerabilities come from *extracting*, and there is no
extraction here:

- **Zip-slip, symlink and hard-link entries, overwrites, setuid bits:** not
  applicable, since nothing is written. Member names are only displayed.
  `normalizeMemberName` drops leading slashes and hides any name with `..`
  or a NUL, counting it (`archive.skipped`, shown as a banner) rather than
  drawing it somewhere it doesn't belong. Links are shown with their target
  and never followed; a tar hard link resolves once, to an earlier member of
  the same archive.
- **Decompression bombs:** a read decodes only as far as it asked for and
  tears the pipeline down (`sliceStream`), so output is bounded by the
  request, never by a size the archive claims. Opening a 64 MB-of-zeros
  member decodes one 16 KB page. No read reaches past 1 GB into a
  compressed stream (`MAX_STREAM_REACH`), which bounds the CPU any one
  request can spend, and a tar listing stops at 1 GB decoded or 200,000
  members and says it is partial.
- **Parser bugs:** the readers are TypeScript plus Node's own zlib. No
  archive tool is shelled out to: `unzip` and `bsdtar` are C with CVE
  histories, and bsdtar in particular auto-detects dozens of formats nobody
  asked it to parse. Every zip offset is checked against the file's real
  size before it is read. A malformed archive throws, and a file that isn't
  what its name claims shows as the file it is.

Refused, with the reason shown in the view: encrypted zip members,
compression methods other than stored and deflate, and device or FIFO
entries.
