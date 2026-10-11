/** Core absorb logic — provider-agnostic import into brane */

import { randomBase36 } from "../ids.js";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, extname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, Readable } from "node:stream";
import { getPayloadsDir, toPortablePath } from "../db/schema.js";
import { recordToolUse } from "../db/tool-uses.js";
import type Database from "better-sqlite3";
import parserStream from "stream-json";
import { streamArray } from "stream-json/streamers/stream-array.js";
import type {
  AbsorbProvider,
  AbsorbedConversation,
  AbsorbedMessage,
  AbsorbIdentity,
  AbsorbSummary,
} from "./types.js";
import { chatgptProvider } from "./chatgpt.js";

/** Registry of available providers (stream-JSON based) */
const providers: AbsorbProvider[] = [chatgptProvider];

/** All known provider names (includes non-streaming providers like organelle) */
const allProviderNames = ["chatgpt", "organelle", "claude"];

export function getProvider(name: string): AbsorbProvider | undefined {
  return providers.find((p) => p.name === name);
}

export function isKnownProvider(name: string): boolean {
  return allProviderNames.includes(name);
}

export function listProviders(): string[] {
  return allProviderNames;
}

/** Map message roles to brane event types */
function roleToEventType(role: string): string {
  switch (role) {
    case "user":
      return "human_signal";
    case "assistant":
    case "system":
    case "tool":
    default:
      return "narration";
  }
}

/** Build source string for user-role events */
function userSource(
  providerName: string,
  identity: AbsorbIdentity | undefined,
): string {
  if (identity) {
    return `${providerName}:${identity.label}`;
  }
  return `${providerName}:user`;
}

/** Parse user.json into an AbsorbIdentity */
function parseUserJson(text: string): AbsorbIdentity | undefined {
  try {
    const user = JSON.parse(text);
    if (typeof user.id !== "string") return undefined;
    return {
      id: user.id,
      email: typeof user.email === "string" ? user.email : undefined,
      label: typeof user.email === "string" ? user.email : user.id,
    };
  } catch {
    return undefined;
  }
}

/**
 * Extract identity from user.json in an extracted export directory.
 */
export function extractIdentityFromDirectory(
  dirPath: string,
): AbsorbIdentity | undefined {
  const userJsonPath = join(dirPath, "user.json");
  if (!existsSync(userJsonPath)) return undefined;
  return parseUserJson(readFileSync(userJsonPath, "utf-8"));
}

/**
 * Find conversation JSON files in an extracted export directory.
 * Supports both single `conversations.json` and sharded `conversations-NNN.json`.
 * Returns sorted array of absolute file paths, or undefined if none found.
 */
export function findConversationsInDirectory(
  dirPath: string,
): string[] | undefined {
  // Try single conversations.json first
  const singlePath = join(dirPath, "conversations.json");
  if (existsSync(singlePath)) return [singlePath];

  // Try sharded conversations-NNN.json
  const entries = readdirSync(dirPath);
  const shardKeys = findConversationShardKeys(entries);
  if (shardKeys.length === 0) return undefined;
  return shardKeys.map((k) => join(dirPath, k));
}

/** Sort keys matching conversations-NNN.json pattern */
function findConversationShardKeys(keys: string[]): string[] {
  const shardPattern = /(?:^|\/)(conversations-\d+\.json)$/;
  return keys
    .filter((k) => shardPattern.test(k))
    .sort((a, b) => {
      const aMatch = a.match(shardPattern)![1];
      const bMatch = b.match(shardPattern)![1];
      return aMatch.localeCompare(bMatch);
    });
}

/**
 * Describe the contents of a ChatGPT export directory for dry-run display.
 */
