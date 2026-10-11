/** Claude Code's local session store as an absorb source.
 *
 *  Claude Code writes every session to `~/.claude/projects/<cwd, with `/` as
 *  `-`>/<session uuid>.jsonl`, one JSON record per line, appended as the
 *  session runs. It is the engineering half of a Claude user's history — the
 *  half no export request can produce and no hosted product ever sees — and
 *  it is already on the disk of anyone who has run `claude` once. Nothing here
 *  makes a network call; the file is read and the database is written.
 *
 *  The file is heterogeneous. Of its record types only two carry
 *  conversation — `user` and `assistant` — and even those double as
 *  bookkeeping: a `user` record whose content is a `tool_result` block is a
 *  tool's return value, not something the operator typed, and a `user`
 *  record with `isMeta` is text the harness injected. Everything else (`mode`,
 *  `ai-title`, `attachment`, `file-history-snapshot`, `cost-state`, …) is
 *  state the harness keeps for itself. Two such records are read here:
 *  `ai-title`, for the narrative's title, and the `attachment` that carries a
 *  message the operator sent while a turn was running (`queuedTurnOf`).
 *
 *  A session written by a brane-spawned agent has the same shape plus
 *  `tool_use` blocks named `mcp__brane__*`; the parser makes no distinction.
 *  What distinguishes those sessions is that brane already owns them, which
 *  `runLocalAbsorb` decides from `narratives.session_ids` before any parse.
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { userInfo } from "node:os";
import type {
  AbsorbIdentity,
  AbsorbedAttachment,
  AbsorbedConversation,
  AbsorbedMessage,
  AbsorbedToolCall,
  LocalSource,
  SessionCandidate,
} from "./types.js";

/** Where the store lives under a home directory. */
export function claudeProjectsRoot(home: string): string {
  return join(home, ".claude", "projects");
}

/** The account Claude Code is signed into, from `~/.claude.json`'s
 *  `oauthAccount`; the OS user when there is none (an API-key install, a
 *  copied store). The account uuid keys the derived brane id, so the same
 *  person's sessions from two machines land in one brane. */
export function claudeIdentity(home: string): AbsorbIdentity {
  try {
    const raw = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
    const acct = raw?.oauthAccount;
    if (acct && typeof acct === "object") {
      const id = typeof acct.accountUuid === "string" ? acct.accountUuid : undefined;
      const email = typeof acct.emailAddress === "string" ? acct.emailAddress : undefined;
      if (id || email) {
        return { id: id ?? email!, email, label: email ?? id! };
      }
    }
  } catch {
    // no ~/.claude.json, or not ours to parse — fall through
  }
  let user = "operator";
  try {
    user = userInfo().username || user;
  } catch {
    // userInfo can throw on exotic setups; the fallback label is fine
  }
  return { id: user, label: user };
}

/** How many leading bytes the survey reads to learn a session's cwd and
 *  start time. Sessions open with a handful of one-line bookkeeping records
 *  before the first message; the first record with a `cwd` is within a few
 *  KB of the top in every file seen. A file whose head yields nothing is
 *  still listed, with the fields it lacks null. */
const SURVEY_HEAD_BYTES = 64 * 1024;

function readHead(path: string, bytes: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

/** Session files are `<uuid>.jsonl`; `agent-<id>.jsonl` files beside them are
 *  subagent transcripts, which belong to their parent session and are not
 *  sessions of their own (the same rule `claudeAdapter.discoverSessionId`
 *  applies). */
function isSessionFile(name: string): boolean {
  return name.endsWith(".jsonl") && !name.startsWith("agent-");
}

/** Every session in the store, on a stat and a head read each. */
export function surveyClaudeSessions(root: string): SessionCandidate[] {
  const out: SessionCandidate[] = [];
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return out;
  }
  for (const project of projects) {
    const dir = join(root, project);
    let files: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!isSessionFile(file)) continue;
      const path = join(dir, file);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      const head = readHead(path, Math.min(SURVEY_HEAD_BYTES, st.size));
      let cwd: string | null = null;
      let startedAt: number | null = null;
      for (const line of head.split("\n")) {
        if (!line) continue;
        let rec: ClaudeRecord;
        try {
          rec = JSON.parse(line);
        } catch {
          continue; // the last line of a head read is usually cut mid-record
        }
        if (cwd === null && typeof rec.cwd === "string") cwd = rec.cwd;
        if (startedAt === null && typeof rec.timestamp === "string") {
          const t = Date.parse(rec.timestamp);
          if (!Number.isNaN(t)) startedAt = t;
        }
        if (cwd !== null && startedAt !== null) break;
      }
      out.push({
        externalId: file.slice(0, -".jsonl".length),
        path,
        cwd,
        startedAt,
        updatedAt: Math.floor(st.mtimeMs),
        bytes: st.size,
      });
    }
  }
  return out;
}

