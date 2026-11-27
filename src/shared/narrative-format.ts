/**
 * Narrative meta formatting — the single source of truth for how a narrative's
 * cost and activity span are worded, shared by every surface that renders them.
 *
 * Four consumers today: the Expo list card, the page header, and the switcher
 * (all via `expo/components/NarrativeMeta.tsx` / `expo/lib/api.ts`), plus the
 * server-side HTML export (`src/export.ts`). They must read alike — a narrative
 * card that says "$6.81 /worker from 3d to 4h ago" in the app has to say the
 * same thing in an export of that narrative.
 *
 * Deliberately dependency-free, framework-free (no React, no react-native, no
 * node builtins) *and stateless* so both the tsc build and the metro bundler
 * can consume it. Stateless is load-bearing, not stylistic: this file is
 * compiled twice — once by the root tsc into `dist/shared/`, once inlined into
 * the metro bundle — so the two builds hold separate copies. Pure functions
 * don't care; a module-level cache or counter added here would silently
 * diverge between the server and the app.
 *
 * Expo reaches this file through the `@shared/*` tsconfig path and the
 * `watchFolders` entry in `expo/metro.config.js` — keep it that way.
 */

/** Event types that carry conversation: an agent's own voice, the operator's
 *  signals, and foreign agents' signals. Exported as an array as well, because
 *  `src/export.ts` asks SQLite the same question (`type IN (…)`) and a second
 *  hand-written list of these three strings is a list that drifts. */
export const CONVERSATIONAL_EVENT_TYPES_LIST = ["narration", "human_signal", "agent_signal"] as const;
const CONVERSATIONAL_EVENT_TYPES = new Set<string>(CONVERSATIONAL_EVENT_TYPES_LIST);

/** True for events the daemon wrote on its own behalf — `started` (spawn/twin/
 *  external MCP client), `restarted` (revive), `binding_rejected`. They're part
 *  of the record (a twin's `/twin from <nid>:<seq>` back-pointer lives here),
 *  but nobody *said* them, so every surface renders them as a recessive system
 *  line rather than as a speaker's bubble. */
export function isSystemEvent(type: string): boolean {
  return !CONVERSATIONAL_EVENT_TYPES.has(type);
}

/*
 * Lifecycle lines — the text of a `started` / `restarted` event.
 *
 * One shape, written the way the loop already speaks: a verb, the invocation
 * as a code span, and the role as a `/protocol` command.
 *
 *   Spawned `claude --model opus-5` /worker
 *   Spawned `claude` /twin from claude-abc:42
 *   Revived `claude --dangerously-skip-permissions` /worker (forked — original still live)
 *   Running `lazygit`
 *
 * The code span is what the operator chose — the binary, its model flag, and
 * any passthrough args — never the daemon's plumbing (session ids, MCP config
 * paths, the bind secret, the bootstrap prompt). The `/role` is the same token
 * the card's meta line and the `/keeper` slash convention use, and the app's
 * protocol linkifier turns it into a link to the role's protocol. The
 * predecessor after `from` is a bare `nid:seq` on purpose: a backtick there
 * would stop it linkifying, and that link is the whole point of the line.
 *
 * The fold is deliberately *not* in the stored text. It is a column on the
 * narrative's own row — a twin's row carries the twin's fold, which is what
 * makes it worth showing — and every renderer has that row, so `systemLine`
 * appends it at render time from the column rather than from the string.
 *
 * Every writer (spawn, twin, revive, run, absorb) calls these so the stored
 * text is already the final form; `formatSystemContent` below normalizes the
 * rows written before this shape existed.
 */

/** A single argv word as a shell would want it typed: bare when it can be,
 *  single-quoted when it holds whitespace or a quote. */