export function describeExportDirectory(dirPath: string): {
  conversationFiles: string[];
  hasUserJson: boolean;
  extraFiles: string[];
  mediaDirs: string[];
} {
  const entries = readdirSync(dirPath);
  const convFiles = entries.filter(
    (e) => e === "conversations.json" || /^conversations-\d+\.json$/.test(e),
  );
  const hasUserJson = entries.includes("user.json");

  const knownFiles = new Set([
    ...convFiles,
    "user.json",
    "chat.html",
    ".DS_Store",
  ]);

  const extraFiles: string[] = [];
  const mediaDirs: string[] = [];

  for (const entry of entries) {
    if (knownFiles.has(entry)) continue;
    const fullPath = join(dirPath, entry);
    try {
      if (statSync(fullPath).isDirectory()) {
        mediaDirs.push(entry);
      } else {
        extraFiles.push(entry);
      }
    } catch {
      extraFiles.push(entry);
    }
  }

  return { conversationFiles: convFiles.sort(), hasUserJson, extraFiles, mediaDirs };
}

/**
 * Build a file index for resolving asset pointers to local files.
 * Maps file ID prefixes to absolute file paths.
 *
 * Asset pointers use two schemes:
 * - file-service://file-XYZ → files named file-XYZ-* at root or in dalle-generations/
 * - sediment://file_NNNN... → files named file_NNNN...-* in user dirs or root
 */
export function buildFileIndex(dirPath: string): Map<string, string> {
  const index = new Map<string, string>();

  function walk(dir: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const fullPath = join(dir, entry);
      try {
        const st = statSync(fullPath);
        if (st.isDirectory()) {
          // Skip conversation JSON directories and other non-media dirs
          if (!/^conversations/.test(entry)) {
            walk(fullPath);
          }
        } else if (st.isFile()) {
          // Index by the file ID prefix (before the first -UUID or -filename suffix)
          // file-XYZ-UUID.jpeg → file-XYZ
          // file_NNNN...-UUID.jpeg → file_NNNN...
          const match = entry.match(/^(file[-_][A-Za-z0-9]+)/);
          if (match) {
            index.set(match[1], fullPath);
          }
        }
      } catch {
        // skip inaccessible entries
      }
    }
  }

  walk(dirPath);
  return index;
}

/**
 * Resolve an asset pointer URI to a local file path using the file index.
 * Returns undefined if the file cannot be found.
 */
function resolveAssetPointer(
  pointer: string,
  fileIndex: Map<string, string>,
): string | undefined {
  // file-service://file-XYZ → file-XYZ
  // sediment://file_NNNN... → file_NNNN...
  const match = pointer.match(/:\/\/(.+)/);
  if (!match) return undefined;
  return fileIndex.get(match[1]);
}

/** The extension a stored attachment gets, from its media type. The payload
 *  route picks its Content-Type by extension and the chat decides what to
 *  render inline the same way, so this is what makes an image show. */
function extensionFor(mediaType: string): string {
  switch (mediaType.toLowerCase()) {
    case "image/png": return ".png";
    case "image/jpeg": return ".jpg";
    case "image/gif": return ".gif";
    case "image/webp": return ".webp";
    default: return ".bin"; // only `image` blocks reach here, and the API takes only these four
  }
}

/** Resolve a message's assets and put them in payload storage: pointers
 *  through the export's file index, inline attachments decoded from base64.
 *  Both land as `<time>_<seq>_<j><ext>` under the narrative's payload dir,
 *  attachments numbered after pointers, so a message may carry either or
 *  both. On a dry run nothing is written and `payloadsDir` is never called;
 *  the summary is still counted. */
