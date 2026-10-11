import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { getMaxSeq } from "./events.js";

/** A row in `tool_uses` — a tool call an agent made, stored alongside the
 *  narrative rather than inside it (see the migration comment in schema.ts for
 *  why these are deliberately not events). */
export interface ToolUseRow {
  narrative_id: string;
  dedup_key: string;
  after_seq: number;
  started_at: number;
  rev: number;
  name: string;
  input: string | null;
  status: "pending" | "allowed" | "denied" | "completed" | "failed" | "unknown";
  output: string | null;
  duration_ms: number | null;
  error: string | null;
  decided_by: string | null;
  decided_at: number | null;
  decision_note: string | null;
  source: "hook" | "session_log" | "absorb";
  agent_type: string | null;
  parent_id: string | null;
}

export interface RecordToolUseOpts {
  dedupKey?: string;
  name: string;
  /** Raw tool input (any JSON value). Stored verbatim. */
  input?: unknown;
  status: ToolUseRow["status"];
  /** Raw tool output (any JSON value). Stored verbatim. */
  output?: unknown;
  durationMs?: number;
  error?: string;
  source: ToolUseRow["source"];
  agentType?: string;
  parentId?: string;
  /** Epoch ms the call started. Defaults to now minus durationMs. */
  startedAt?: number;
  /** The event seq this call followed. Defaults to the narrative's current
   *  head, which is right for a live hook — the call is happening now, after
   *  everything written so far. An absorbed call is not happening now: its
   *  place is beside the message that made it, which is somewhere in the
   *  middle of a narrative the import has already written in full. On a
   *  conflict the stored value is kept either way (position is fixed at
   *  first sight). */
  afterSeq?: number;
}

/** Serialize a captured value for storage — verbatim, no redaction, no cap.
 *  Deliberate (operator ruling, claude-xlolbv6l:94): the row is the durable
 *  record, and anything destroyed at write time is unrecoverable, which is
 *  exactly the loss the Golden Rule exists to prevent. If a value ever needs
 *  hiding or shrinking, do it on the read/push path, where a better filter
 *  applies retroactively to every stored row (see excerptForPush).
 *
 *  `leanLoopCapture` below is the one exception, and it is not really a
 *  counter-example: it declines to record a *second copy* of the narrative,
 *  not a value of its own. Nothing it drops was ever the row's to lose.
 *
 *  Returns null for undefined/null so absent stays absent. */
export function prepareCaptureText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The loop's own MCP tools, whose payloads are the narrative itself. */
const NARRATE_TOOL = "mcp__brane__narrate";
const LISTEN_TOOL = "mcp__brane__listen";

/** Unwrap one layer of the MCP result envelope, which vendors apply
 *  inconsistently: some hooks report the tool's object, some report
 *  `{ content: [{ type: "text", text }] }` with the object as JSON inside. */
function unwrapToolResult(value: unknown): Record<string, unknown> | null {
  const asObject = (v: unknown): Record<string, unknown> | null =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const parse = (v: unknown): unknown => {
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  };
  const outer = asObject(parse(value));
  if (!outer) return null;
  if (!Array.isArray(outer.content)) return outer;
  const text = (outer.content as Array<Record<string, unknown>>).find(
    (part) => typeof part?.text === "string",
  )?.text;
  return asObject(parse(text));
}

/** What to store for a call the loop made about itself.
 *
 *  `narrate` and `listen` carry the narrative in their payloads, so capturing
 *  them verbatim writes the chat into the database two more times: a narration
 *  lands in `events`, again as the tool's `say`, and a third time in the
 *  receipt that echoes the event just written. Measured on one live narrative,
 *  the narrate rows came to 2.4× the bytes of the narrative they described
 *  (claude-n1izig04:40/:42).
 *
 *  Size is the smaller half. The event bodies and cursor watermarks would also
 *  make the permanent log record exactly how the append-only stream happened to
 *  be partitioned by listen boundaries — an artifact of when an agent woke up
 *  rather than of anything that happened, and the same underlying log either
 *  way (operator invariant, claude-n1izig04:43/:46).
 *
 *  What survives is chosen by one test: **does this exist anywhere else?**
 *
 *  - `listen` keeps its cursors, verbatim. They do implicitly encode how one
 *    session was chunked, and the operator has weighed that and accepted it:
 *    "not the end of the world" (claude-n1izig04:50/:51). They are also the
 *    only record of *who was being watched* — the events are in both logs, the
 *    attention is only here.
 *  - `listen` output goes entirely. Every byte of it is in `events`.
 *  - `narrate` keeps `{nid, seq}`, the pointer the UI renders and the only part
 *    of an outgoing message this side should carry (claude-n1izig04:48).
 *  - `narrate`'s `say` is dropped **only against proof that it landed** — a
 *    `seq` in the result means the text is in `events` and this copy is
 *    redundant. Without that proof it is kept, because the words of a narrate
 *    that *failed* exist nowhere else, and a rule that couldn't tell the two
 *    apart would quietly destroy the one case that mattered. In practice the
 *    `PreToolUse` row keeps the text and the `PostToolUse` write clears it.
 *
 *  Note the invariant is weaker than it looks and cannot be made stronger here:
 *  every row is anchored to `after_seq`, the narrative head at capture time, so
 *  a listen row still says where in the stream it sat. Dropping watermarks
 *  declines to keep a second, exact, machine-readable copy of that; it does not
 *  erase it. */
