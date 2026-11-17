/** A line diff of two texts, for showing what changed in a protocol since the
 *  operator last approved it (the CLI and the app's reader). Plain LCS:
 *  protocols are a few hundred lines, and past `MAX_CELLS` it gives up and
 *  reports every line of both, which is still a correct (if long) diff. */

export type DiffLine = { op: " " | "-" | "+"; text: string };

/** Text as it should be shown to someone deciding whether to approve it:
 *  every control character but newline and tab, every bidirectional
 *  control, the zero-width characters and the Unicode tag block written out
 *  as escapes. A terminal would otherwise run the controls (conceal a line,
 *  move the cursor up and overwrite one), a bidi override reorders what a
 *  browser shows, and zero-width and tag characters are invisible to the
 *  operator but read by a model, while the hash, and the agent, get the text
 *  as it is. */
export function visibleText(text: string): string {
  return text.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\u{e0000}-\u{e007f}]/gu,
    (c) => {
      const code = c.codePointAt(0)!;
      if (code <= 0xff) return `\\x${code.toString(16).padStart(2, "0")}`;
      if (code <= 0xffff) return `\\u${code.toString(16).padStart(4, "0")}`;
      return `\\u{${code.toString(16)}}`;
    },
  );
}

const MAX_CELLS = 4_000_000;

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((text) => ({ op: "-" as const, text })), ...b.map((text) => ({ op: "+" as const, text }))];
  }
  // lcs[i][j]: the longest common subsequence of a[i..] and b[j..].
  const lcs: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: "-", text: a[i++] });
    } else {
      out.push({ op: "+", text: b[j++] });
    }
  }
  while (i < a.length) out.push({ op: "-", text: a[i++] });
  while (j < b.length) out.push({ op: "+", text: b[j++] });
  return out;
}

/** The diff as text: changed lines with `context` unchanged lines around
 *  them, and `…` where unchanged runs are elided. */
export function formatLineDiff(lines: DiffLine[], context = 3): string {
  const keep = lines.map((l) => l.op !== " ");
  const show = lines.map((_, i) => {
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) if (keep[k]) return true;
    return false;
  });
  const out: string[] = [];
  let skipped = false;
  lines.forEach((l, i) => {
    if (show[i]) {
      out.push(`${l.op} ${l.text}`);
      skipped = false;
    } else if (!skipped) {
      out.push("  …");
      skipped = true;
    }
  });
  return out.join("\n");
}
