/**
 * The absorb pipeline as the daemon runs it.
 *
 * `brane absorb` used to do all of this in the CLI process: parse the export,
 * write narratives and events, copy assets into `~/.brane/payloads/`. Every
 * one of those paths — the payload store, `~/.organelle/index/search.db`, the
 * niche registry — resolves against HOME, and the daemon is the process whose
 * HOME the rest of brane already agrees on (see the cost backfill). So the
 * orchestration lives here and `POST /api/absorb` calls it; the CLI is a
 * client that prints what this emits.
 *
 * Progress is reported through `emit`, which the route streams as NDJSON and
 * the CLI prints as it always did. Everything that can be rejected up front
 * (unknown provider, missing directory, no identity) throws an
 * `AbsorbInputError` *before* the first emit, so the route can still answer
 * with a plain 400 rather than a 200 that goes wrong halfway.
 */

import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { getBraneId, toPortablePath, fromPortablePath } from "../db/schema.js";
import { registerFold, foldPathRefusal } from "../folds.js";
import type { AbsorbIdentity, AbsorbSummary, LocalSource, SessionCandidate } from "./types.js";
import { getLocalSource, classifySessions } from "./sources.js";
import { deriveBraneId } from "./brane-id.js";
import { resolveClaudeRoot, claudeProjectsRoot } from "./claude-code.js";
import {
  getProvider,
  isKnownProvider,
  listProviders,
  absorb,
  createAbsorbContext,
  absorbOne,
  extractIdentityFromDirectory,
  findConversationsInDirectory,
  describeExportDirectory,
  buildFileIndex,
} from "./index.js";
import {
  absorbOrganelle,
  describeOrganelleNiche,
  findSearchDb,
  readNichesRegistry,
  type NicheToAbsorb,
} from "./organelle.js";

/** The request body of `POST /api/absorb`, and the CLI's flags. Paths are
 *  taken as given: the CLI resolves relative ones against *its* cwd before
 *  sending, since the daemon's cwd means nothing to the operator. */
export interface AbsorbRequest {
  provider: string;
  /** Export directory (chatgpt) or niche directory / registry (organelle).
   *  Provider-specific default when omitted (organelle: `~/.organelle`). */
  path?: string;
  /** Target fold, absolute or `~/portable`. Required for chatgpt; organelle
   *  defaults to the niche path itself. */
  fold?: string;
  identity?: string;
  /** Target brane id, `"self"` for the home brane; default derived from
   *  provider + identity so a re-import lands in the same brane. */
  brane?: string;
  dry_run?: boolean;
  /** Local sources only: keep sessions active in the last `30m`/`12h`/`7d`/
   *  `2w`, or since an ISO date. */
  since?: string;
  /** Local sources only: one session, by id or unambiguous id prefix. */
  session?: string;
  /** Local sources only: for sessions this brane has already absorbed, drop
   *  the narrative's events, tool rows, ledger rows and memory-index rows
   *  and import the file again — same narrative id, seqs from 1. See
   *  `resetAbsorbedNarrative`. */
  rebuild?: boolean;
}

/** One line of the NDJSON stream. `info` lines are the pre-flight report
 *  (directory contents, identity, brane, fold); `progress` is one per
 *  conversation, throttled by the route; `summary` is the last line of a
 *  successful run. A run that fails after it has started ends with `error`
 *  instead — emitted by the route, not here. */
export type AbsorbEvent =
  | { type: "info"; message: string }
  | { type: "progress"; done: number; title: string | null }
  | {
      type: "summary";
      dry_run: boolean;
      provider: string;
      brane_id: string;
      fold_paths: string[];
      summary: AbsorbSummary;
    };

/** A request the daemon can reject before doing any work — maps to 400. */
export class AbsorbInputError extends Error {
  readonly status = 400;
}

const DEFAULT_PATHS: Record<string, () => string> = {
  organelle: () => join(process.env.HOME!, ".organelle"),
  claude: () => claudeProjectsRoot(process.env.HOME!),
};

/** Resolve a fold the way every fold path is stored: `~/…` stays portable,
 *  anything else becomes portable from its absolute form. */