// ---- the parse ----------------------------------------------------------

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  source?: { type?: string; media_type?: string; data?: string };
}

interface ClaudeRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  aiTitle?: string;
  attachment?: {
    type?: string;
    commandMode?: string;
    prompt?: string | ContentBlock[];
  };
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    model?: string;
  };
}

/** Text of a message: string content as is, block content as its `text`
 *  blocks joined. `thinking` blocks are deliberately not included — they are
 *  the model's scratch, not its voice, and a narrative is the voice. Nor is
 *  reasoning something absorb promises for any source: some tools withhold
 *  it and brane has nowhere to show it (claude-xiy9e8wq:20). */
function textOf(content: string | ContentBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n\n");
}

/** The image blocks of a user turn, as attachments. A pasted image is the
 *  one binary a session file carries: Claude Code writes it into the record
 *  itself, base64 in `source.data`, beside a `[Image #N]` text block. Only
 *  base64 sources occur in the store; a `url` source would need a fetch
 *  absorb never makes, so it is left out rather than guessed at. */
function attachmentsOf(blocks: ContentBlock[]): AbsorbedAttachment[] {
  const out: AbsorbedAttachment[] = [];
  for (const b of blocks) {
    if (b.type !== "image" || !b.source || b.source.type !== "base64") continue;
    if (typeof b.source.data !== "string" || b.source.data.length === 0) continue;
    out.push({
      mediaType: typeof b.source.media_type === "string" ? b.source.media_type : "application/octet-stream",
      data: b.source.data,
    });
  }
  return out;
}

// ---- what the harness writes into user turns -------------------------------
//
// A `user` record is not always something the operator typed. Claude Code
// writes several kinds of its own text into user turns, each wrapped in a
// tag, and a transcript read as prose shows the tags (claude-xiy9e8wq:29).
// Measured over 3,168 non-meta user text blocks on one machine:
//
//   <task-notification>   2,100   a background task (bash, subagent) finished
//   [Request interrupted    398   the operator pressed Escape
//   <command-name>           17   a slash command, with <command-args>
//   <local-command-stdout>    9   what the slash command printed
//   <bash-input>              9   a `!` shell command …
//   <bash-stdout>             9   … and its output (with <bash-stderr>)
//
// Each gets the rendering its meaning calls for, per text block, so a block
// the operator typed beside an injected one keeps its own shape.

/** A fenced block whose fence is longer than any backtick run inside it. */
function fence(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${text.replace(/\n$/, "")}\n${f}`;
}

function tagged(text: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m ? m[1] : null;
}

/** One text block of a user turn, classified. */
type UserBlock =
  | { kind: "prose"; text: string }
  | { kind: "interrupted"; text: string }
  | { kind: "shell"; text: string }
  | { kind: "command"; text: string }
  | { kind: "notification"; taskId: string | null; toolUseId: string | null; status: string | null; summary: string | null; result: string | null }
  | { kind: "drop" };

export function classifyUserBlock(raw: string): UserBlock {
  const t = raw.trim();
  if (!t) return { kind: "drop" };
  if (/^\[Request interrupted by user[^\]]*\]$/.test(t)) {
    return { kind: "interrupted", text: `*${t}*` };
  }
  if (t.startsWith("<task-notification>")) {
    return {
      kind: "notification",
      taskId: tagged(t, "task-id"),
      toolUseId: tagged(t, "tool-use-id"),
      status: tagged(t, "status"),
      summary: tagged(t, "summary"),
      result: tagged(t, "result"),
    };
  }
  if (t.startsWith("<bash-input>")) {
    const cmd = tagged(t, "bash-input") ?? "";
    return { kind: "shell", text: fence(`$ ${cmd.trim()}`, "sh") };
  }
  if (t.startsWith("<bash-stdout>")) {
    const out = (tagged(t, "bash-stdout") ?? "").trim();
    const err = (tagged(t, "bash-stderr") ?? "").trim();
    const parts: string[] = [];
    if (out) parts.push(fence(out));
    if (err) parts.push(`stderr:\n${fence(err)}`);
    return parts.length ? { kind: "shell", text: parts.join("\n\n") } : { kind: "drop" };
  }
  if (t.startsWith("<command-name>")) {
    const name = (tagged(t, "command-name") ?? "").trim();
    const args = (tagged(t, "command-args") ?? "").trim();
    return { kind: "command", text: `\`${[name, args].filter(Boolean).join(" ")}\`` };
  }
  if (t.startsWith("<local-command-stdout>")) {
    const out = (tagged(t, "local-command-stdout") ?? "").trim();
    return out ? { kind: "command", text: fence(out) } : { kind: "drop" };
  }
  if (t.startsWith("<system-reminder>") || t.startsWith("<local-command-caveat>")) {
    return { kind: "drop" };
  }
  return { kind: "prose", text: t };
}

