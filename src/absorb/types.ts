/** Shared types for the absorb (import) system */

/** A binary asset a message carries inline rather than by pointer: a
 *  pasted image in Claude Code's JSONL is base64 in the record itself. */
export interface AbsorbedAttachment {
  mediaType: string; // e.g. "image/png"; picks the stored file's extension
  data: string; // base64
}

/** A single message extracted from a provider's export */
export interface AbsorbedMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  time: number; // Unix epoch ms
  model?: string; // e.g. "gpt-4o"
  re?: Array<number | string>;
  /** Raw asset pointer URIs (e.g. "file-service://file-XYZ") to resolve to local files */
  assetPointers?: string[];
  /** Assets carried inline. Written to payload storage beside the message
   *  exactly as resolved pointers are, numbered after them. */
  attachments?: AbsorbedAttachment[];
  /** A stable, provider-issued id for this message (Claude Code's record
   *  `uuid`, a ChatGPT node id). Two readings of the same message — from a
   *  grown file, or from a successor session that copied its predecessor's
   *  history — carry the same key, which is what lets the inserter recognise
   *  a message it already holds. Optional: a source without stable ids falls
   *  back to the count-based append the ChatGPT path has always used. */
  key?: string;
}

/** A tool call an agent made mid-conversation, kept beside the messages
 *  rather than flattened into them (operator ruling, claude-xlolbv6l:65).
 *  Lands in `tool_uses` with `source: "absorb"`. */
export interface AbsorbedToolCall {
  /** Provider-issued call id (`toolu_…`) — the `tool_uses.dedup_key`, so a
   *  re-read of the same file is a no-op on the row. */
  key: string;
  name: string;
  input: unknown;
  output?: unknown;
  status: "completed" | "failed" | "unknown";
  startedAt: number; // Unix epoch ms
  durationMs?: number;
  /** Index into `messages` of the message the call followed; -1 when it
   *  preceded every message. Anchors the row's `after_seq`. */
  afterMessage: number;
  parentKey?: string;
}

/** A single conversation extracted from a provider's export */
export interface AbsorbedConversation {
  /** Provider's original conversation ID */
  externalId: string;
  title: string | null;
  createdAt: number; // Unix epoch ms
  updatedAt: number; // Unix epoch ms
  messages: AbsorbedMessage[];
  model?: string; // most-used model in the conversation
  toolCalls?: AbsorbedToolCall[];
  /** The directory the conversation ran in, for sources that know it (a local
   *  agent's session store). Becomes the narrative's `fold_path` verbatim —
   *  it is never registered as a fold, see `runLocalAbsorb`. */
  cwd?: string;
}

/** Summary returned by dry-run or after import */
export interface AbsorbSummary {
  provider: string;
  conversations: number;
  messages: number;
  oldest: { time: number; title: string | null } | null;
  newest: { time: number; title: string | null } | null;
  models: Record<string, number>; // model_slug → count
  skipped: number; // conversations skipped (already imported or empty)
  appended: number; // conversations with new messages appended
  assets: number; // asset pointers resolved to local files
  assetsBytes: number; // total size of resolved assets
  unresolvedAssets: number; // asset pointers with no matching local file
  /** Tool calls written (or, on a dry run, that would be) to `tool_uses`. */
  toolCalls?: number;
  /** Sessions a live brane narrative already owns — left alone, never
   *  imported twice under a second id. Local sources only. */
  managed?: number;
  /** Session files unchanged since they were last absorbed, skipped on a
   *  stat alone without being read. Local sources only. */
  unchanged?: number;
  /** Narratives whose events were dropped and re-derived from their source
   *  file (`--rebuild`). Local sources only. */
  rebuilt?: number;
  /** Narratives `--rebuild` selected and would not rebuild, because they hold
   *  events no import wrote — an operator's signal, a foreign narration —
   *  that a re-derivation from the file could not bring back. They are read
   *  as an ordinary re-run instead. Local sources only. */
  locked?: number;
}

/** Identity extracted from provider export (e.g. user.json in ChatGPT ZIP) */
export interface AbsorbIdentity {
  id: string; // provider user ID
  email?: string;
  label: string; // human-readable label for source field
}

/** Provider parser interface — implement for each vendor */
export interface AbsorbProvider {
  name: string;
  /** Parse a single conversation object from the export array.
   *  Returns null if the object should be skipped (empty, malformed, etc.) */
  parseOne(raw: unknown): AbsorbedConversation | null;
}

/** One session as a local source's survey sees it, before anything is
 *  parsed: enough to list, filter, and decide whether to read it at all.
 *  Cheap by contract — a stat and at most the file's first few KB. */
export interface SessionCandidate {
  externalId: string;
  path: string;
  cwd: string | null;
  startedAt: number | null;
  updatedAt: number; // mtime
  bytes: number;
}

/** A session store on this machine that brane can read — the local-source
 *  half of absorb, next to the export-directory providers above. The survey
 *  (`brane absorb` with no arguments) calls `locate` and `survey` on every
 *  registered source and reads no message content doing it; only an import
 *  calls `extract`. */
export interface LocalSource {
  /** The provider name, and the `agent_type` its narratives carry. */
  name: string;
  /** Default store location under `home`; `null` when the store is absent. */
  locate(home: string): string | null;
  /** Account identity for the brane id and event `source` labels. */
  identity(home: string): AbsorbIdentity;
  /** Every session in the store, unparsed. */
  survey(root: string): SessionCandidate[];
  /** The full parse of one session. `null` when the file holds no
   *  conversation (an aborted launch, a file of nothing but bookkeeping). */
  extract(candidate: SessionCandidate): AbsorbedConversation | null;
  /** Which generation of `extract` this is. Recorded beside each file's
   *  (size, mtime) when it is absorbed; a file last read by an older
   *  generation is not "unchanged", so the next ordinary run reads it again
   *  and appends whatever the newer parser finds. Bump it when the parser
   *  learns to read something it used to skip. */
  parserVersion: number;
}