function portableFold(raw: string): string {
  return raw.startsWith("~") ? raw : toPortablePath(resolve(raw));
}

/** Refuse a fold the daemon would refuse to register — *before* the stream
 *  opens, so the operator gets a 400/403 rather than a full pre-flight report
 *  followed by an error line, and so a dry run catches what the real run
 *  would. `registerFold` re-checks on write; this is the early copy. */
function assertFoldsRegistrable(foldPaths: string[], opts: RunAbsorbOptions): void {
  for (const fp of foldPaths) {
    const refusal = foldPathRefusal(resolve(fromPortablePath(fp)), {
      confineToHome: opts.confineFoldsToHome,
    });
    if (refusal) throw refusal;
  }
}

export { deriveBraneId } from "./brane-id.js";

/** Validate the request and resolve the input directory. Throws
 *  `AbsorbInputError` for anything the operator has to fix. */
export function resolveAbsorbInput(req: AbsorbRequest): { provider: string; inputPath: string } {
  const provider = req.provider;
  if (!provider || !isKnownProvider(provider)) {
    throw new AbsorbInputError(
      `Unknown provider: ${provider}. Available: ${listProviders().join(", ")}`,
    );
  }
  const rawPath = req.path ?? DEFAULT_PATHS[provider]?.();
  if (!rawPath) {
    throw new AbsorbInputError(
      `Path is required for provider "${provider}".\nUsage: brane absorb ${provider} <path>`,
    );
  }
  const inputPath = resolve(rawPath.startsWith("~/") ? join(process.env.HOME!, rawPath.slice(2)) : rawPath);
  const stat = statSync(inputPath, { throwIfNoEntry: false });
  if (!stat) {
    throw new AbsorbInputError(
      getLocalSource(provider) && !req.path
        ? `No ${provider} session store at ${inputPath} — nothing to absorb on this machine.`
        : `Not found: ${inputPath}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new AbsorbInputError(
      `Expected a directory, got a file: ${inputPath}\n` +
        `If this is a ZIP, extract it first, then pass the directory.`,
    );
  }
  return { provider, inputPath };
}

export interface RunAbsorbOptions {
  /** Whether fold registration is confined to the operator's home directory
   *  (true for remote clients, false for a loopback caller — see
   *  `registerFold`). */
  confineFoldsToHome: boolean;
}

/** Run one absorb end to end. Rejects with `AbsorbInputError` before the first
 *  `emit` for input problems; anything thrown after that is a run failure. */
export async function runAbsorb(
  db: Database.Database,
  req: AbsorbRequest,
  emit: (event: AbsorbEvent) => void,
  opts: RunAbsorbOptions,
): Promise<AbsorbSummary> {
  const { provider, inputPath } = resolveAbsorbInput(req);
  const dryRun = req.dry_run === true;
  const local = getLocalSource(provider);
  if (local) return runLocalAbsorb(db, local, inputPath, req, dryRun, emit, opts);
  if (req.rebuild) {
    // Refused rather than ignored: a flag that does nothing teaches the
    // operator it did something. Export providers can grow it — the export
    // directory is on disk like a session file — but not silently.
    throw new AbsorbInputError(`--rebuild is not supported for the ${provider} provider yet.`);
  }
  return provider === "organelle"
    ? runOrganelleAbsorb(db, inputPath, req, dryRun, emit, opts)
    : runStreamAbsorb(db, provider, inputPath, req, dryRun, emit, opts);
}

/** `30m`, `12h`, `7d`, `2w`, or an ISO date → epoch ms cutoff. */
export function parseSince(spec: string, now = Date.now()): number {
  const m = /^(\d+)([mhdw])$/.exec(spec.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[m[2] as "m" | "h" | "d" | "w"];
    return now - n * unit;
  }
  const t = Date.parse(spec);
  if (Number.isNaN(t)) {
    throw new AbsorbInputError(`Cannot read --since "${spec}": use 30m, 12h, 7d, 2w, or an ISO date.`);
  }
  return t;
}

/** Narrow a store's sessions to what the operator asked for. Pure, so the
 *  three flags can be pinned without a store. */
export function selectSessions(
  candidates: SessionCandidate[],
  req: { fold?: string; since?: string; session?: string },
  now = Date.now(),
): SessionCandidate[] {
  let out = candidates;
  if (req.fold) {
    const want = resolve(req.fold.startsWith("~/") ? join(process.env.HOME!, req.fold.slice(2)) : req.fold);
    out = out.filter((c) => c.cwd !== null && resolve(c.cwd) === want);
  }
  if (req.since) {
    const cutoff = parseSince(req.since, now);
    out = out.filter((c) => c.updatedAt >= cutoff);
  }
  if (req.session) {
    const want = req.session;
    const exact = out.filter((c) => c.externalId === want);
    if (exact.length > 0) return exact;
    const prefixed = out.filter((c) => c.externalId.startsWith(want));
    if (prefixed.length > 1) {
      throw new AbsorbInputError(
        `--session ${want} matches ${prefixed.length} sessions; give more of the id.`,
      );
    }
    out = prefixed;
  }
  return out;
}

/** Events in an absorbed narrative that no import wrote: an operator's
 *  signal sent into it from the app, a foreign narration, anything else
 *  appended live. Every event an import writes is keyed in `absorb_messages`
 *  by the seq it landed at, so an event with no row there came from
 *  somewhere else — and is in no file a rebuild could re-derive it from. */
export function liveContributions(
  db: Database.Database,
  narrativeId: string,
  braneId: string,
  provider: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
        WHERE narrative_id = ?
          AND seq NOT IN (SELECT seq FROM absorb_messages WHERE brane_id = ? AND provider = ? AND narrative_id = ?)`,
    )
    .get(narrativeId, braneId, provider, narrativeId) as { n: number };
  return row.n;
}

/** The one deleting operation in absorb, behind `--rebuild`: empty an
 *  absorbed narrative so the file it came from can be imported again.
 *
 *  Why this is allowed under the golden rule: the flag is the operator's
 *  explicit instruction, and what is discarded is a *rendering* of a file
 *  that is still on disk — the caller only reaches here for a candidate the
 *  survey just found. That holds only while the narrative is nothing but
 *  that rendering. An absorbed narrative still takes live writes — the
 *  operator can signal into it from the app, an agent can narrate into it —
 *  and those are in no file, so a narrative holding any is refused
 *  (`liveContributions`): locked in, appended to but never re-derived. The
 *  narrative row itself is kept (id, brane,
 *  created_at), so a citation of the narrative from anywhere else still
 *  resolves; its seqs restart at 1, since the old ones were the rendering
 *  being replaced. The WHERE clauses are the guard: only an absorbed
 *  narrative, only in this brane, only the one bound to this session.
 *
 *  Memory-index rows for the narrative go too, and its cursor, so the next
 *  indexing pass re-embeds the rebuilt events instead of believing it has
 *  already seen them. `memory_content_df` is left alone — it is a
 *  frequency heuristic that a full `brane memory index --rebuild` recomputes
 *  and that a stale count does not make wrong, only slightly off. */
export function resetAbsorbedNarrative(
  db: Database.Database,
  narrativeId: string,
  braneId: string,
  provider: string,
  externalId: string,
): void {
  db.transaction(() => {
    const owned = db
      .prepare(
        `SELECT 1 FROM narratives
          WHERE id = ? AND brane_id = ? AND role = 'absorbed'
            AND agent_type = ? AND agent_session_id = ?`,
      )
      .get(narrativeId, braneId, provider, externalId);
    if (!owned) throw new Error(`refusing to rebuild ${narrativeId}: not an absorbed ${provider} narrative of ${braneId}`);
    const live = liveContributions(db, narrativeId, braneId, provider);
    if (live > 0) throw new Error(`refusing to rebuild ${narrativeId}: ${live} event(s) were not written by an import`);
    db.prepare("DELETE FROM events WHERE narrative_id = ?").run(narrativeId);
    db.prepare("DELETE FROM tool_uses WHERE narrative_id = ?").run(narrativeId);
    db.prepare("DELETE FROM absorb_messages WHERE brane_id = ? AND provider = ? AND narrative_id = ?").run(braneId, provider, narrativeId);
    db.prepare("DELETE FROM absorb_files WHERE brane_id = ? AND provider = ? AND external_id = ?").run(braneId, provider, externalId);
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name),
    );
    if (tables.has("memory_chunks")) {
      // memory_fts follows memory_chunks by trigger; memory_vec has no
      // trigger and is keyed by chunk id.
      if (tables.has("memory_vec")) {
        db.prepare(
          "DELETE FROM memory_vec WHERE chunk_id IN (SELECT id FROM memory_chunks WHERE narrative_id = ?)",
        ).run(narrativeId);
      }
      db.prepare("DELETE FROM memory_chunks WHERE narrative_id = ?").run(narrativeId);
    }
    if (tables.has("memory_cursors")) {
      db.prepare("DELETE FROM memory_cursors WHERE narrative_id = ?").run(narrativeId);
    }
  })();
}

