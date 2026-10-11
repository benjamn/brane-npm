/**
 * The `seqs` export parameter — the chat's own message selection, on the wire.
 *
 * Both halves live here for the reason `view-url.ts` gives: a parameter whose
 * writer and reader sit in different modules drifts. The app formats it
 * (`expo/lib/api.ts`), the daemon parses it (`src/daemon/server.ts`), and
 * `src/test/export-selection.test.ts` holds the two to the same grammar.
 *
 * The grammar is deliberately the dullest thing that works: ascending decimal
 * seqs joined by commas, `12,14,19`. Not a range syntax — the selection is a
 * set of taps, not an interval, and `12-19` would claim messages the operator
 * never picked.
 *
 * `seqs_mode` says which side of the selection to export — the picks, or
 * everything but them (see `SeqSelectionMode` below). It lives here rather
 * than beside the route for the same reason `seqs` does: the two are read
 * together or not at all.
 */

/** Selected seqs → the query-string value, or null when there is no selection
 *  to send. Sorted ascending and deduped, so the same selection always
 *  produces the same URL whatever order it was tapped in. */
export function formatSeqParam(seqs: Iterable<number> | null | undefined): string | null {
  if (!seqs) return null;
  const clean = [...new Set(seqs)]
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
  return clean.length > 0 ? clean.join(",") : null;
}

/** The query-string value → seqs. Anything unreadable is *no* selection, which
 *  exports the whole conversation: an export is a read, and a malformed
 *  parameter should hand the operator their transcript rather than a 400. */
export function parseSeqParam(raw: string | null | undefined): number[] {
  if (!raw) return [];
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // Plain decimal digits and nothing else. `parseInt("12abc")` is 12, and
    // `Number` is no stricter than it looks — `1e2` is 100, `0x10` is 16, `+4`
    // is 4 — and each would silently export a message nobody asked for. The app
    // only ever writes `formatSeqParam`'s digits, so this costs it nothing.
    if (!/^\d+$/.test(trimmed)) continue;
    const n = Number(trimmed);
    if (Number.isSafeInteger(n) && n > 0) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** What a selection *means* to an export. `only` is the excerpt the parameter
 *  was introduced for — these messages and no others. `except` is its inverse:
 *  the conversation with these messages left out.
 *
 *  Two modes rather than a second parameter list because the selection is the
 *  same set either way — the operator taps timestamps once and then chooses
 *  which side of the line to export. */
export type SeqSelectionMode = "only" | "except";

/** The mode → its query-string value, or null when there is nothing to say.
 *  `only` is the default the daemon already assumes, so it is left off the URL
 *  entirely: a plain excerpt's link is byte-identical to the one brane built
 *  before an inverse existed. */
export function formatSeqModeParam(mode: SeqSelectionMode | null | undefined): string | null {
  return mode === "except" ? "except" : null;
}

/** The query-string value → the mode. Only the exact word `except` inverts an
 *  export; absent, misspelled, or junk all mean `only`.
 *
 *  Asymmetric on purpose, and in the same direction as `parseSeqParam`'s
 *  tolerance: an unreadable parameter must never hand the operator the
 *  *complement* of the document they asked for. A garbled `only` costs them
 *  nothing they can't see; a garbled `except` would silently export the
 *  messages they were excluding. */
export function parseSeqModeParam(raw: string | null | undefined): SeqSelectionMode {
  return raw?.trim() === "except" ? "except" : "only";
}

/** The file name an export saves under. A full export is `<nid>.html`, which is
 *  also what sibling exports link to. An excerpt carries the count its header
 *  discloses plus a short digest of exactly which seqs it holds —
 *  `<nid>.3-of-47.9f2c1a.html` — so two different documents never share a
 *  name. The count alone was not enough: `only` and `except` of a selection
 *  that is half the conversation are both `2-of-4`, and that pair is the one a
 *  redaction exists to keep apart. Browsers tend to uniquify a clashing
 *  download rather than overwrite it, but `(1)` says nothing about which file
 *  is the redacted one.
 *
 *  The count and a digest, not the mode, and for the header's reason: `only`
 *  and `except` disclose identically, and a name reading "redacted" would tell
 *  the reader which side of the line was taken — that something was
 *  deliberately withheld — when the header is careful not to. */
export function exportFileName(
  nid: string,
  excerpt?: { seqs: readonly number[]; total: number } | null,
): string {
  if (!excerpt) return `${nid}.html`;
  return `${nid}.${excerpt.seqs.length}-of-${excerpt.total}.${seqDigest(excerpt.seqs)}.html`;
}

/** Six hex digits naming a set of seqs: FNV-1a over the sorted list. Not a
 *  security property — it only has to tell two excerpts of one narrative
 *  apart — and dependency-free so this module stays importable anywhere. */
export function seqDigest(seqs: readonly number[]): string {
  let h = 0x811c9dc5;
  for (const ch of [...seqs].sort((a, b) => a - b).join(",")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 8).toString(16).padStart(6, "0");
}