function resolveAndCopyPayloads(
  msg: AbsorbedMessage,
  narrativeId: string,
  seq: number,
  fileIndex: Map<string, string>,
  summary: AbsorbSummary,
  dryRun: boolean,
  payloadsDir: (narrativeId: string) => string,
): string[] | undefined {
  const pointers = msg.assetPointers ?? [];
  const attachments = msg.attachments ?? [];
  if (pointers.length === 0 && attachments.length === 0) return undefined;

  const payloadPaths: string[] = [];
  for (let j = 0; j < pointers.length; j++) {
    const localPath = resolveAssetPointer(pointers[j], fileIndex);
    if (!localPath) {
      summary.unresolvedAssets++;
      continue;
    }

    try {
      const size = statSync(localPath).size;
      summary.assets++;
      summary.assetsBytes += size;

      if (!dryRun) {
        const ext = extname(localPath) || ".bin";
        const storedName = `${msg.time}_${seq}_${j}${ext}`;
        copyFileSync(localPath, join(payloadsDir(narrativeId), storedName));
        payloadPaths.push(`${narrativeId}/${storedName}`);
      }
    } catch {
      summary.unresolvedAssets++;
    }
  }

  for (let k = 0; k < attachments.length; k++) {
    const bytes = Buffer.from(attachments[k].data, "base64");
    if (bytes.length === 0) {
      summary.unresolvedAssets++;
      continue;
    }

    if (!dryRun) {
      const storedName = `${msg.time}_${seq}_${pointers.length + k}${extensionFor(attachments[k].mediaType)}`;
      try {
        writeFileSync(join(payloadsDir(narrativeId), storedName), bytes);
      } catch {
        // A full disk or an unwritable payload dir costs this one image, as
        // an unreadable file does on the pointer path; the message still
        // lands, and the import goes on to the next session.
        summary.unresolvedAssets++;
        continue;
      }
      payloadPaths.push(`${narrativeId}/${storedName}`);
    }
    summary.assets++;
    summary.assetsBytes += bytes.length;
  }

  return payloadPaths.length > 0 ? payloadPaths : undefined;
}

/** Where one conversation message will land (or has landed): a narrative and
 *  a seq within it. */
interface Landing {
  narrativeId: string;
  seq: number;
}

/** Everything the per-conversation write needs, prepared once per run. */
export interface AbsorbContext {
  db: Database.Database;
  providerName: string;
  braneId: string;
  foldPath: string;
  identity: AbsorbIdentity | undefined;
  fileIndex: Map<string, string>;
  summary: AbsorbSummary;
  dryRun: boolean;
  /** The one write path, wrapped in a transaction; absent on a dry run. */
  write: ((conv: AbsorbedConversation) => AbsorbOutcome) | undefined;
  plan: (conv: AbsorbedConversation) => AbsorbPlan;
  /** Where a narrative's payload files go. `getPayloadsDir` (under
   *  `~/.brane`) in every real run; a temp dir under test. */
  payloadsDir: (narrativeId: string) => string;
}

export type AbsorbOutcome = "inserted" | "appended" | "skipped";

/** What a conversation would do to the database, decided before (and
 *  without) writing. The real write follows the plan exactly; the dry run
 *  reports it. */
export interface AbsorbPlan {
  outcome: AbsorbOutcome;
  /** The narrative the messages go to: an existing absorbed one, or a fresh
   *  id minted for this conversation. */
  narrativeId: string;
  /** Indices into `conv.messages` that will be written, in order. */
  newMessages: number[];
  /** Where every message lands, by index — including ones already held, in
   *  this narrative or another. `re` values are resolved through this. */
  landing: Map<number, Landing>;
  /** When the conversation opens by repeating messages another narrative
   *  already holds (a forked Claude session), the last such message: the
   *  first new message is written `re` it, so the two read as one thread. */
  continuedFrom: Landing | null;
  /** New messages that belong *before* something this narrative already
   *  holds — records an earlier parser skipped, read now — each mapped to
   *  the held message it follows in the conversation. Events are
   *  append-only, so such a message lands at the tail; it is written `re`
   *  that message, so it reads as late but links to where it belongs, and
   *  no seq anyone has cited moves. */
  lateFor: Map<number, Landing>;
  /** Tool calls that will be written, by index into `conv.toolCalls`. */
  newToolCalls: number[];
}

