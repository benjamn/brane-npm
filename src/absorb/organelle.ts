/** Organelle absorb — imports narratives from organelle's search.db + niche filesystem */

import { randomBase36 } from "../ids.js";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, extname } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { getPayloadsDir } from "../db/schema.js";
import type Database from "better-sqlite3";
import type { AbsorbIdentity, AbsorbSummary } from "./types.js";
import { spawnedContent } from "../shared/narrative-format.js";

/** Row shape from organelle's search.db events table */
interface OrganelleEvent {
  narrative_id: string;
  seq: number;
  timestamp_ms: number;
  event_type: string;
  content: string | null;
  sender: string | null;
  speaker: string | null;
  intensity: string | null;
  extra: string | null;
}

/** Parsed meta.json from organelle narrative directory */
interface NarrativeMeta {
  narrative_id: string;
  agent_type: string;
  agent_class?: string;
  role: string;
  started_at?: string;
  cwd?: string;
}

/**
 * Default search.db location. Assumes a single organelle installation
 * per machine at ~/.organelle/ (the only layout organelle ever used).
 */
const SEARCH_DB_PATH = join(
  process.env.HOME!,
  ".organelle",
  "index",
  "search.db",
);

/** Find organelle search.db, returns path or undefined */
export function findSearchDb(): string | undefined {
  return existsSync(SEARCH_DB_PATH) ? SEARCH_DB_PATH : undefined;
}

