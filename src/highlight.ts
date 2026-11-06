import { extname } from "node:path";
import { createHash } from "node:crypto";
import { createHighlighter, bundledLanguages, type Highlighter, type LanguageRegistration, type ThemedToken } from "shiki";
import { ebnf as ebnfGrammar } from "./grammars/ebnf.js";
import { loadGraphql } from "./grammars/graphql.js";

export const HIGHLIGHT_THEME = "github-dark-default";

// Custom (non-bundled) grammars shipped in-repo. Loaded eagerly at highlighter
// init so the "is this language known?" check below accepts them alongside
// shiki's bundled set.
const CUSTOM_GRAMMARS: LanguageRegistration[] = [ebnfGrammar];
const CUSTOM_LANG_NAMES = new Set<string>(
  CUSTOM_GRAMMARS.flatMap((g) => [g.name, ...(g.aliases ?? [])]),
);

function isKnownLang(lang: string): boolean {
  return lang in bundledLanguages || CUSTOM_LANG_NAMES.has(lang);
}

// File extension → shiki bundled language id, for the cases where the two
// differ (`.rs` → rust, `.py` → python). Extensions that already *are* the
// language id (`.lean`, `.zig`, `.nix`) need no entry — detectLanguage falls
// back to the bare extension and lets shiki's own registry decide.
const EXT_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".jsonc": "jsonc",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".fish": "fish",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".m": "objective-c",
  ".mm": "objective-cpp",
  ".cs": "csharp",
  ".scala": "scala",
  ".clj": "clojure",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hs": "haskell",
  ".lua": "lua",
  ".php": "php",
  ".dart": "dart",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".html": "html",
  ".htm": "html",
  ".xml": "xml",
  ".svg": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".ini": "ini",
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "proto",
  ".nix": "nix",
  ".zig": "zig",
  ".r": "r",
  ".jl": "julia",
  ".ebnf": "ebnf",
  ".bnf": "ebnf",
};

// Extensions the *client* renders itself rather than as highlighted source —
// FilesView routes these to MarkdownContent. Shiki does bundle `md`/`mdx`
// grammars, so without this the extension fallback below would resolve them and
// we'd ship a full token payload nobody looks at.
const CLIENT_RENDERED_EXTS = new Set([".md", ".mdx", ".markdown"]);

const BASENAME_LANG: Record<string, string> = {
  "Dockerfile": "docker",
  "Makefile": "make",
  "CMakeLists.txt": "cmake",
  ".gitignore": "shellscript",
  ".env": "shellscript",
};

export function detectLanguage(filePath: string): string | null {
  const base = filePath.split("/").pop() ?? filePath;
  for (const [needle, lang] of Object.entries(BASENAME_LANG)) {
    // Exact match or "needle.<suffix>" (e.g. Dockerfile.dev, .env.local) — avoids
    // bare `startsWith` over-matching ".env" into ".environmental".
    if (base === needle || base.startsWith(needle + ".")) return lang;
  }
  const ext = extname(base).toLowerCase();
  if (!ext) return null;
  if (EXT_LANG[ext]) return EXT_LANG[ext];
  if (CLIENT_RENDERED_EXTS.has(ext)) return null;
  // Long tail: for a great many languages the extension and shiki's language id
  // are the same string (lean, zig, nix, tex, diff, …). Rather than grow the map
  // one bug report at a time, ask shiki whether the bare extension names a
  // grammar it has. The explicit map above still wins wherever they disagree.
  const bare = ext.slice(1);
  if (bare && isKnownLang(bare)) return bare;
  return null;
}

// Fence tags that name no shiki grammar and aren't extension-shaped either, so
// the extension fallback in resolveLang can't reach them. Kept deliberately
// short: the map below is for words people type in fences, not a second
// language registry.
const FENCE_LANG: Record<string, string> = {
  golang: "go",
  plist: "xml",
  xaml: "xml",
  patch: "diff",
};

/**
 * A fenced block's info string → a grammar shiki can actually load, or null to
 * render the block as plain text.
 *
 * The info string is whatever the author typed, and the two obvious sources of
 * it disagree about vocabulary. Shiki's `bundledLanguages` is generous with
 * aliases (`js`, `sh`, `yml`, `c++` all resolve) but has no SVG grammar, so
 * ```svg fell through to plain text — while the *same bytes* opened from the
 * Files tab highlighted fine, because that path resolves `.svg` through
 * EXT_LANG instead. Rather than keep two vocabularies, a tag shiki doesn't know
 * is retried as if it were a file extension, which inherits EXT_LANG whole and
 * every entry added to it later.
 */