export function leanLoopCapture(
  narrativeId: string,
  name: string,
  input: unknown,
  output: unknown,
): { input: unknown; output: unknown } {
  if (name === LISTEN_TOOL) return { input, output: undefined };
  if (name !== NARRATE_TOOL) return { input, output };

  const target = unwrapToolResult(input)?.nid;
  const foreign = typeof target === "string" && target !== narrativeId;
  const seq = unwrapToolResult(output)?.seq;
  if (typeof seq !== "number") {
    // No proof the narration is in the log yet — keep the call as it came.
    return { input, output };
  }
  // `{}` rather than nothing: the upsert coalesces, so only a non-null value
  // can replace the verbatim input the PreToolUse row already stored.
  return {
    input: foreign ? { nid: target } : {},
    output: foreign ? { nid: target, seq } : {},
  };
}


/** Cut `text` to at most `capBytes` of UTF-8, on a character boundary.
 *  Encode once and back off from the byte budget while it lands on a
 *  continuation byte (0b10xxxxxx), i.e. inside a multi-byte sequence. Slicing
 *  the *string* instead would split an astral character's surrogate pair and
 *  leave a lone surrogate rendering as U+FFFD; slicing the *bytes* without the
 *  back-off would do the same one layer down (claude-8fkbabsx:9, finding 7).
 *  Single pass — the old loop rescanned a shrinking string geometrically. */
function excerptText(
  text: string | null,
  capBytes: number,
): { text: string | null; truncated: boolean } {
  if (text === null) return { text, truncated: false };
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= capBytes) return { text, truncated: false };
  let end = capBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf-8"), truncated: true };
}

/** Cap on input/output text in a *list* — the window read, the catch-up read,
 *  and the inline push.
 *
 *  Much smaller than the push cap above, because a listed row is drawn as one
 *  line: a name, a status, a duration, and an argument summary the UI clamps to
 *  240 characters. The only payload a collapsed row genuinely needs is the
 *  `{nid, seq}` pointer on a foreign narrate, which is about thirty bytes.
 *  Everything else was being shipped for a detail view that now fetches the row
 *  whole when the operator opens it (claude-n1izig04:75).
 *
 *  Measured: one narrative's 265 rows were a 3.65MB response at the old cap. */
export const LIST_EXCERPT_BYTES = 1_024;

/** Floor below which a cap is read as "no cap given" rather than honored.
 *
 *  No caller ever means to excerpt a tool payload to a handful of bytes: the
 *  smallest thing this function is asked to preserve is a `{nid, seq}` pointer,
 *  which is about thirty. A number below the floor is therefore not a small
 *  budget, it is a mistake — and the mistake that actually happened was
 *  `.map(excerptForPush)`, where `map`'s index argument landed in `capBytes`
 *  and blanked every inline-pushed row's input while storage stayed whole
 *  (claude-bk6vwpc8:9). Treating it as absent makes that whole family of
 *  index-as-argument slips inert instead of silently emptying the wire.
 *
 *  NaN falls through the same door — `NaN >= floor` is false — which matters
 *  because a mistyped config parses to NaN and NaN fails every comparison
 *  quietly (the trap `numericConfig` exists to close). */
const MIN_EXCERPT_CAP_BYTES = 64;

/** Shape a row for a list or an inline push: oversized input/output become
 *  excerpts with `input_truncated`/`output_truncated` flags, so a client knows
 *  the daemon holds more and can ask for that row in full. The database row is
 *  untouched. */
export function excerptForPush(
  row: ToolUseRow,
  capBytes: number = LIST_EXCERPT_BYTES,
): ToolUseRow & {
  input_truncated?: boolean;
  output_truncated?: boolean;
} {
  const cap = capBytes >= MIN_EXCERPT_CAP_BYTES ? capBytes : LIST_EXCERPT_BYTES;
  const input = excerptText(row.input, cap);
  const output = excerptText(row.output, cap);
  if (!input.truncated && !output.truncated) return row;
  return {
    ...row,
    input: input.text,
    output: output.text,
    ...(input.truncated ? { input_truncated: true } : {}),
    ...(output.truncated ? { output_truncated: true } : {}),
  };
}