/** Scan a niche's .organelle/narratives/ for narrative directories */
function scanNicheNarratives(nichePath: string): string[] {
  const narrativesDir = join(nichePath, ".organelle", "narratives");
  if (!existsSync(narrativesDir)) return [];
  return readdirSync(narrativesDir).filter((name) => {
    if (name.startsWith(".")) return false;
    try {
      return statSync(join(narrativesDir, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Read meta.json for a narrative */
function readNarrativeMeta(
  nichePath: string,
  nid: string,
): NarrativeMeta | undefined {
  const metaPath = join(
    nichePath,
    ".organelle",
    "narratives",
    nid,
    "meta.json",
  );
  if (!existsSync(metaPath)) return undefined;
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8"));
  } catch {
    return undefined;
  }
}

/** Map organelle event_type → brane event type */
function mapEventType(
  eventType: string,
  sender: string | null,
  knownNarrativeIds: Set<string>,
): string {
  switch (eventType) {
    case "signal_received":
      // Agent-to-agent signals: sender is a known narrative ID
      if (sender && knownNarrativeIds.has(sender)) return "agent_signal";
      return "human_signal";
    case "narration":
      return "narration";
    case "started":
      return "started";
    case "stopped":
      return "stopped";
    default:
      return "narration";
  }
}

/** Event types worth importing (skip terminal_frame, restarted) */
const IMPORTABLE_TYPES = new Set([
  "narration",
  "signal_received",
  "started",
  "stopped",
]);

/** Utility agent types to skip */
const UTILITY_ROLES = new Set(["utility"]);

export interface OrganelleNicheDescription {
  nichePath: string;
  narrativeCount: number;
  narrativesWithEvents: number;
  agentTypes: Record<string, number>;
  searchDbPath: string | undefined;
  totalEvents: number;
}

/** Describe a niche for display before import */
export function describeOrganelleNiche(
  nichePath: string,
): OrganelleNicheDescription {
  const searchDbPath = findSearchDb();
  const narrativeIds = scanNicheNarratives(nichePath);

  const agentTypes: Record<string, number> = {};
  let narrativesWithEvents = 0;
  let totalEvents = 0;
  let skippedUtility = 0;

  if (searchDbPath) {
    const orgDb = new BetterSqlite3(searchDbPath, { readonly: true });
    const countEvents = orgDb.prepare(
      "SELECT COUNT(*) as cnt FROM events WHERE narrative_id = ? AND event_type IN ('narration', 'signal_received', 'started', 'stopped')",
    );

    for (const nid of narrativeIds) {
      const meta = readNarrativeMeta(nichePath, nid);

      // Skip utility narratives
      if (meta && UTILITY_ROLES.has(meta.role)) {
        skippedUtility++;
        continue;
      }

      const { cnt } = countEvents.get(nid) as { cnt: number };
      if (cnt > 0) {
        narrativesWithEvents++;
        totalEvents += cnt;
        const type = meta?.agent_type || nid.replace(/-[a-f0-9]+$/, "");
        agentTypes[type] = (agentTypes[type] || 0) + 1;
      }
    }
    orgDb.close();
  }

  return {
    nichePath,
    narrativeCount: narrativeIds.length - skippedUtility,
    narrativesWithEvents,
    agentTypes,
    searchDbPath,
    totalEvents,
  };
}

/** Read all niches from ~/.organelle/niches.json (single installation assumed) */
export function readNichesRegistry(): Record<
  string,
  { path: string; name: string }
> {
  const nichesPath = join(process.env.HOME!, ".organelle", "niches.json");
  if (!existsSync(nichesPath)) return {};
  try {
    const data = JSON.parse(readFileSync(nichesPath, "utf-8"));
    return data.niches || {};
  } catch {
    return {};
  }
}

/** Copy attachment files from organelle receptor to brane payloads */
function copyAttachments(
  nichePath: string,
  orgNid: string,
  evt: OrganelleEvent,
  braneNid: string,
  seq: number,
  summary: AbsorbSummary,
  dryRun: boolean,
): string[] | undefined {
  if (!evt.extra) return undefined;

  let extra: { attachments?: string[] };
  try {
    extra = JSON.parse(evt.extra);
  } catch {
    return undefined;
  }

  if (!extra.attachments || extra.attachments.length === 0) return undefined;

  const narrativeDir = join(
    nichePath,
    ".organelle",
    "narratives",
    orgNid,
  );
  const payloadPaths: string[] = [];

  for (let i = 0; i < extra.attachments.length; i++) {
    const attachName = extra.attachments[i];
    // Attachments may be in receptor/ (old format) or attachments/ (new format)
    // The attachName itself may include the subdirectory prefix (e.g. "attachments/...")
    const candidates = [
      join(narrativeDir, "receptor", attachName),
      join(narrativeDir, attachName),
    ];
    const srcPath = candidates.find((p) => existsSync(p));

    if (!srcPath) {
      summary.unresolvedAssets++;
      continue;
    }

    try {
      const size = statSync(srcPath).size;
      summary.assets++;
      summary.assetsBytes += size;

      if (!dryRun) {
        const dir = getPayloadsDir(braneNid);
        const ext = extname(srcPath) || ".bin";
        const storedName = `${evt.timestamp_ms}_${seq}_${i}${ext}`;
        copyFileSync(srcPath, join(dir, storedName));
        payloadPaths.push(`${braneNid}/${storedName}`);
      }
    } catch {
      summary.unresolvedAssets++;
    }
  }

  return payloadPaths.length > 0 ? payloadPaths : undefined;
}

/** A niche to absorb, with its own fold path */
export interface NicheToAbsorb {
  nichePath: string;
  foldPath: string;
}

/**
 * Absorb organelle narratives from one or more niche directories.
 *
 * Reads events from ~/.organelle/index/search.db, metadata from
 * {niche}/.organelle/narratives/{nid}/meta.json, and copies
 * attachments from receptor directories.
 */
export async function absorbOrganelle(
  db: Database.Database,
  niches: NicheToAbsorb[],
  braneId: string,
  identity: AbsorbIdentity | undefined,
  onProgress?: (done: number, title: string | null) => void,
  dryRun?: boolean,
): Promise<AbsorbSummary> {
  const summary: AbsorbSummary = {
    provider: "organelle",
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

  const searchDbPath = findSearchDb();
  if (!searchDbPath) {
    throw new Error(
      "Cannot find organelle search database at ~/.organelle/index/search.db",
    );
  }

  const organelleDb = new BetterSqlite3(searchDbPath, { readonly: true });

  // Prepared statements for brane DB
  const insertNarrative = dryRun
    ? undefined
    : db.prepare(
        `INSERT INTO narratives (id, brane_id, fold_path, agent_type, role, created_at, status, title, archived, agent_session_id)
     VALUES (?, ?, ?, ?, ?, ?, 'ended', ?, 1, ?)`,
      );

  const insertEvent = dryRun
    ? undefined
    : db.prepare(
        `INSERT INTO events (narrative_id, seq, time, type, content, content_type, source, re, payloads, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

  // Dedup by agent_session_id (unique across organelle imports)
  const checkExisting = db.prepare(
    `SELECT id FROM narratives WHERE agent_session_id = ?`,
  );

  const getMaxSeq = db.prepare(
    "SELECT MAX(seq) as max_seq FROM events WHERE narrative_id = ?",
  );

  const getExistingEventCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM events WHERE narrative_id = ?",
  );

  // Query organelle events (excluding terminal_frame and restarted)
  const queryEvents = organelleDb.prepare(
    `SELECT * FROM events WHERE narrative_id = ?
     AND event_type IN ('narration', 'signal_received', 'started', 'stopped')
     ORDER BY seq ASC`,
  );

  // Build set of all known narrative IDs for agent signal detection
  const allNarrativeIds = new Set(
    (
      organelleDb
        .prepare("SELECT DISTINCT narrative_id FROM events")
        .all() as { narrative_id: string }[]
    ).map((r) => r.narrative_id),
  );

  const source = identity
    ? `organelle:${identity.label}`
    : "organelle:operator";

  // Insert a single narrative (transaction-wrapped)
  const insertOne = dryRun
    ? undefined
    : db.transaction(
        (
          orgNid: string,
          meta: NarrativeMeta | undefined,
          events: OrganelleEvent[],
          nicheFoldPath: string,
          nicheDir: string,
        ) => {
          const uniqueId = randomBase36(8);
          const braneNid = `organelle-${uniqueId}`;
          const agentType = meta?.agent_type || orgNid.replace(/-[a-f0-9]+$/, "");
          const role = "absorbed";
          const createdAt = meta?.started_at
            ? new Date(meta.started_at).getTime()
            : events[0]?.timestamp_ms || Date.now();
          const externalId = `organelle:${orgNid}`;

          // Extract title from first narration content (truncated)
          const firstNarration = events.find(
            (e) => e.event_type === "narration" && e.content,
          );
          const title = firstNarration?.content
            ? firstNarration.content.slice(0, 100)
            : null;

          insertNarrative!.run(
            braneNid,
            braneId,
            nicheFoldPath,
            agentType,
            role,
            createdAt,
            title,
            externalId,
          );

          for (let i = 0; i < events.length; i++) {
            const evt = events[i];
            const seq = i + 1;
            const type = mapEventType(evt.event_type, evt.sender, allNarrativeIds);
            const msgSource =
              evt.event_type === "signal_received"
                ? evt.sender || source
                : evt.speaker || orgNid;

            // Build content for started/stopped from extra
            let content = evt.content;
            if (evt.event_type === "started" && !content && evt.extra) {
              try {
                const ex = JSON.parse(evt.extra);
                content = spawnedContent(ex.agent_type || agentType, ex.role || role);
              } catch {
                content = spawnedContent(agentType, role);
              }
            }

            const payloads = copyAttachments(
              nicheDir,
              orgNid,
              evt,
              braneNid,
              seq,
              summary,
              false,
            );

            insertEvent!.run(
              braneNid,
              seq,
              evt.timestamp_ms,
              type,
              content,
              null, // content_type
              msgSource,
              null, // re
              payloads ? JSON.stringify(payloads) : null,
              null, // meta
            );
          }

          return braneNid;
        },
      );

  let processed = 0;

  for (const { nichePath, foldPath } of niches) {
    const narrativeIds = scanNicheNarratives(nichePath);

    for (const orgNid of narrativeIds) {
      // Every narrative's work below is synchronous SQLite and file copies.
      // Yield between them so the daemon that runs this keeps answering —
      // and so the progress stream actually reaches the client mid-run.
      await new Promise<void>((r) => setImmediate(r));
      const meta = readNarrativeMeta(nichePath, orgNid);

      // Skip utility narratives (caffeinate, htop, lazygit, zsh)
      if (meta && UTILITY_ROLES.has(meta.role)) {
        processed++;
        onProgress?.(processed, orgNid);
        continue;
      }

      const events = queryEvents.all(orgNid) as OrganelleEvent[];

      // Skip narratives with no importable events
      if (events.length === 0) {
        summary.skipped++;
        processed++;
        onProgress?.(processed, orgNid);
        continue;
      }

      // Update summary timestamps
      const firstTime = events[0].timestamp_ms;
      const lastTime = events[events.length - 1].timestamp_ms;
      if (!summary.oldest || firstTime < summary.oldest.time) {
        summary.oldest = { time: firstTime, title: orgNid };
      }
      if (!summary.newest || lastTime > summary.newest.time) {
        summary.newest = { time: lastTime, title: orgNid };
      }

      // Track agent types in models field
      const agentType = meta?.agent_type || orgNid.replace(/-[a-f0-9]+$/, "");
      summary.models[agentType] = (summary.models[agentType] || 0) + 1;

      // Dedup check
      const externalId = `organelle:${orgNid}`;
      const existing = checkExisting.get(externalId) as
        | { id: string }
        | undefined;

      if (existing) {
        const { cnt } = getExistingEventCount.get(existing.id) as {
          cnt: number;
        };
        if (events.length <= cnt) {
          summary.skipped++;
        } else {
          if (!dryRun) {
            // Append new events
            const { max_seq } = getMaxSeq.get(existing.id) as {
              max_seq: number;
            };
            let nextSeq = max_seq + 1;

            for (let i = cnt; i < events.length; i++) {
              const evt = events[i];
              const type = mapEventType(evt.event_type, evt.sender, allNarrativeIds);
              const msgSource =
                evt.event_type === "signal_received"
                  ? evt.sender || source
                  : evt.speaker || orgNid;

              const payloads = copyAttachments(
                nichePath,
                orgNid,
                evt,
                existing.id,
                nextSeq,
                summary,
                false,
              );

              insertEvent!.run(
                existing.id,
                nextSeq++,
                evt.timestamp_ms,
                type,
                evt.content,
                null,
                msgSource,
                null,
                payloads ? JSON.stringify(payloads) : null,
                null,
              );
            }
          }
          summary.appended++;
        }
      } else {
        // Count content events (narration + signal) for messages total
        const contentEvents = events.filter(
          (e) =>
            e.event_type === "narration" ||
            e.event_type === "signal_received",
        );
        summary.messages += contentEvents.length;

        if (!dryRun) {
          insertOne!(orgNid, meta, events, foldPath, nichePath);
        } else {
          // Dry-run: count assets
          for (const evt of events) {
            copyAttachments(
              nichePath,
              orgNid,
              evt,
              "dry-run",
              0,
              summary,
              true,
            );
          }
        }

        summary.conversations++;
      }

      processed++;
      onProgress?.(processed, orgNid);
    }
  }

  organelleDb.close();
  return summary;
}