export function resolveLang(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const tag = lang.trim().toLowerCase();
  if (!tag) return null;
  if (isKnownLang(tag)) return tag;
  if (FENCE_LANG[tag]) return FENCE_LANG[tag];
  return detectLanguage(`x.${tag}`);
}

let highlighterP: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterP) {
    highlighterP = loadGraphql().then((graphql) =>
      createHighlighter({ themes: [HIGHLIGHT_THEME], langs: [...CUSTOM_GRAMMARS, ...graphql] }),
    );
  }
  return highlighterP;
}

// Memoize per-language load promises so concurrent first-loads of the same
// language collapse to a single underlying loadLanguage call.
const langLoads = new Map<string, Promise<void>>();

async function ensureLangLoaded(hl: Highlighter, lang: string): Promise<boolean> {
  if (hl.getLoadedLanguages().includes(lang)) return true;
  let p = langLoads.get(lang);
  if (!p) {
    p = hl.loadLanguage(lang as keyof typeof bundledLanguages).then(() => undefined);
    langLoads.set(lang, p);
    p.catch(() => {
      // Failed load — drop the memo so a later retry can try again
      langLoads.delete(lang);
    });
  }
  try {
    await p;
    return true;
  } catch (err) {
    console.warn(`[highlight] failed to load grammar for ${lang}:`, err);
    return false;
  }
}

export interface HighlightResult {
  lang: string;
  theme: string;
  bg: string;
  fg: string;
  // shiki returns a ThemedToken for every token; we keep only the fields the
  // client uses so the JSON payload stays lean.
  tokens: Array<Array<{ c: string; f?: string; s?: number }>>;
}

const CACHE_MAX = 200;
const cache = new Map<string, HighlightResult>();

function cacheGet(key: string): HighlightResult | undefined {
  const v = cache.get(key);
  if (v !== undefined) {
    cache.delete(key);
    cache.set(key, v);
  }
  return v;
}

function cacheSet(key: string, value: HighlightResult) {
  cache.set(key, value);
  if (cache.size > CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
}

function compactTokens(tokens: ThemedToken[][]): HighlightResult["tokens"] {
  return tokens.map((line) =>
    line.map((tok) => {
      const out: { c: string; f?: string; s?: number } = { c: tok.content };
      if (tok.color) out.f = tok.color;
      if (tok.fontStyle && tok.fontStyle > 0) out.s = tok.fontStyle;
      return out;
    }),
  );
}

/**
 * Shiki-rendered HTML for a code snippet. Returns null if the tag resolves to
 * no grammar, or the grammar fails to load — caller falls back to raw text.
 */
export async function highlightHtml(content: string, lang: string | null): Promise<string | null> {
  const resolved = resolveLang(lang);
  if (!resolved) return null;
  const hl = await getHighlighter();
  if (!(await ensureLangLoaded(hl, resolved))) return null;
  return hl.codeToHtml(content, { lang: resolved as keyof typeof bundledLanguages, theme: HIGHLIGHT_THEME });
}

export async function highlight(content: string, lang: string | null): Promise<HighlightResult | null> {
  // The resolved id is what gets cached and reported back, so ```svg and
  // ```xml share one cache entry rather than tokenizing the same bytes twice.
  const resolved = resolveLang(lang);
  if (!resolved) return null;
  const hl = await getHighlighter();
  if (!(await ensureLangLoaded(hl, resolved))) return null;
  const sha = createHash("sha1").update(content).digest("hex");
  const key = `${sha}:${resolved}:${HIGHLIGHT_THEME}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const result = hl.codeToTokens(content, { lang: resolved as keyof typeof bundledLanguages, theme: HIGHLIGHT_THEME });
  const out: HighlightResult = {
    lang: resolved,
    theme: HIGHLIGHT_THEME,
    bg: result.bg ?? "#0f0f0f",
    fg: result.fg ?? "#e0e0e0",
    tokens: compactTokens(result.tokens),
  };
  cacheSet(key, out);
  return out;
}