/** Local-source absorb: a session store on this machine, read in place.
 *
 *  Differs from the export path in three deliberate ways. **No fold is
 *  registered.** Each session knows the directory it ran in, and that
 *  becomes the narrative's `fold_path`; but registering every such directory
 *  as a spawn point would bind existing folds (the operator's own `~/dev/x`)
 *  to the foreign brane, which would change what `brane spawn` does there.
 *  `--fold` is therefore a filter here — "sessions from this directory" —
 *  not a destination. **`--brane` is a destination, and destinations are
 *  independent**: the ledgers below are keyed by brane, so the same store
 *  imported into two branes is two complete copies (claude-xiy9e8wq:38).
 *  **Sessions brane already owns are skipped**, by
 *  `narratives.session_ids`, and counted as `managed` (claude-xiy9e8wq:13).
 *  **Unchanged files are not read**: `absorb_files` remembers each file's
 *  (size, mtime) at its last absorb, so a re-run over a store of hundreds of
 *  sessions costs a stat per file plus the parse of whatever grew. */
async function runLocalAbsorb(
  db: Database.Database,
  source: LocalSource,
  inputPath: string,
  req: AbsorbRequest,
  dryRun: boolean,
  emit: (event: AbsorbEvent) => void,
  _opts: RunAbsorbOptions,
): Promise<AbsorbSummary> {
  const root = source.name === "claude" ? resolveClaudeRoot(inputPath) : inputPath;
  if (!root) throw new AbsorbInputError(`Not a ${source.name} session store: ${inputPath}`);

  const home = process.env.HOME!;
  const identity: AbsorbIdentity = req.identity
    ? { id: req.identity, label: req.identity }
    : source.identity(home);
  const homeBraneId = getBraneId(db);
  const braneId =
    req.brane === "self" ? homeBraneId : (req.brane ?? deriveBraneId(source.name, identity.id));

  // Everything above and the survey below is validation-grade: nothing is
  // parsed, nothing is written. Input errors still surface before any emit.
  const all = source.survey(root);
  const selected = selectSessions(all, req);
  const status = classifySessions(db, source, selected, braneId);

  const toRead: SessionCandidate[] = [];
  const toRebuild = new Map<string, string>(); // externalId → narrative id
  let managed = 0;
  let unchanged = 0;
  let locked = 0;
  let reparse = 0;
  for (const c of selected) {
    const st = status.get(c.externalId)!;
    if (st.managedBy) {
      managed++;
      continue;
    }
    if (req.rebuild && st.absorbedBy) {
      if (liveContributions(db, st.absorbedBy, braneId, source.name) > 0) {
        // Written into since it was absorbed: a rebuild would delete what
        // was written. Read like any other re-run, which only appends — and
        // counted once, as locked, whether or not the file has grown.
        locked++;
        if (st.unchanged) continue;
        if (st.reparse) reparse++;
        toRead.push(c);
        continue;
      } else {
        // A rebuild re-reads regardless of the stat; the candidate is here,
        // so its file is on disk, which is the one precondition.
        toRebuild.set(c.externalId, st.absorbedBy);
        toRead.push(c);
        continue;
      }
    }
    if (st.unchanged) {
      unchanged++;
      continue;
    }
    if (st.reparse) reparse++;
    toRead.push(c);
  }
  // Oldest first, so a forked successor always finds its predecessor's
  // messages already in absorb_messages and threads onto them rather than
  // the other way round (the same ordering rule as cost backfill).
  toRead.sort((a, b) => (a.startedAt ?? a.updatedAt) - (b.startedAt ?? b.updatedAt));

  emit({ type: "info", message: `Store: ${toPortablePath(root)}` });
  emit({
    type: "info",
    message: `  Sessions: ${all.length} found${selected.length !== all.length ? `, ${selected.length} selected` : ""}`,
  });
  if (managed > 0) {
    emit({ type: "info", message: `  Managed by brane: ${managed} (live narratives own these; left alone)` });
  }
  if (unchanged > 0) {
    emit({ type: "info", message: `  Unchanged since last absorb: ${unchanged} (not read)` });
  }
  if (toRebuild.size > 0) {
    emit({
      type: "info",
      message: `  Rebuild: ${toRebuild.size} (events re-derived from source; narrative ids kept, seqs renumbered)`,
    });
  }
  if (locked > 0) {
    emit({
      type: "info",
      message: `  Not rebuilt: ${locked} (hold signals or narrations no import wrote; read as an ordinary re-run)`,
    });
  }
  if (reparse > 0) {
    emit({ type: "info", message: `  Newer parser: ${reparse} (unchanged since last absorb; read again for what it can now find)` });
  }
  emit({ type: "info", message: `  To read: ${toRead.length}` });
  emit({ type: "info", message: `Identity: ${identity.label}` });
  emit({ type: "info", message: `Brane: ${braneId}${braneId === homeBraneId ? " (home)" : ""}` });
  emit({ type: "info", message: `Folds: each session's own working directory (not registered as spawn points)` });
  if (dryRun) emit({ type: "info", message: `\n--- DRY RUN (no database changes) ---\n` });

  const ctx = createAbsorbContext(db, source.name, braneId, toPortablePath(root), identity, dryRun);
  ctx.summary.managed = managed;
  ctx.summary.unchanged = unchanged;
  if (locked > 0) ctx.summary.locked = locked;
  const rememberFile = db.prepare(
    `INSERT INTO absorb_files (brane_id, provider, external_id, path, bytes, mtime, absorbed_at, parser_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (brane_id, provider, external_id) DO UPDATE SET
       path = excluded.path, bytes = excluded.bytes, mtime = excluded.mtime, absorbed_at = excluded.absorbed_at,
       parser_version = excluded.parser_version`,
  );
  const foldPaths = new Set<string>();
  let done = 0;
  for (const c of toRead) {
    const rebuildNid = toRebuild.get(c.externalId);
    if (rebuildNid) {
      ctx.summary.rebuilt = (ctx.summary.rebuilt ?? 0) + 1;
      if (!dryRun) resetAbsorbedNarrative(db, rebuildNid, braneId, source.name, c.externalId);
    }
    const conv = source.extract(c);
    if (conv) {
      absorbOne(ctx, conv);
      if (conv.cwd) foldPaths.add(toPortablePath(conv.cwd));
    } else {
      ctx.summary.skipped++;
    }
    if (!dryRun) rememberFile.run(braneId, source.name, c.externalId, c.path, c.bytes, c.updatedAt, Date.now(), source.parserVersion);
    done++;
    emit({ type: "progress", done, title: conv?.title ?? null });
    // Yield between sessions so the daemon keeps answering mid-run and the
    // progress lines reach the client (the organelle importer's rule).
    await new Promise((r) => setImmediate(r));
  }

  emit({
    type: "summary",
    dry_run: dryRun,
    provider: source.name,
    brane_id: braneId,
    fold_paths: [...foldPaths],
    summary: ctx.summary,
  });
  return ctx.summary;
}