/** Prepare a run: statements, summary, and the plan/write pair. */
export function createAbsorbContext(
  db: Database.Database,
  providerName: string,
  braneId: string,
  foldPath: string,
  identity: AbsorbIdentity | undefined,
  dryRun: boolean,
  fileIndex?: Map<string, string>,
  opts: { payloadsDir?: (narrativeId: string) => string } = {},
): AbsorbContext {
  const payloadsDir = opts.payloadsDir ?? getPayloadsDir;
  const summary: AbsorbSummary = {
    provider: providerName,
    conversations: 0,
    messages: 0,
    oldest: null,
    newest: null,
    models: {},
    skipped: 0,
    appended: 0,
    assets: 0,
    assetsBytes: 0,
    unresolvedAssets: 0,
  };
  const assetIndex = fileIndex ?? new Map<string, string>();

  const insertNarrative = db.prepare(
    `INSERT INTO narratives (id, brane_id, fold_path, agent_type, role, created_at, status, title, archived, agent_session_id)
     VALUES (?, ?, ?, ?, 'absorbed', ?, 'ended', ?, 1, ?)`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO events (narrative_id, seq, time, type, content, content_type, source, re, payloads, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Only absorbed narratives in *this* brane are candidates for append. A
  // live narrative with the same session id is brane's own record of that
  // session and is never written to by an import (the local runner skips
  // those as "managed" before the parse; this is the belt to that
  // suspender). An absorbed one in another brane is another destination's
  // copy, and this destination gets its own.
  const checkExisting = db.prepare(
    `SELECT id FROM narratives
      WHERE agent_session_id = ? AND agent_type = ? AND role = 'absorbed' AND brane_id = ?`,
  );
  const getMaxSeq = db.prepare("SELECT MAX(seq) as max_seq FROM events WHERE narrative_id = ?");
  const getExistingEventCount = db.prepare("SELECT COUNT(*) as cnt FROM events WHERE narrative_id = ?");
  const findMessage = db.prepare(
    "SELECT narrative_id, seq FROM absorb_messages WHERE brane_id = ? AND provider = ? AND key = ?",
  );
  const recordMessage = db.prepare(
    "INSERT OR IGNORE INTO absorb_messages (brane_id, provider, key, narrative_id, seq) VALUES (?, ?, ?, ?, ?)",
  );
  const hasToolUse = db.prepare("SELECT 1 FROM tool_uses WHERE narrative_id = ? AND dedup_key = ?");
  const refreshTitle = db.prepare("UPDATE narratives SET title = ? WHERE id = ? AND (title IS NULL OR title != ?)");

  const source = userSource(providerName, identity);

  function plan(conv: AbsorbedConversation): AbsorbPlan {
    const existing = checkExisting.get(conv.externalId, providerName, braneId) as { id: string } | undefined;
    const landing = new Map<number, Landing>();
    const newMessages: number[] = [];
    let continuedFrom: Landing | null = null;
    const keyed = conv.messages.length > 0 && conv.messages.every((m) => typeof m.key === "string");

    let narrativeId: string;
    let nextSeq: number;
    if (existing) {
      narrativeId = existing.id;
      const { max_seq } = getMaxSeq.get(existing.id) as { max_seq: number | null };
      nextSeq = (max_seq ?? 0) + 1;
    } else {
      narrativeId = `${providerName}-${randomBase36(8)}`;
      nextSeq = 1;
    }

    if (keyed) {
      // Per-message: a key already held anywhere is not written again. Held
      // in *this* narrative means the file grew; held in another means this
      // file repeats that one's history (a fork), and the thread continues
      // from wherever the repeated run ends.
      let inPrefix = !existing;
      for (let i = 0; i < conv.messages.length; i++) {
        const held = findMessage.get(braneId, providerName, conv.messages[i].key) as
          | { narrative_id: string; seq: number }
          | undefined;
        if (held) {
          landing.set(i, { narrativeId: held.narrative_id, seq: held.seq });
          if (inPrefix && held.narrative_id !== narrativeId) {
            continuedFrom = { narrativeId: held.narrative_id, seq: held.seq };
          }
          continue;
        }
        inPrefix = false;
        landing.set(i, { narrativeId, seq: nextSeq++ });
        newMessages.push(i);
      }
    } else {
      // Unkeyed (ChatGPT): the count-based append this path has always done.
      const cnt = existing ? (getExistingEventCount.get(existing.id) as { cnt: number }).cnt : 0;
      for (let i = 0; i < conv.messages.length; i++) {
        if (i < cnt) {
          landing.set(i, { narrativeId, seq: i + 1 });
        } else {
          landing.set(i, { narrativeId, seq: nextSeq++ });
          newMessages.push(i);
        }
      }
    }

    const lateFor = new Map<number, Landing>();
    if (existing && keyed) {
      const fresh = new Set(newMessages);
      let lastHeld = -1; // the last message this narrative already holds
      for (let i = 0; i < conv.messages.length; i++) {
        if (!fresh.has(i) && landing.get(i)!.narrativeId === narrativeId) lastHeld = i;
      }
      // The nearest held message before i. A fresh message ahead of every
      // held one (a record type read at the very head of a session) gets no
      // anchor: `re` points back, and there is nothing behind it to point
      // at. No record type this parser reads can arrive there — a queued
      // message follows at least the prompt that started the turn.
      let anchor: Landing | null = null;
      for (let i = 0; i < lastHeld; i++) {
        if (!fresh.has(i)) anchor = landing.get(i)!;
        else if (anchor) lateFor.set(i, anchor);
      }
    }

    const newToolCalls: number[] = [];
    for (let i = 0; i < (conv.toolCalls?.length ?? 0); i++) {
      const call = conv.toolCalls![i];
      // A call anchored to a message that lives in another narrative was
      // recorded there when that narrative was absorbed.
      const anchor = call.afterMessage >= 0 ? landing.get(call.afterMessage) : undefined;
      if (anchor && anchor.narrativeId !== narrativeId) continue;
      if (existing && hasToolUse.get(narrativeId, call.key)) continue;
      newToolCalls.push(i);
    }

    let outcome: AbsorbOutcome;
    if (newMessages.length === 0 && newToolCalls.length === 0) outcome = "skipped";
    else if (existing) outcome = "appended";
    else if (newMessages.length === 0) outcome = "skipped"; // calls alone don't make a narrative
    else outcome = "inserted";
    if (outcome === "skipped") newToolCalls.length = 0;

    return { outcome, narrativeId, newMessages, landing, continuedFrom, lateFor, newToolCalls };
  }

  /** A message's `re` — conversation-local 1-based indices from the parser
   *  — resolved through where those messages actually landed. */
  function resolveRe(
    re: Array<number | string> | undefined,
    landing: Map<number, Landing>,
    narrativeId: string,
  ): Array<number | string> | undefined {
    if (!re || re.length === 0) return undefined;
    const out: Array<number | string> = [];
    for (const r of re) {
      if (typeof r !== "number") {
        out.push(r);
        continue;
      }
      const l = landing.get(r - 1);
      if (!l) continue;
      out.push(l.narrativeId === narrativeId ? l.seq : `${l.narrativeId}:${l.seq}`);
    }
    return out.length > 0 ? out : undefined;
  }

  const write = dryRun
    ? undefined
    : db.transaction((conv: AbsorbedConversation): AbsorbOutcome => {
        const p = plan(conv);
        if (p.outcome === "skipped") return p.outcome;
        const { narrativeId } = p;

        if (p.outcome === "inserted") {
          const fold = conv.cwd ? toPortablePath(conv.cwd) : foldPath;
          insertNarrative.run(
            narrativeId, braneId, fold, providerName, conv.createdAt, conv.title, conv.externalId,
          );
        } else if (conv.title) {
          // A harness retitles a session as it goes (Claude Code's
          // `ai-title`), so the title read from a grown file is the better
          // one. Also what gives a rebuilt narrative its title back.
          refreshTitle.run(conv.title, narrativeId, conv.title);
        }

        let first = true;
        for (const i of p.newMessages) {
          const msg = conv.messages[i];
          const { seq } = p.landing.get(i)!;
          const type = roleToEventType(msg.role);
          const msgSource = msg.role === "user" ? source : providerName;
          const payloads = resolveAndCopyPayloads(msg, narrativeId, seq, assetIndex, summary, false, payloadsDir);
          let re = resolveRe(msg.re, p.landing, narrativeId);
          if (first && p.continuedFrom) {
            const link = `${p.continuedFrom.narrativeId}:${p.continuedFrom.seq}`;
            re = re && !re.includes(link) ? [link, ...re] : [link];
          }
          first = false;
          const late = p.lateFor.get(i);
          if (late) {
            const link = late.narrativeId === narrativeId ? late.seq : `${late.narrativeId}:${late.seq}`;
            re = re && !re.includes(link) ? [link, ...re] : [link];
          }
          insertEvent.run(
            narrativeId, seq, msg.time, type, msg.content, null, msgSource,
            re ? JSON.stringify(re) : null,
            payloads ? JSON.stringify(payloads) : null,
            msg.model ? JSON.stringify({ model: msg.model }) : null,
          );
          if (msg.key) recordMessage.run(braneId, providerName, msg.key, narrativeId, seq);
        }

        for (const i of p.newToolCalls) {
          const call = conv.toolCalls![i];
          const anchor = call.afterMessage >= 0 ? p.landing.get(call.afterMessage) : undefined;
          recordToolUse(db, narrativeId, {
            dedupKey: call.key,
            name: call.name,
            input: call.input,
            output: call.output,
            status: call.status,
            startedAt: call.startedAt,
            durationMs: call.durationMs,
            afterSeq: anchor?.seq ?? 0,
            source: "absorb",
            agentType: providerName,
            parentId: call.parentKey,
          });
        }
        return p.outcome;
      });

  return {
    db, providerName, braneId, foldPath, identity, fileIndex: assetIndex, summary, dryRun, write, plan, payloadsDir,
  };
}

/** Absorb one parsed conversation: write it (or, on a dry run, plan it) and
 *  fold the result into the context's summary. */
export function absorbOne(ctx: AbsorbContext, conv: AbsorbedConversation): AbsorbOutcome {
  const { summary } = ctx;
  if (conv.model) summary.models[conv.model] = (summary.models[conv.model] || 0) + 1;
  if (!summary.oldest || conv.createdAt < summary.oldest.time) {
    summary.oldest = { time: conv.createdAt, title: conv.title };
  }
  if (!summary.newest || conv.updatedAt > summary.newest.time) {
    summary.newest = { time: conv.updatedAt, title: conv.title };
  }

  const p = ctx.plan(conv);
  const outcome = ctx.write ? ctx.write(conv) : p.outcome;
  summary.messages += p.newMessages.length;
  if (p.newToolCalls.length > 0) summary.toolCalls = (summary.toolCalls ?? 0) + p.newToolCalls.length;
  if (outcome === "inserted") summary.conversations++;
  else if (outcome === "appended") summary.appended++;
  else summary.skipped++;

  if (ctx.dryRun) {
    // Resolve assets on a dry run too, for the report.
    for (const i of p.newMessages) {
      const msg = conv.messages[i];
      if (msg.assetPointers || msg.attachments) resolveAndCopyPayloads(msg, "dry-run", 0, ctx.fileIndex, summary, true, ctx.payloadsDir);
    }
  }
  return outcome;
}

/**
 * Stream-absorb conversations from one or more readable sources.
 *
 * Uses stream-json to parse each top-level JSON array one element at a time,
 * keeping memory usage proportional to the largest single conversation
 * rather than the total file size.
 *
 * When `dryRun` is true, conversations are parsed and summarized but not
 * written to the database.
 */
export async function absorb(
  db: Database.Database,
  sources: Array<Readable | string> | Readable | string,
  provider: AbsorbProvider,
  braneId: string,
  foldPath: string,
  identity?: AbsorbIdentity,
  onProgress?: (done: number, title: string | null) => void,
  dryRun?: boolean,
  fileIndex?: Map<string, string>,
): Promise<AbsorbSummary> {
  const ctx = createAbsorbContext(db, provider.name, braneId, foldPath, identity, dryRun === true, fileIndex);
  let processed = 0;
  const sourceList = Array.isArray(sources) ? sources : [sources];

  for (const source of sourceList) {
    // Create a transform that processes each array element
    const processor = new Transform({
      objectMode: true,
      transform(chunk: { key: number; value: unknown }, _encoding, callback) {
        try {
          const conv = provider.parseOne(chunk.value);
          if (conv) {
            absorbOne(ctx, conv);
            processed++;
            onProgress?.(processed, conv.title);
          }
          callback();
        } catch (err) {
          callback(err as Error);
        }
      },
    });

    const inputStream = typeof source === "string" ? createReadStream(source) : source;
    await pipeline(inputStream, parserStream(), streamArray.asStream(), processor);
  }

  return ctx.summary;
}