/** The `PostToolUse` payload as Claude Code sends it. Other agents' hooks
 *  converged on the same field names (claude-xlolbv6l:61), so this shape is
 *  the cross-agent contract — every field beyond `tool_name` is optional. */
export interface ClaudeHookPayload {
  /** Which hook fired. `PreToolUse` announces a call that hasn't run yet;
   *  absent on vendors that send only one kind, which reads as a completion. */
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  duration_ms?: number;
  error?: string;
  parent_tool_use_id?: string;
  /** The vendor said this call failed, without saying why.
   *
   *  Claude reports failure inside the payload it already sends — an `error`
   *  string, or `is_error` on the response — so this field is never set on its
   *  hooks. Other harnesses report the *outcome* out of band: goose fires a
   *  separate `PostToolUseFailure` event, cline sends `postToolUse.success:
   *  false`. Neither carries a message.
   *
   *  The alternative was to have `normalizeHookPayload` synthesize an `error`
   *  string so the existing check would fire. That would store words no vendor
   *  ever sent in the column an operator reads as the tool's own complaint.
   *  A boolean says exactly what is known and no more: it failed, and the
   *  reason is not in this payload. */
  failed?: boolean;
}

/** Read a dotted path out of an untrusted payload, or undefined. */
function pluck(source: unknown, path: string): unknown {
  let cursor = source;
  for (const key of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/** First defined value among `paths`, read from `raw`. */
function firstOf(raw: unknown, paths: string[]): unknown {
  for (const path of paths) {
    const value = pluck(raw, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** Where each canonical field hides in the harnesses that don't use Claude's
 *  names. Canonical first, so a payload that already speaks the contract is
 *  returned unchanged.
 *
 *  - **goose** (Open Plugins): `event`, and the response under `tool_output`.
 *  - **crush**: `event`; `tool_input` is already an object "for compatibility
 *    with Claude Code hooks" (their source comment). No Post event exists.
 *  - **cline**: `hookName`, with the call under `tool_call` / `preToolUse` and
 *    the outcome under `tool_result` / `postToolUse`. */
const HOOK_FIELD_ALIASES: Record<keyof ClaudeHookPayload, string[]> = {
  hook_event_name: ["hook_event_name", "event", "hookName"],
  tool_name: [
    "tool_name",
    "tool_call.name",
    "preToolUse.toolName",
    "postToolUse.toolName",
    "tool_result.name",
  ],
  tool_input: [
    "tool_input",
    "tool_call.input",
    "preToolUse.parameters",
    "postToolUse.parameters",
    "tool_result.input",
  ],
  tool_response: ["tool_response", "tool_output", "postToolUse.result", "tool_result.output"],
  tool_use_id: [
    "tool_use_id",
    "tool_call.id",
    "tool_result.id",
    "tool_result.tool_call_id",
    "tool_call_id",
  ],
  duration_ms: ["duration_ms", "postToolUse.executionTimeMs", "execution_time_ms"],
  // No `parent_agent_id` here on purpose: cline sends one, but it identifies a
  // sub-agent, not the tool call that spawned this one. Storing it as
  // `parent_id` would draw a nesting edge that doesn't exist.
  error: ["error", "tool_result.error", "postToolUse.error"],
  parent_tool_use_id: ["parent_tool_use_id", "parent_tool_use.id"],
  failed: [],
};

/** Event names that announce a call rather than report one.
 *
 *  `pretooluse` covers claude, goose and crush. Cline is the odd one: it names
 *  its hooks after the *thing* rather than the phase — `tool_call` for the
 *  pre-hook and `tool_result` for the post — so its pre event has to be listed
 *  by name or every cline call would be recorded as finished on arrival.
 *
 *  Compared lowercased and stripped of separators, because goose and crush both
 *  accept case and underscore variants of their own event names. */
const PRE_TOOL_USE_EVENTS = new Set(["pretooluse", "toolcall"]);

function isPreToolUseEvent(name: unknown): boolean {
  return (
    typeof name === "string" && PRE_TOOL_USE_EVENTS.has(name.toLowerCase().replace(/[_\-\s]/g, ""))
  );
}

/** Translate one harness's hook payload into the shape the ingest expects.
 *
 *  Dispatch is on the payload's *shape*, not on the narrative's `agent_type`.
 *  Both were available — the ingest route knows the bound narrative's agent —
 *  and shape wins for two reasons. An external agent that connected without
 *  `brane spawn` has whatever `agent_type` its row happened to get, so a
 *  per-agent switch would silently stop capturing the moment the label and the
 *  binary disagree. And the aliases don't actually collide: no harness uses
 *  another's field name for a different thing, so reading them all costs
 *  nothing and keeps this function a pure map from bytes to bytes.
 *
 *  The one translation that is not cosmetic is `hook_event_name`. Both goose
 *  and crush send `event: "PreToolUse"`, which `toolUseFromClaudeHook` does not
 *  recognize — so an un-normalized pre-hook falls through to the completion
 *  path and records the call as `completed`, with a null output, at the instant
 *  it starts. Every long call would show as having finished immediately. */
export function normalizeHookPayload(raw: unknown): ClaudeHookPayload {
  const out: ClaudeHookPayload = {};

  const event = firstOf(raw, HOOK_FIELD_ALIASES.hook_event_name);
  if (isPreToolUseEvent(event)) out.hook_event_name = "PreToolUse";
  else if (typeof event === "string") out.hook_event_name = event;

  const name = firstOf(raw, HOOK_FIELD_ALIASES.tool_name);
  if (typeof name === "string") out.tool_name = name;

  const input = firstOf(raw, HOOK_FIELD_ALIASES.tool_input);
  if (input !== undefined) out.tool_input = input;

  const response = firstOf(raw, HOOK_FIELD_ALIASES.tool_response);
  if (response !== undefined) out.tool_response = response;

  const id = firstOf(raw, HOOK_FIELD_ALIASES.tool_use_id);
  if (typeof id === "string") out.tool_use_id = id;

  const duration = firstOf(raw, HOOK_FIELD_ALIASES.duration_ms);
  if (typeof duration === "number" && Number.isFinite(duration)) out.duration_ms = duration;

  const error = firstOf(raw, HOOK_FIELD_ALIASES.error);
  if (typeof error === "string" && error !== "") out.error = error;
  else if (error !== undefined) out.error = JSON.stringify(error);

  const parent = firstOf(raw, HOOK_FIELD_ALIASES.parent_tool_use_id);
  if (typeof parent === "string") out.parent_tool_use_id = parent;

  // Outcome reported as a flag or a dedicated event — see `failed` above.
  const failureEvent =
    typeof event === "string" && /failure|failed|error/i.test(event) && !isPreToolUseEvent(event);
  if (failureEvent || pluck(raw, "postToolUse.success") === false) out.failed = true;

  return out;
}

/** Map a hook payload to a `recordToolUse` call. Pure, so the contract above
 *  is pinned by tests rather than claimed by a comment (claude-8fkbabsx:9,
 *  finding 4) — the HTTP handler is left doing nothing but routing.
 *
 *  Returns null when `tool_name` is absent: without it there is no call to
 *  record, and the caller answers 400. A payload is "failed" if it carries an
 *  `error`, if the response is an object with `is_error: true` — the shape
 *  Claude uses to report a tool that ran and rejected — or if `failed` is set,
 *  which is how the other harnesses' out-of-band outcome signals arrive.
 *
 *  A `PreToolUse` payload is the same call seen earlier: it names the tool
 *  before it runs, so the row can appear while the work is happening rather
 *  than after it's over (claude-mvpe4t45:46). It carries no response, no
 *  duration and no outcome, so mapping it through the completion path — where
 *  "no error present" means success — would report every call as finished the
 *  instant it began. It maps to `pending` instead, and the PostToolUse upsert
 *  fills in the rest. */
export function toolUseFromClaudeHook(
  payload: ClaudeHookPayload,
  extra: { source: ToolUseRow["source"]; agentType?: string; now?: number },
): RecordToolUseOpts | null {
  if (!payload.tool_name) return null;
  if (payload.hook_event_name === "PreToolUse") {
    return {
      dedupKey: payload.tool_use_id,
      name: payload.tool_name,
      input: payload.tool_input,
      status: "pending",
      source: extra.source,
      agentType: extra.agentType,
      parentId: payload.parent_tool_use_id,
      startedAt: extra.now ?? Date.now(),
    };
  }
  const response = payload.tool_response;
  const failed =
    payload.failed === true ||
    payload.error !== undefined ||
    (typeof response === "object" &&
      response !== null &&
      (response as { is_error?: boolean }).is_error === true);
  return {
    dedupKey: payload.tool_use_id,
    name: payload.tool_name,
    input: payload.tool_input,
    status: failed ? "failed" : "completed",
    output: response,
    durationMs: payload.duration_ms,
    error: payload.error,
    source: extra.source,
    agentType: extra.agentType,
    parentId: payload.parent_tool_use_id,
  };
}

/** Content-hash fallback identity for vendors that don't supply a tool_use_id. */
export function contentDedupKey(
  narrativeId: string,
  startedAt: number,
  name: string,
  input: string | null,
): string {
  return createHash("sha256")
    .update(`${narrativeId}|${startedAt}|${name}|${input ?? ""}`)
    .digest("hex");
}

/** How far back a completion may reach to find the call it completes.
 *
 *  Only relevant to vendors that send no id (see `claimPendingTwin`). The
 *  bound has to clear the longest call an agent can legitimately make, because
 *  a completion that arrives after the window records a second row instead of
 *  closing the first — so this is sized against `MCP_TOOL_TIMEOUT_MS`, the
 *  one-hour ceiling brane asks agent clients to allow for a held `listen`,
 *  plus a margin. Beyond that the pairing degrades to the old behaviour rather
 *  than to something worse. */
const PAIR_WINDOW_MS = 65 * 60 * 1000;

/** Find the `pending` row a completion belongs to, when the vendor gave no id
 *  to match on.
 *
 *  goose is the case this exists for, and its payload is the reason it has to:
 *  its `PreToolUse` and `PostToolUse` bodies are **byte-identical apart from
 *  the event name** — `{event, matcher_context, session_id, tool_input,
 *  tool_name, working_dir}`, verified by capturing live payloads. There is no
 *  call id anywhere in either. So `contentDedupKey` — which mixes in
 *  `startedAt` to tell two identical calls apart — gives the two halves
 *  different keys and every call lands as a `pending` row that never closes
 *  plus a separate `completed` one.
 *
 *  Matching on (narrative, name, input) instead pairs them. What the timestamp
 *  was doing in the key still has to be done by something, though, or two
 *  genuinely identical calls collapse into one row — hence:
 *
 *  - **Only a completion claims**, never a `pending`. Two concurrent identical
 *    calls each insert their own row on the way in; nothing is merged there.
 *  - **The claim consumes the row**: matching requires `status = 'pending'`, so
 *    the second completion cannot take the same row as the first. Two calls in,
 *    two rows out, both closed.
 *  - **Newest first.** For sequential calls — the common case — there is only
 *    ever one candidate, so the choice is moot. It matters for a *stale*
 *    pending (an agent killed mid-call): preferring the newest means a fresh
 *    call's own row is claimed and the stale one is left alone, rather than the
 *    fresh completion being absorbed by a corpse and its own row orphaned.
 *
 *  What this cannot do is tell apart two identical calls that overlap *and*
 *  finish out of order — their durations get swapped. Both rows still close,
 *  which is the property worth protecting; the alternative is a permanently
 *  running row, and no id exists to do better. */
function claimPendingTwin(
  db: Database.Database,
  narrativeId: string,
  name: string,
  input: string | null,
  now: number,
): { dedup_key: string; started_at: number } | undefined {
  return db
    .prepare(
      `SELECT dedup_key, started_at FROM tool_uses
        WHERE narrative_id = ? AND name = ? AND status = 'pending'
          AND input IS ? AND started_at >= ? AND started_at <= ?
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get(narrativeId, name, input, now - PAIR_WINDOW_MS, now) as
    | { dedup_key: string; started_at: number }
    | undefined;
}

/** Upsert a tool call. Idempotent by (narrative_id, dedup_key): the same call
 *  arriving twice — PreToolUse then PostToolUse, live by hook then later by
 *  session-log backfill — collapses to one row. `after_seq` and `started_at`
 *  are preserved: a row's display position is fixed at first sight and never
 *  moves, which is what lets clients update in place instead of re-sorting
 *  (claude-xlolbv6l:81). With both hooks reporting, first sight is the call's
 *  real start rather than a time reconstructed from its duration.
 *
 *  An update never erases knowledge. The two hooks are independent HTTP calls
 *  and can arrive out of order, so a late `pending` must not undo a completion
 *  — it would strand a finished call as permanently running, which on the
 *  client reads as a tool that never returned. A status that would regress to
 *  `pending` is ignored, and every other mutable field coalesces over what is
 *  already stored rather than overwriting it with the null a PreToolUse
 *  payload necessarily carries.
 *
 *  `rev` is allocated as MAX(rev)+1 per narrative inside the same transaction
 *  (better-sqlite3 transactions are synchronous and SQLite has one writer, so
 *  this cannot race). Every write bumps it — rev is the sync cursor, and a
 *  mutation without a bump would be invisible to a resuming client. */
export function recordToolUse(
  db: Database.Database,
  narrativeId: string,
  opts: RecordToolUseOpts,
): ToolUseRow {
  const durationMs = opts.durationMs ?? null;
  const startedAt = opts.startedAt ?? Date.now() - (durationMs ?? 0);
  // Applied here rather than at the hook boundary so no writer can bypass it:
  // one chokepoint, and the rule holds for absorbed and session-log rows too.
  const lean = leanLoopCapture(narrativeId, opts.name, opts.input, opts.output);
  const input = prepareCaptureText(lean.input);
  const output = prepareCaptureText(lean.output);
  // What the call *was*, before the loop-capture rule shrank it. Both the
  // content key and the twin lookup match on this rather than on `input`,
  // because `leanLoopCapture` can rewrite a narrate's input to `{nid}` — but
  // only on the half that carries a proving `seq`. Matching the stored value
  // would then have a completion looking for `{nid}` while its own pending row
  // holds the whole payload, finding nothing, and opening a second row: the
  // exact defect this pairing exists to remove, reappearing on precisely the
  // tool whose rows the operator reads most.
  const identityInput = prepareCaptureText(opts.input);
  const txn = db.transaction((): ToolUseRow => {
    // Identity is computed from what the call actually was, not from the leaner
    // thing we store: two self-narrations both keep a null input, and a key
    // derived from that would tell them apart only by their start millisecond.
    //
    // Resolved inside the transaction because the id-less path *reads* other
    // rows to find the call it completes, and two hooks landing together must
    // not both claim the same one.
    let dedupKey = opts.dedupKey;
    let duration = durationMs;
    if (!dedupKey) {
      const twin =
        opts.status === "pending"
          ? undefined
          : claimPendingTwin(db, narrativeId, opts.name, identityInput, startedAt);
      if (twin) {
        dedupKey = twin.dedup_key;
        // The vendor timed nothing, but the daemon did: the pre hook arrived
        // when the call began and this one arrived when it ended, so the gap
        // between the two receipts *is* the duration. goose ends up with
        // better timing than its own payload carries.
        if (duration === null && startedAt > twin.started_at) {
          duration = startedAt - twin.started_at;
        }
      } else {
        dedupKey = contentDedupKey(narrativeId, startedAt, opts.name, identityInput);
      }
    }

    const revRow = db
      .prepare("SELECT COALESCE(MAX(rev), 0) AS max_rev FROM tool_uses WHERE narrative_id = ?")
      .get(narrativeId) as { max_rev: number };
    const rev = revRow.max_rev + 1;
    const afterSeq = opts.afterSeq ?? getMaxSeq(db, narrativeId);

    db.prepare(
      `INSERT INTO tool_uses (
         narrative_id, dedup_key, after_seq, started_at, rev,
         name, input, status, output, duration_ms, error,
         source, agent_type, parent_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (narrative_id, dedup_key) DO UPDATE SET
         rev = excluded.rev,
         -- Input coalesces like every other mutable field, so an agent whose
         -- PostToolUse payload omits tool_input can't wipe what PreToolUse
         -- recorded. The one write that deliberately *replaces* it is a loop
         -- call proving its text reached the log (see leanLoopCapture), which
         -- is why that path returns a non-null value rather than nothing.
         input = COALESCE(excluded.input, tool_uses.input),
         status = CASE
           WHEN excluded.status = 'pending' AND tool_uses.status != 'pending'
           THEN tool_uses.status
           ELSE excluded.status
         END,
         output = COALESCE(excluded.output, tool_uses.output),
         duration_ms = COALESCE(excluded.duration_ms, tool_uses.duration_ms),
         error = COALESCE(excluded.error, tool_uses.error),
         source = excluded.source`,
    ).run(
      narrativeId,
      dedupKey,
      afterSeq,
      startedAt,
      rev,
      opts.name,
      input,
      opts.status,
      output,
      duration,
      opts.error ?? null,
      opts.source,
      opts.agentType ?? null,
      opts.parentId ?? null,
    );

    return db
      .prepare("SELECT * FROM tool_uses WHERE narrative_id = ? AND dedup_key = ?")
      .get(narrativeId, dedupKey) as ToolUseRow;
  });
  return txn();
}

/** The rows of one inline-push flush: display order, shaped for the wire.
 *
 *  Exported as a unit because the bug it replaces was not in `excerptForPush`
 *  but in *how it was called*. The daemon flushed with `.map(excerptForPush)`,
 *  and `map` passes `(value, index, array)` — so once #375 gave the function a
 *  `capBytes` second parameter, every pushed row was excerpted to its own
 *  index, row 0 to zero bytes. Storage stayed whole, so args were blank live
 *  and correct on reload (claude-bk6vwpc8:9). A unit test on `excerptForPush`
 *  passed throughout; only a test of the call site could have failed. This is
 *  that call site, reachable without standing up a daemon. */
export function shapeToolUsesForPush(
  rows: ToolUseRow[],
): Array<ReturnType<typeof excerptForPush>> {
  return [...rows]
    .sort((a, b) => a.after_seq - b.after_seq || a.started_at - b.started_at)
    .map((row) => excerptForPush(row));
}

/** A row's position in display order — the compound sort key, and the resume
 *  point for paging past a `limit`. `after_seq` alone is not unique (a burst
 *  shares one anchor), so a cursor that carried only it would either skip or
 *  repeat rows at a page boundary. */
export interface ToolUseCursor {
  afterSeq: number;
  startedAt: number;
  dedupKey: string;
}

/** The resume point for the window page that follows `rows`, or null if the
 *  page was empty. */
export function toolUseCursor(rows: ToolUseRow[]): ToolUseCursor | null {
  const last = rows[rows.length - 1];
  if (!last) return null;
  return { afterSeq: last.after_seq, startedAt: last.started_at, dedupKey: last.dedup_key };
}

/** The two reads are deliberately separate functions, not one with two
 *  cursors, because once a `limit` exists they need *different orderings* and
 *  nothing sensible happens if you pass both (claude-8fkbabsx:14):
 *
 *  - the **window** read is a display query: it must come back in display
 *    order, and truncating it just means some visible rows aren't drawn yet;
 *  - the **catch-up** read is a sync query: truncating it in display order
 *    would return an arbitrary subset by rev, and since the client's watermark
 *    is the highest rev it has applied, a high rev in a truncated page moves
 *    the watermark past rows it never saw — permanently. Ordered by rev,
 *    "highest received" and "highest contiguous" are the same number, so
 *    truncation degrades to "ask again" instead of losing rows.
 *
 *  Both are bounded because rows store input/output verbatim and uncapped:
 *  one unbounded response can hand `JSON.stringify` an arbitrarily large
 *  string on the daemon's only thread. */
export interface ReadToolUseWindowOpts {
  afterSeqGte?: number;
  /** Exclusive upper bound — [gte, lt) so paging back fetches only the newly
   *  exposed band instead of re-downloading the suffix already held. */
  afterSeqLt?: number;
  limit?: number;
  /** Resume strictly after this position, for the next page. */
  after?: ToolUseCursor;
}

/** Display query: rows anchored in [afterSeqGte, afterSeqLt), in display
 *  order (rides tool_uses_order). Resume a truncated page from
 *  `toolUseCursor(rows)`. */
export function readToolUseWindow(
  db: Database.Database,
  narrativeId: string,
  opts: ReadToolUseWindowOpts = {},
): ToolUseRow[] {
  const where = ["narrative_id = ?", "after_seq >= ?"];
  const params: (string | number)[] = [narrativeId, opts.afterSeqGte ?? 0];
  if (opts.afterSeqLt !== undefined) {
    where.push("after_seq < ?");
    params.push(opts.afterSeqLt);
  }
  if (opts.after) {
    // Row-value comparison against the exact tuple the ORDER BY uses, so the
    // next page starts where the last stopped — no gap, no repeat. after_seq
    // alone can't do this: a burst shares one anchor.
    where.push("(after_seq, started_at, dedup_key) > (?, ?, ?)");
    params.push(opts.after.afterSeq, opts.after.startedAt, opts.after.dedupKey);
  }
  let sql = `SELECT * FROM tool_uses
       WHERE ${where.join(" AND ")}
       ORDER BY after_seq, started_at, dedup_key`;
  if (opts.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }
  return db.prepare(sql).all(...params) as ToolUseRow[];
}

/** Sync query: rows written or *mutated* since the client's watermark, in rev
 *  order (rides tool_uses_sync). The caller's next watermark is the last row's
 *  `rev` — never `MAX(rev)` over the narrative, which is only correct for an
 *  untruncated read. Display order is the caller's job: sort by
 *  (after_seq, started_at), never by rev. */
/** One row, whole, by the identity the client already holds.
 *
 *  The list reads excerpt, because a page of verbatim rows is megabytes. This
 *  is the other half of that bargain: when the operator opens a row, the client
 *  asks for that one row in full. Paying for a payload at the moment someone
 *  wants to read it is a different trade from paying for every payload in case
 *  someone might (claude-n1izig04:73). */
export function readToolUse(
  db: Database.Database,
  narrativeId: string,
  dedupKey: string,
): ToolUseRow | null {
  const row = db
    .prepare("SELECT * FROM tool_uses WHERE narrative_id = ? AND dedup_key = ?")
    .get(narrativeId, dedupKey) as ToolUseRow | undefined;
  return row ?? null;
}

export function readToolUsesSince(
  db: Database.Database,
  narrativeId: string,
  opts: { sinceRev?: number; limit?: number } = {},
): ToolUseRow[] {
  let sql = `SELECT * FROM tool_uses
       WHERE narrative_id = ? AND rev > ?
       ORDER BY rev`;
  const params: (string | number)[] = [narrativeId, opts.sinceRev ?? 0];
  if (opts.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }
  return db.prepare(sql).all(...params) as ToolUseRow[];
}

/** Highest rev currently stored for a narrative.
 *
 *  **Not a client watermark**, despite what this docstring used to say
 *  (claude-8fkbabsx:19). A client's watermark is the highest rev it has
 *  actually *applied*: this number is only equal to that after an unwindowed,
 *  untruncated catch-up, and silently ahead of it in every other case — which
 *  is exactly the row-skipping bug the read path was split to prevent. Nothing
 *  in the daemon calls this today; it survives as a test helper and as the
 *  honest answer to "what is the true max", which is a different question from
 *  "what has this client seen". */
export function maxToolUseRev(db: Database.Database, narrativeId: string): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(rev), 0) AS max_rev FROM tool_uses WHERE narrative_id = ?")
    .get(narrativeId) as { max_rev: number };
  return row.max_rev;
}

/** How far a settle may reach back from the call's own start to find its row.
 *  The `PreToolUse` hook runs before the call reaches the daemon, so the row's
 *  `started_at` is a little *older* than the timestamp the daemon stamps; the
 *  forward slack covers a hook that lost a race to the socket. Anything
 *  outside this window is a different call. */
const SETTLE_LOOKBACK_MS = 15_000;
const SETTLE_LOOKAHEAD_MS = 5_000;

/** Correct the row for a call the daemon served itself, using the duration it
 *  actually took.
 *
 *  Hook timing is a vendor's business and it is not always the truth. Claude
 *  Code moves a tool call to the background at 120s and fires `PostToolUse`
 *  right then, so every `listen` that outlives two minutes is recorded as
 *  having completed in exactly 120.0s while it is still blocking — a row that
 *  is wrong in both directions, `pending` while the agent may already be idle
 *  and `completed` for however long it really keeps waiting
 *  (claude-n1izig04:33/:35).
 *
 *  For its own MCP tools the daemon does not have to take the hook's word: it
 *  resolves the call, so it knows when the call ended. This writes that back.
 *
 *  Identification is positional rather than by `dedup_key`, which the daemon
 *  never sees — the newest row of that name inside a window around the call's
 *  start. An agent blocked in `listen` cannot issue another, so "the newest
 *  listen row for this narrative" is unambiguous in the case that matters.
 *
 *  Only ever *extends* a recorded duration. A shorter answer means this is not
 *  the row we served (or the hook already told the truth), and a settle that
 *  could shrink a duration would let a stray call rewrite a finished one.
 *  Returns the updated row, or null when there was nothing to correct. */
export function settleDaemonCall(
  db: Database.Database,
  narrativeId: string,
  name: string,
  startedAtHint: number,
  endedAt: number,
): ToolUseRow | null {
  const txn = db.transaction((): ToolUseRow | null => {
    const row = db
      .prepare(
        `SELECT * FROM tool_uses
          WHERE narrative_id = ? AND name = ? AND started_at BETWEEN ? AND ?
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(
        narrativeId,
        name,
        startedAtHint - SETTLE_LOOKBACK_MS,
        startedAtHint + SETTLE_LOOKAHEAD_MS,
      ) as ToolUseRow | undefined;
    if (!row) return null;

    const duration = endedAt - row.started_at;
    if (duration <= 0) return null;
    if (row.duration_ms !== null && row.duration_ms >= duration) return null;

    // A call the daemon answered did not fail, so `pending` becomes
    // `completed`. A row already marked `failed`/`denied` keeps that verdict —
    // whatever it describes, this settle is not evidence against it.
    const status = row.status === "failed" || row.status === "denied" ? row.status : "completed";
    const revRow = db
      .prepare("SELECT COALESCE(MAX(rev), 0) AS max_rev FROM tool_uses WHERE narrative_id = ?")
      .get(narrativeId) as { max_rev: number };

    db.prepare(
      `UPDATE tool_uses SET duration_ms = ?, status = ?, rev = ?
        WHERE narrative_id = ? AND dedup_key = ?`,
    ).run(duration, status, revRow.max_rev + 1, narrativeId, row.dedup_key);

    return db
      .prepare("SELECT * FROM tool_uses WHERE narrative_id = ? AND dedup_key = ?")
      .get(narrativeId, row.dedup_key) as ToolUseRow;
  });
  return txn();
}