function shellWord(arg: string): string {
  if (arg !== "" && !/[\s'"$`\\]/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** An invocation as a markdown code span. Backticks inside it widen the fence
 *  rather than break it. */
export function formatInvocation(command: readonly string[]): string {
  const text = command.map(shellWord).join(" ");
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return longest ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

export interface SpawnedLineOptions {
  /** The shown arguments after the binary — see the note above on what belongs there. */
  args?: readonly string[] | null;
  /** A twin's predecessor, as `nid:seq`. */
  from?: string | null;
}

/** `Spawned \`claude --model x\` /worker`, or with a predecessor,
 *  `Spawned \`claude\` /twin from claude-abc:42`. */
export function spawnedContent(agent: string, role: string, opts: SpawnedLineOptions = {}): string {
  const line = `Spawned ${formatInvocation([agent, ...(opts.args ?? [])])} /${role}`;
  return opts.from ? `${line} from ${opts.from}` : line;
}

/** `Revived \`claude\` /worker`, flagged when the resume forked a still-live
 *  original — the one thing about a revive the arguments don't say. */
export function revivedContent(
  agent: string,
  role: string,
  args: readonly string[] = [],
  forked = false,
): string {
  const line = `Revived ${formatInvocation([agent, ...args])} /${role}`;
  return forked ? `${line} (forked — original still live)` : line;
}

/** A utility narrative (`POST /api/run`) has no role and no agent: the line is the
 *  command itself. */
export function runningContent(command: readonly string[]): string {
  return `Running ${formatInvocation(command)}`;
}

export function restartedContent(command: readonly string[]): string {
  return `Restarted ${formatInvocation(command)}`;
}

/** The agent a narrative id was minted for: `claude-rfhbth2v` → `claude`.
 *  Every brane-spawned id is `<agent>-<8 base36>`, so the prefix is exact for
 *  them; an absorbed import's `organelle-…` id names the importer, which is
 *  why callers prefer the row's `agent_type` and fall back to this. */
export function agentTypeOf(nid: string): string {
  return nid.replace(/-[a-z0-9]{8}$/, "");
}

/** Bring a lifecycle line written before the invocation shape existed up to
 *  it, at render time — changing the writers alone would fix narratives
 *  spawned from then on and leave every existing one reading the old way:
 *
 *    Spawned claude (worker)        → Spawned `claude` /worker
 *    Twinned from claude-abc:42     → Spawned `claude` /twin from claude-abc:42
 *    Revived claude session (…)     → Revived `claude` (…)
 *    Running lazygit                → Running `lazygit`
 *
 *  The old twin line never recorded which agent was spawned, so the caller
 *  supplies it from the narrative row; without one the line falls back to
 *  `/twin from …`.
 *
 *  A line already carrying a code span is in the new shape and passes through
 *  untouched — a row written since this shape landed is never transformed. Deliberately no allowlist of known
 *  roles: whatever a narrative was spawned as gets the same notation. Each
 *  pattern is anchored to the whole line so ordinary prose that happens to
 *  start with one of these verbs is left alone. */
export function formatSystemContent(content: string, agent?: string | null): string {
  const s = content.trimEnd();
  if (s.includes("`")) return s;
  let m: RegExpExecArray | null;
  if ((m = /^Spawned (\S+) \(([A-Za-z0-9][\w.-]*)\)$/.exec(s))) {
    return spawnedContent(m[1], m[2]);
  }
  if ((m = /^Twinned from (\S+)$/.exec(s))) {
    return agent ? spawnedContent(agent, "twin", { from: m[1] }) : `/twin from ${m[1]}`;
  }
  if ((m = /^Revived (\S+) session( \(.*\))?$/.exec(s))) {
    return `Revived \`${m[1]}\`${m[2] ?? ""}`;
  }
  if ((m = /^(Running|Restarted) (.+)$/.exec(s))) {
    return `${m[1]} \`${m[2]}\``;
  }
  return s;
}

/** The href scheme a lifecycle line's fold is linked under, so a renderer can
 *  pick it out and paint it the way the identity row paints a fold — green,
 *  monospace — rather than link blue. It identifies; it does not navigate. */
export const FOLD_LINK_SCHEME = "brane://fold/";

/** The fold color the identity row uses (`NarrativeIdentity` in
 *  `expo/components/NarrativeMeta.tsx`); the export's stylesheet reads it from
 *  here so a system line's fold is the same green in both. */
export const FOLD_COLOR = "#5e8a72";

/** The markdown a renderer shows for a system event: the stored line (legacy
 *  shapes normalized), and for a `started` event the narrative's fold appended
 *  as `in [fold](brane://fold/fold)`. The fold comes from the row, and whether
 *  to show it from the event type — nothing is read out of the text. A
 *  `restarted` line omits it (a revive cannot move folds, and the header
 *  already says where the narrative lives); an external narrative has no fold
 *  and so shows none.
 *
 *  The one text comparison is an equality: for a few hours on 2026-09-08 the
 *  writers baked ` in <fold>` into the content. A row from that window ends
 *  with exactly its own `fold_path`, which is dropped so the fold isn't shown
 *  twice. */
export function systemLine(
  event: { type: string; content: string },
  narrative: { agent?: string | null; fold?: string | null } = {},
): string {
  let text = formatSystemContent(event.content, narrative.agent);
  const fold = narrative.fold ?? null;
  if (!fold) return text;
  const baked = ` in ${fold}`;
  if (text.endsWith(baked)) text = text.slice(0, -baked.length);
  return event.type === "started" ? `${text} in [${fold}](${FOLD_LINK_SCHEME}${fold})` : text;
}

/** One end of the activity span. `val` is the bare magnitude ("3d", "5m",
 *  "30s") or an absolute date once older than a week; `ago` says whether an
 *  "ago" suffix applies (so a span can share one "ago": "3d to 4h ago"). */
export function relPart(ms: number, now: number = Date.now()): { val: string; ago: boolean } {
  const sec = Math.floor((now - ms) / 1000);
  if (sec < 60) return { val: `${Math.max(1, sec)}s`, ago: true };
  const min = Math.floor(sec / 60);
  if (min < 60) return { val: `${min}m`, ago: true };
  const hr = Math.floor(min / 60);
  if (hr < 24) return { val: `${hr}h`, ago: true };
  const day = Math.floor(hr / 24);
  if (day < 7) return { val: `${day}d`, ago: true };
  return { val: shortDate(ms, now), ago: false };
}

/** "Jun 10", or "Jun 10, 2025" outside `now`'s year. */
function shortDate(ms: number, now: number): string {
  const d = new Date(ms);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const date = `${months[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? date : `${date}, ${d.getFullYear()}`;
}

/** `relPart`'s twin for a countdown to `ms`: the same units ("45s", "7m",
 *  "3h", "2d") and the same week's cutoff to a date, but rounded *up*, as a
 *  countdown clock is, so it never says less time than is left: 7m30s is
 *  "8m", and the minutes tick down until the last one, which counts in
 *  seconds. `ahead` is false for a date ("Dec 3"), which takes no "in".
 *  `changesInMs` is how long until `val` changes, so a view can redraw
 *  exactly then rather than on a timer. Null once `ms` has passed. */
export function relAhead(ms: number, now: number = Date.now()): { val: string; ahead: boolean; changesInMs: number } | null {
  const left = ms - now;
  if (left <= 0) return null;
  const tiers: Array<[unit: number, most: number, sym: string]> = [
    [1_000, 60, "s"],
    [60_000, 60, "m"],
    [3_600_000, 24, "h"],
    [86_400_000, 7, "d"],
  ];
  for (const [unit, most, sym] of tiers) {
    if (left <= unit * most) {
      const n = Math.ceil(left / unit);
      return { val: `${n}${sym}`, ahead: true, changesInMs: left - (n - 1) * unit };
    }
  }
  return { val: shortDate(ms, now), ahead: false, changesInMs: left - 7 * 86_400_000 };
}

/** A whole number of minutes, as a setting reads: exact, in the largest
 *  unit that divides it ("15m", "90m", "2h", "1d"). */
export function formatMinutes(minutes: number): string {
  if (minutes > 0 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes > 0 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** Humanized activity span "created-ago to last-active-ago" — e.g. "3d to 4h
 *  ago". Collapses to a single value when there's no distinct last activity
 *  (brand-new narrative, or before the daemon exposes last_activity).
 *  When both ends are relative they share one "ago"; mixed/absolute ends are
 *  spelled out per-end ("Jun 10 to 4 hours ago").
 *
 *  `now` is the instant the span is relative to. The live surfaces leave it at
 *  the default; the HTML export pins it to the export timestamp so a static
 *  document's "3d ago" stays anchored to the moment it was written. */
export function formatActivitySpan(
  createdMs: number,
  lastMs?: number | null,
  now: number = Date.now(),
): string {
  const c = relPart(createdMs, now);
  const withAgo = (p: { val: string; ago: boolean }) => (p.ago ? `${p.val} ago` : p.val);
  const hasSpan = typeof lastMs === "number" && lastMs - createdMs > 60_000;
  if (!hasSpan) return withAgo(c);
  const l = relPart(lastMs as number, now);
  if (c.val === l.val) return withAgo(c);
  if (c.ago && l.ago) return `${c.val} to ${l.val} ago`;
  return `${withAgo(c)} to ${withAgo(l)}`;
}

/** Format a metered cost for display, generic across units. USD renders as
 *  "$6.81"; any other unit (e.g. Copilot's "AIC" credits) renders as
 *  "1,200 AIC". Returns null when there's nothing to show. */
export function formatCost(amount?: number | null, unit?: string | null): string | null {
  if (amount == null || !unit) return null;
  if (unit === "USD") return `$${amount.toFixed(2)}`;
  const n = Number.isInteger(amount)
    ? amount.toLocaleString()
    : amount.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return `${n} ${unit}`;
}

/** Format a set of per-unit totals as one line: "$2,430.46 · 100.2 AIC".
 *  Units are listed, never added. Returns null when there is nothing metered. */
export function formatCostTotals(
  totals?: Array<{ unit: string; amount: number }> | null,
): string | null {
  if (!totals?.length) return null;
  const parts = totals.map((t) => formatCost(t.amount, t.unit)).filter((p): p is string => !!p);
  return parts.length ? parts.join(" · ") : null;
}
