/** The inventory behind a bare `brane absorb`: every session store brane
 *  knows how to look for, whether it is on this machine, and what an import
 *  would do with it. Reads no message content — the survey is a promise a
 *  new user can be given ("it tells you what it found; nothing leaves the
 *  machine, nothing is imported until you say") and it is kept by
 *  construction: `LocalSource.survey` is a stat and a head read, and the
 *  probes below are `existsSync`.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { LocalSource, SessionCandidate } from "./types.js";
import { claudeCodeSource } from "./claude-code.js";
import { toPortablePath } from "../db/schema.js";
import { deriveBraneId } from "./brane-id.js";

/** Local sources with an extractor, in the order the survey lists them. */
export const LOCAL_SOURCES: LocalSource[] = [claudeCodeSource];

export function getLocalSource(name: string): LocalSource | undefined {
  return LOCAL_SOURCES.find((s) => s.name === name);
}

/** Stores brane recognises but cannot read yet. Listed so the survey says
 *  "found, no extractor" rather than nothing — the operator learns what is
 *  on the machine either way, and which line to ask for next. Today the
 *  list is the agents brane can spawn (see `AGENTS` in src/agents.ts) plus
 *  the other Claude product with a local transcript, because those are the
 *  formats someone here has looked at. Nothing ties an entry — or a
 *  `LocalSource` — to spawn support: an importer for a tool brane cannot
 *  run is welcome (claude-xiy9e8wq:17); the list just isn't speculative. */
const PROBES: Array<{ name: string; label: string; under: (home: string) => string }> = [
  { name: "codex", label: "Codex CLI rollouts", under: (h) => join(h, ".codex", "sessions") },
  { name: "goose", label: "goose sessions", under: (h) => join(h, ".local", "share", "goose", "sessions") },
  { name: "copilot", label: "GitHub Copilot CLI session store", under: (h) => join(h, ".copilot", "session-store.db") },
  { name: "gemini", label: "Gemini CLI", under: (h) => join(h, ".gemini", "tmp") },
  { name: "cline", label: "Cline tasks", under: (h) => join(h, ".cline", "data", "tasks") },
  { name: "amp", label: "Amp", under: (h) => join(h, ".amp") },
  {
    name: "claude-desktop",
    label: "Claude Desktop agent-mode sessions",
    under: (h) => join(h, "Library", "Application Support", "Claude", "local-agent-mode-sessions"),
  },
];

export interface SourceReport {
  name: string;
  label: string;
  path: string;
  found: boolean;
  /** An extractor exists; `sessions` is filled in. */
  supported: boolean;
  sessions?: {
    total: number;
    /** Never absorbed and not brane's own: what an import would add. */
    new: number;
    /** Absorbed before and grown since (stat differs from absorb_files). */
    changed: number;
    /** Absorbed before and unchanged. */
    unchanged: number;
    /** Absorbed before, unchanged since, but read by an older parser than
     *  this one: the next import reads it again for what it can now find. */
    reparse: number;
    /** A live brane narrative owns the session; left to it. */
    managed: number;
    bytes: number;
    /** Distinct working directories, for a sense of how many folds. */
    folds: number;
    oldest: number | null;
    newest: number | null;
  };
}

export interface AbsorbSurvey {
  home: string;
  sources: SourceReport[];
}

/** Which of a source's sessions brane already has, and how. */
export interface SessionStatus {
  managedBy: string | null;
  absorbedBy: string | null;
  /** Same size and mtime as when a parser at least as new as this one read it. */
  unchanged: boolean;
  /** Same size and mtime, but read last by an older parser. */
  reparse: boolean;
}

/** Classify every candidate against the database in one pass: managed by a
 *  live narrative (any brane), absorbed before into `braneId` (and whether
 *  the file has changed since), or new to that brane. Shared by the survey
 *  and the import so they cannot disagree. */