// ---- turns that arrive mid-turn ---------------------------------------------
//
// A message the operator sends while the agent is still working is never
// written as a `user` record. The harness queues it (`queue-operation`
// records: enqueue, then dequeue or remove), and if the running turn takes
// it in, writes it as an `attachment` of type `queued_command` at the point
// the agent read it — after the tool result it was waiting on, in the
// `parentUuid` chain — stamped with the time it was typed. Background-task
// completions arrive by the same route, `commandMode: "task-notification"`.
//
// The attachment is the delivery receipt, and it is the only thing read. A
// queued message the operator cancelled (popped back into the editor), or
// that the session ended before delivering, has queue-operation records and
// no attachment, so it stays out of the transcript as it stayed out of the
// conversation. The queue-operation records are not a usable second signal:
// older harness versions write `remove` with no reason for a delivery, and
// most task notifications carry no `origin`. Measured on one machine's
// store: 450 queued_command attachments, 103 `prompt` (the operator's) and
// 347 `task-notification`; of 113 queued messages that never went through,
// none had an attachment.

/** A `queued_command` attachment as the text blocks and images of a user
 *  turn; `null` for any other record, or a command mode this parser does not
 *  know (whose text would be guessed at). */
function queuedTurnOf(rec: ClaudeRecord): { texts: string[]; attachments: AbsorbedAttachment[] } | null {
  const a = rec.attachment;
  if (!a || a.type !== "queued_command") return null;
  if (a.commandMode !== "prompt" && a.commandMode !== "task-notification") return null;
  const p = a.prompt;
  if (typeof p === "string") return { texts: [p], attachments: [] };
  if (!Array.isArray(p)) return null;
  return {
    texts: p.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string),
    attachments: attachmentsOf(p),
  };
}

/** Parse one session's JSONL text into a conversation. `null` when it holds
 *  no message at all. */