/** Organelle absorb — reads from search.db + niche filesystem. */
async function runOrganelleAbsorb(
  db: Database.Database,
  inputPath: string,
  req: AbsorbRequest,
  dryRun: boolean,
  emit: (event: AbsorbEvent) => void,
  opts: RunAbsorbOptions,
): Promise<AbsorbSummary> {
  const searchDbPath = findSearchDb();
  if (!searchDbPath) {
    throw new AbsorbInputError(
      "Cannot find organelle search database at ~/.organelle/index/search.db",
    );
  }

  // A single niche has .organelle/narratives/; the registry (~/.organelle)
  // has niches.json and means "every niche in it".
  const nichesJsonPath = resolve(inputPath, "niches.json");
  const singleNicheDir = resolve(inputPath, ".organelle", "narratives");

  let nichePaths: string[];
  if (existsSync(singleNicheDir)) {
    nichePaths = [inputPath];
  } else if (existsSync(nichesJsonPath)) {
    const registry = readNichesRegistry();
    nichePaths = Object.values(registry)
      .map((n) => n.path)
      .filter((p) => existsSync(resolve(p, ".organelle", "narratives")));
    if (nichePaths.length === 0) {
      throw new AbsorbInputError("No valid niches found in registry.");
    }
  } else {
    throw new AbsorbInputError(
      `Not an organelle niche or registry: ${inputPath}\n` +
        `Expected .organelle/narratives/ directory or niches.json file.`,
    );
  }

  // Identity — default to the OS username (organelle is a local system).
  const identity: AbsorbIdentity = req.identity
    ? { id: req.identity, label: req.identity }
    : (() => {
        const username = process.env.USER || process.env.USERNAME || "operator";
        return { id: username, label: username };
      })();

  const homeBraneId = getBraneId(db);
  const braneId =
    req.brane === "self" ? homeBraneId : (req.brane ?? deriveBraneId("organelle", identity.id));

  // Each niche gets its own fold (from --fold only when there is exactly one).
  const nichesToAbsorb: NicheToAbsorb[] = nichePaths.map((np) => ({
    nichePath: np,
    foldPath: portableFold(nichePaths.length === 1 ? (req.fold || np) : np),
  }));
  assertFoldsRegistrable(nichesToAbsorb.map((n) => n.foldPath), opts);

  // Everything above is validation; the report starts here.
  let totalNarratives = 0;
  let totalWithEvents = 0;
  let totalEvents = 0;
  const allAgentTypes: Record<string, number> = {};
  emit({ type: "info", message: `Search DB: ${searchDbPath}` });
  emit({ type: "info", message: `Niches: ${nichePaths.length}` });
  for (const np of nichePaths) {
    const desc = describeOrganelleNiche(np);
    totalNarratives += desc.narrativeCount;
    totalWithEvents += desc.narrativesWithEvents;
    totalEvents += desc.totalEvents;
    for (const [t, c] of Object.entries(desc.agentTypes)) {
      allAgentTypes[t] = (allAgentTypes[t] || 0) + c;
    }
    emit({
      type: "info",
      message: `  ${basename(np)}: ${desc.narrativesWithEvents} narratives, ${desc.totalEvents} events`,
    });
  }
  emit({
    type: "info",
    message: `Total: ${totalWithEvents} narratives with events (${totalNarratives} total, skipping utilities)`,
  });
  emit({ type: "info", message: `Events: ${totalEvents} importable` });
  const agentEntries = Object.entries(allAgentTypes).sort(([, a], [, b]) => b - a);
  if (agentEntries.length > 0) {
    emit({
      type: "info",
      message: `Agent types: ${agentEntries.map(([t, c]) => `${t} (${c})`).join(", ")}`,
    });
  }
  emit({ type: "info", message: `Identity: ${identity.label}` });
  emit({ type: "info", message: `Brane: ${braneId}${braneId === homeBraneId ? " (home)" : ""}` });
  emit({
    type: "info",
    message:
      nichesToAbsorb.length === 1
        ? `Fold: ${nichesToAbsorb[0].foldPath}`
        : `Folds: ${nichesToAbsorb.length} (one per niche)`,
  });

  if (dryRun) {
    emit({ type: "info", message: `\n--- DRY RUN (no database changes) ---\n` });
  } else {
    for (const { foldPath } of nichesToAbsorb) {
      registerFold(db, foldPath, { braneId, confineToHome: opts.confineFoldsToHome });
    }
  }

  const summary = await absorbOrganelle(
    db,
    nichesToAbsorb,
    braneId,
    identity,
    (done, title) => emit({ type: "progress", done, title }),
    dryRun,
  );

  emit({
    type: "summary",
    dry_run: dryRun,
    provider: "organelle",
    brane_id: braneId,
    fold_paths: nichesToAbsorb.map((n) => n.foldPath),
    summary,
  });
  return summary;
}