export function classifySessions(
  db: Database.Database,
  source: LocalSource,
  candidates: SessionCandidate[],
  braneId: string,
): Map<string, SessionStatus> {
  const out = new Map<string, SessionStatus>();
  if (candidates.length === 0) return out;

  // Live narratives of this agent type: the session ids they have bound.
  const managed = new Map<string, string>();
  const rows = db
    .prepare(
      `SELECT id, agent_session_id, session_ids FROM narratives
        WHERE agent_type = ? AND role != 'absorbed'
          AND (agent_session_id IS NOT NULL OR session_ids IS NOT NULL)`,
    )
    .all(source.name) as Array<{ id: string; agent_session_id: string | null; session_ids: string | null }>;
  for (const r of rows) {
    if (r.agent_session_id) managed.set(r.agent_session_id, r.id);
    if (r.session_ids) {
      try {
        const ids = JSON.parse(r.session_ids);
        if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") managed.set(id, r.id);
      } catch {
        // malformed column value; agent_session_id above still counts
      }
    }
  }

  const absorbed = db.prepare(
    `SELECT id FROM narratives
      WHERE agent_type = ? AND role = 'absorbed' AND agent_session_id = ? AND brane_id = ?`,
  );
  const fileRow = db.prepare(
    "SELECT bytes, mtime, parser_version FROM absorb_files WHERE brane_id = ? AND provider = ? AND external_id = ?",
  );

  for (const c of candidates) {
    const managedBy = managed.get(c.externalId) ?? null;
    const abs = absorbed.get(source.name, c.externalId, braneId) as { id: string } | undefined;
    const f = fileRow.get(braneId, source.name, c.externalId) as
      | { bytes: number; mtime: number; parser_version: number }
      | undefined;
    // Unchanged means nothing new could come of reading it: the same
    // bytes, read last time by a parser that knew what this one knows.
    const sameFile = !!f && f.bytes === c.bytes && f.mtime === c.updatedAt;
    const current = !!f && f.parser_version >= source.parserVersion;
    out.set(c.externalId, {
      managedBy,
      absorbedBy: abs?.id ?? null,
      unchanged: sameFile && current,
      reparse: sameFile && !current,
    });
  }
  return out;
}

export function surveyAbsorbSources(db: Database.Database, home: string): AbsorbSurvey {
  const sources: SourceReport[] = [];

  for (const src of LOCAL_SOURCES) {
    const root = src.locate(home);
    const report: SourceReport = {
      name: src.name,
      label: labelFor(src.name),
      path: toPortablePath(root ?? defaultPathFor(src.name, home)),
      found: root !== null,
      supported: true,
    };
    if (root) {
      const candidates = src.survey(root);
      // The survey answers for the brane a plain `brane absorb <source>`
      // would target — the one derived from the account — since that is
      // the import it is previewing.
      const status = classifySessions(db, src, candidates, deriveBraneId(src.name, src.identity(home).id));
      const s = { total: 0, new: 0, changed: 0, unchanged: 0, reparse: 0, managed: 0, bytes: 0, folds: 0, oldest: null as number | null, newest: null as number | null };
      const folds = new Set<string>();
      for (const c of candidates) {
        s.total++;
        s.bytes += c.bytes;
        if (c.cwd) folds.add(c.cwd);
        if (c.startedAt !== null && (s.oldest === null || c.startedAt < s.oldest)) s.oldest = c.startedAt;
        if (s.newest === null || c.updatedAt > s.newest) s.newest = c.updatedAt;
        const st = status.get(c.externalId)!;
        if (st.managedBy) s.managed++;
        else if (st.absorbedBy) (st.unchanged ? s.unchanged++ : st.reparse ? s.reparse++ : s.changed++);
        else s.new++;
      }
      s.folds = folds.size;
      report.sessions = s;
    }
    sources.push(report);
  }

  for (const probe of PROBES) {
    const path = probe.under(home);
    sources.push({
      name: probe.name,
      label: probe.label,
      path: toPortablePath(path),
      found: existsSync(path) && !isEmptyDir(path),
      supported: false,
    });
  }

  return { home, sources };
}

function isEmptyDir(path: string): boolean {
  try {
    return statSync(path).isDirectory() && readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

function labelFor(name: string): string {
  switch (name) {
    case "claude":
      return "Claude Code sessions";
    default:
      return name;
  }
}

function defaultPathFor(name: string, home: string): string {
  switch (name) {
    case "claude":
      return join(home, ".claude", "projects");
    default:
      return home;
  }
}