export function parseClaudeSession(text: string, candidate: SessionCandidate): AbsorbedConversation | null {
  const messages: AbsorbedMessage[] = [];
  const toolCalls: AbsorbedToolCall[] = [];
  const callsByKey = new Map<string, AbsorbedToolCall>();
  const seqOfUuid = new Map<string, number>(); // record uuid → messages index
  const models: Record<string, number> = {};
  let title: string | null = null;
  let firstProse: string | null = null; // the fallback title: words, not a `/clear`
  let createdAt: number | null = null;
  let updatedAt: number | null = null;
  let cwd: string | undefined = candidate.cwd ?? undefined;

  for (const line of text.split("\n")) {
    if (!line) continue;
    let rec: ClaudeRecord;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a torn last line while the session is still being written
    }
    if (rec.type === "ai-title" && typeof rec.aiTitle === "string") {
      title = rec.aiTitle; // the newest wins; the harness retitles as it goes
      continue;
    }
    const queued = rec.type === "attachment" ? queuedTurnOf(rec) : null;
    if (rec.type !== "user" && rec.type !== "assistant" && !queued) continue;
    if (rec.isSidechain) continue; // a subagent's turns; not this conversation
    const time = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
    const at: number = Number.isNaN(time) ? (updatedAt ?? candidate.startedAt ?? candidate.updatedAt) : time;
    if (createdAt === null || at < createdAt) createdAt = at;
    if (updatedAt === null || at > updatedAt) updatedAt = at;
    if (cwd === undefined && typeof rec.cwd === "string") cwd = rec.cwd;

    if (queued) {
      userTurn(queued.texts, queued.attachments, rec, at);
      continue;
    }

    const content = rec.message?.content;
    const blocks = Array.isArray(content) ? content : [];

    if (rec.type === "user") {
      // Tool results come back as user records. They close a call; they are
      // never a message.
      let sawResult = false;
      for (const b of blocks) {
        if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        sawResult = true;
        const call = callsByKey.get(b.tool_use_id);
        if (!call) continue;
        call.output = b.content;
        call.status = b.is_error ? "failed" : "completed";
        if (at >= call.startedAt) call.durationMs = at - call.startedAt;
      }
      if (sawResult) continue;
      // An `isMeta` record's text is the harness's, never the operator's,
      // and stays out. An image it carries is the operator's: a paste that
      // arrives mid-turn is written as a `turnCompanion` record with `isMeta`
      // set and the image block alone, and that image is kept.
      const attachments = attachmentsOf(blocks);
      if (rec.isMeta && attachments.length === 0) continue;
      const texts = rec.isMeta ? [] : typeof content === "string" ? [content] : blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string);
      userTurn(texts, attachments, rec, at);
      continue;
    }

    // assistant
    const model = rec.message?.model;
    if (typeof model === "string") models[model] = (models[model] || 0) + 1;
    const body = textOf(content);
    if (body.trim()) {
      pushMessage({ role: "assistant", content: body, time: at, model, key: rec.uuid }, rec);
    }
    for (const b of blocks) {
      if (b.type !== "tool_use" || typeof b.id !== "string" || typeof b.name !== "string") continue;
      const call: AbsorbedToolCall = {
        key: b.id,
        name: b.name,
        input: b.input,
        status: "unknown",
        startedAt: at,
        afterMessage: messages.length - 1,
      };
      callsByKey.set(b.id, call);
      toolCalls.push(call);
    }
  }

  /** One user turn's text blocks, each classified: prose and the renderings
   *  of harness text become the message, a task notification becomes a tool
   *  row. Shared by `user` records and queued turns, which carry the same
   *  kinds of text by a different route. */
  function userTurn(texts: string[], attachments: AbsorbedAttachment[], rec: ClaudeRecord, at: number): void {
    const kept: string[] = [];
    for (const text of texts) {
      const block = classifyUserBlock(text);
      if (block.kind === "drop") continue;
      if (block.kind === "notification") {
        // A finished background task is the completion of a call the
        // agent made, not something the operator said: a tool row of its
        // own, parented to the call when the harness names it. Keyed on the
        // record uuid, since one task can notify more than once.
        const call: AbsorbedToolCall = {
          key: `task:${rec.uuid ?? `${at}:${toolCalls.length}`}`,
          name: "task-notification",
          input: { task_id: block.taskId, summary: block.summary },
          output: block.result,
          status: block.status === "failed" ? "failed" : "completed",
          startedAt: at,
          afterMessage: messages.length - 1,
          parentKey: block.toolUseId ?? undefined,
        };
        toolCalls.push(call);
        continue;
      }
      if (block.kind === "prose" && firstProse === null && !rec.isCompactSummary) firstProse = block.text;
      kept.push(block.text);
    }
    const body = kept.join("\n\n");
    if (!body.trim() && attachments.length === 0) return;
    pushMessage({
      role: rec.isCompactSummary ? "system" : "user",
      // An image with no words gets the placeholder the web app writes for
      // an image-only signal, so it renders instead of being dropped.
      content: body.trim() ? body : "(attachment)",
      time: at,
      key: rec.uuid,
      ...(attachments.length > 0 ? { attachments } : {}),
    }, rec);
  }

  function pushMessage(msg: AbsorbedMessage, rec: ClaudeRecord): void {
    const idx = messages.length;
    if (rec.parentUuid) {
      const parentIdx = seqOfUuid.get(rec.parentUuid);
      // Same rule as the ChatGPT linearizer: `re` only where the parent is not
      // simply the previous message, so a straight line stays unadorned and a
      // branch point is visible.
      if (typeof parentIdx === "number" && parentIdx !== idx - 1) {
        msg.re = [parentIdx + 1]; // seq is 1-based
      }
    }
    messages.push(msg);
    if (rec.uuid) seqOfUuid.set(rec.uuid, idx);
  }

  if (messages.length === 0) return null;

  if (!title) {
    // Something the operator wrote, in preference to a slash command or a
    // `!` command they ran first, which would title the session `/clear`.
    const first = firstProse ?? messages.find((m) => m.role === "user")?.content;
    if (first) {
      const line = first.split("\n").find((l) => l.trim()) ?? "";
      title = line.length > 80 ? line.slice(0, 77) + "…" : line;
    }
  }

  let model: string | undefined;
  let best = 0;
  for (const [m, n] of Object.entries(models)) {
    if (n > best) {
      best = n;
      model = m;
    }
  }

  return {
    externalId: candidate.externalId,
    title: title || null,
    createdAt: createdAt ?? candidate.startedAt ?? candidate.updatedAt,
    updatedAt: updatedAt ?? candidate.updatedAt,
    messages,
    model,
    toolCalls,
    cwd,
  };
}

export const claudeCodeSource: LocalSource = {
  name: "claude",
  // 1: messages sent mid-turn (`queued_command` attachments).
  parserVersion: 1,
  locate(home) {
    const root = claudeProjectsRoot(home);
    return existsSync(root) ? root : null;
  },
  identity: claudeIdentity,
  survey: surveyClaudeSessions,
  extract(candidate) {
    return parseClaudeSession(readFileSync(candidate.path, "utf-8"), candidate);
  },
};

/** A store handed in by path instead of found under HOME: either the
 *  `projects` directory itself or a copied `~/.claude` that contains one. */
export function resolveClaudeRoot(path: string): string | null {
  if (existsSync(join(path, "projects")) && basename(path) === ".claude") return join(path, "projects");
  return existsSync(path) ? path : null;
}