/** Stream-based absorb for chatgpt and similar JSON-export providers. */
async function runStreamAbsorb(
  db: Database.Database,
  providerName: string,
  inputPath: string,
  req: AbsorbRequest,
  dryRun: boolean,
  emit: (event: AbsorbEvent) => void,
  opts: RunAbsorbOptions,
): Promise<AbsorbSummary> {
  const provider = getProvider(providerName)!;

  if (!req.fold) {
    throw new AbsorbInputError(`--fold is required for ${provider.name} provider.`);
  }

  const desc = describeExportDirectory(inputPath);
  if (desc.conversationFiles.length === 0) {
    throw new AbsorbInputError(
      `No conversation files found in ${inputPath}.\n` +
        `Expected conversations.json or conversations-NNN.json files.`,
    );
  }

  // --identity overrides whatever user.json says; without either, refuse.
  let identity: AbsorbIdentity | undefined = extractIdentityFromDirectory(inputPath);
  if (req.identity) {
    identity = { id: req.identity, label: req.identity };
  } else if (!identity) {
    throw new AbsorbInputError(
      "No user.json found in directory. Pass --identity <email> to identify the account.",
    );
  }

  const homeBraneId = getBraneId(db);
  const foldPath = portableFold(req.fold);
  const braneId =
    req.brane === "self" ? homeBraneId : (req.brane ?? deriveBraneId(provider.name, identity.id));
  assertFoldsRegistrable([foldPath], opts);

  emit({ type: "info", message: `Directory: ${inputPath}` });
  emit({
    type: "info",
    message: `  Conversation files: ${desc.conversationFiles.length} (${desc.conversationFiles[0]}${desc.conversationFiles.length > 1 ? ` … ${desc.conversationFiles[desc.conversationFiles.length - 1]}` : ""})`,
  });
  if (desc.hasUserJson) emit({ type: "info", message: `  user.json: found` });
  if (desc.extraFiles.length > 0) {
    emit({
      type: "info",
      message: `  Extra files: ${desc.extraFiles.length} (${desc.extraFiles.filter((f) => !f.startsWith(".")).slice(0, 3).join(", ")}${desc.extraFiles.length > 3 ? ", …" : ""})`,
    });
  }
  if (desc.mediaDirs.length > 0) {
    emit({
      type: "info",
      message: `  Media dirs: ${desc.mediaDirs.length} (${desc.mediaDirs.slice(0, 3).join(", ")}${desc.mediaDirs.length > 3 ? ", …" : ""})`,
    });
  }

  const fileIndex = buildFileIndex(inputPath);
  emit({ type: "info", message: `  Asset index: ${fileIndex.size} files` });

  const sources = findConversationsInDirectory(inputPath)!;

  emit({ type: "info", message: `Identity: ${identity.label}` });
  emit({ type: "info", message: `Brane: ${braneId}${braneId === homeBraneId ? " (home)" : ""}` });
  emit({ type: "info", message: `Fold: ${foldPath}` });

  if (dryRun) {
    emit({ type: "info", message: `\n--- DRY RUN (no database changes) ---\n` });
  } else {
    registerFold(db, foldPath, { braneId, confineToHome: opts.confineFoldsToHome });
  }

  const summary = await absorb(
    db,
    sources,
    provider,
    braneId,
    foldPath,
    identity,
    (done, title) => emit({ type: "progress", done, title }),
    dryRun,
    fileIndex,
  );

  emit({
    type: "summary",
    dry_run: dryRun,
    provider: provider.name,
    brane_id: braneId,
    fold_paths: [foldPath],
    summary,
  });
  return summary;
}
