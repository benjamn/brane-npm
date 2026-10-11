/** Link resolution for wiki pages, shared by the daemon and the web reader so
 *  the two can never disagree about where a link points.
 *
 *  A fold's wiki is `wiki/` plus at most one subdirectory, `wiki/shared/`. A
 *  page's *slug* is its path relative to `wiki/` — `foo.md` is local,
 *  `shared/foo.md` is shared — so a citation means the same thing to every
 *  reader. Markdown links inside a page are filesystem-relative, the way
 *  GitHub and every editor already render them: from `shared/a.md`, `b.md` is
 *  `shared/b.md` and `../c.md` is `c.md`; from local `c.md`, `shared/a.md` is
 *  the shared page. This module is that arithmetic and nothing else — whether
 *  the target exists, or is visible to the caller, is decided by whoever holds
 *  the directory.
 *
 *  Window-free and dependency-free so `src/test/wiki-links.test.ts` can run it
 *  over a grid, and so metro needs no alias for it.
 */

/** The one subdirectory a wiki may contain. Pages under it are visible from
 *  other folds; everything directly under `wiki/` is fold-local. */
export const WIKI_SHARED_DIR = "shared";

/** Whether a slug (with or without `.md`) names a shared page. */
export function isSharedSlug(slug: string): boolean {
  return slug.startsWith(`${WIKI_SHARED_DIR}/`);
}

/** Canonical slug form: no leading `/` or `./`, `.md` appended when the last
 *  segment has no extension. Does not touch `..` — callers that need safety
 *  go through {@link resolveWikiLink}, which rejects escapes. */
export function normalizeWikiSlug(slug: string): string {
  let s = slug.trim().replace(/^\/+/, "");
  while (s.startsWith("./")) s = s.slice(2);
  const last = s.split("/").pop() ?? "";
  return last.includes(".") ? s : `${s}.md`;
}

/** Resolve a markdown `href` found in the page `fromSlug`. Returns the target
 *  slug (canonical, relative to `wiki/`) and any `#anchor`, or `null` when the
 *  link is not an intra-wiki page link: a URL with a scheme, an absolute
 *  path, or a relative path that climbs above `wiki/`. A bare `#anchor` stays
 *  on the current page. */
export function resolveWikiLink(
  fromSlug: string,
  href: string,
): { slug: string; anchor?: string } | null {
  const raw = href.trim();
  const hashIdx = raw.indexOf("#");
  const pathPart = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
  const anchor = hashIdx >= 0 ? raw.slice(hashIdx + 1).trim() || undefined : undefined;

  const from = normalizeWikiSlug(fromSlug);
  if (pathPart === "") {
    return anchor !== undefined ? { slug: from, anchor } : { slug: from };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(pathPart)) return null;
  if (pathPart.startsWith("/") || pathPart.startsWith("\\")) return null;

  const baseDir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")).split("/") : [];
  const stack = [...baseDir];
  for (const seg of pathPart.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  if (stack.length === 0) return null;
  const slug = normalizeWikiSlug(stack.join("/"));
  return anchor !== undefined ? { slug, anchor } : { slug };
}
