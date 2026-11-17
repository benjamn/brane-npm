# Wiki: Local and Shared

A fold's wiki is `wiki/` plus at most one subdirectory, `wiki/shared/`.
Both are flat. A page's **slug is its path under `wiki/`** — `foo.md` is
local, `shared/foo.md` is shared — so a citation (`slug#anchor`) means the
same thing to every reader and never depends on who is asking.

One visibility rule, no special cases. Every wiki source is `(dir, owned)`:

| Caller | Sees |
|---|---|
| An agent in its own fold | everything under `wiki/` |
| An agent reaching another fold (`all: true`, `source:`) | that fold's `shared/` only |
| The operator over HTTP (`/api/wiki/*`) | everything, in every fold — scoping is about agents' reach, not operator secrecy |

`list_wiki`, `read_wiki`, and `search_wiki` all apply it (`shared_only` on
`WikiSource`, `src/memory/wiki.ts`). Reading another fold's local page
returns *"local to wiki source X, not shared"* rather than not-found, and
`locatePage` lets a bare `foo` fall through to `shared/foo.md`. The index
holds a fold's whole wiki (its owner searches it too); visibility is a
query-time filter, so no schema changed.

**The install directory is a fold.** `ensureInstallFold` registers the
package root (`dist/../..` — a git checkout, a global npm install, a
`node_modules` copy) in `folds` at daemon startup if it isn't there, and
never touches an existing row. There is no longer a hardcoded `brane` wiki
source: brane's shipped pages are the install fold's `shared/`, visible to
every fold by the rule above and *owned* only when the caller's fold is the
checkout itself. `package.json` `files` ships the single directory
`wiki/shared`, which is what makes the tarball the same set of pages the
daemon serves. Source labels are the fold's basename, disambiguated in
registration order (`brane`, `brane~2`) by `wikiFoldLabels` so a label is
stable across callers; `protocols` is reserved, and the protocol namespaces
serve the reader as `protocols`, `protocols:home` and `protocols:fold`
([Protocols](protocols.md#the-app)).

**Links are filesystem-relative, and shared → local is a citation, not a
promise.** From `shared/a.md`, `b.md` is `shared/b.md` and `../c.md` is the
local `c.md`. `resolveWikiLink` in `src/shared/wiki-links.ts` is the one
resolver, used by `expo/components/WikiReader.tsx` and pinned by
`src/test/wiki-links.test.ts`; it returns `null` for a scheme, an absolute
path, or a climb above `wiki/`. A shared page may link to a local one — a
non-owner following it gets the scoped error — so the protocol requires a
shared page to read without its local links. Which side a page lives on is
the operator's call; `/wiki` never moves pages.
