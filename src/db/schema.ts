import Database from "better-sqlite3";
import { randomBase36 } from "../ids.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { mkdirSync, existsSync, readFileSync, chmodSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let _cachedVersion: string | undefined;
/** Read the package version (major.minor) from package.json */
export function getPackageVersion(): string {
  if (!_cachedVersion) {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"));
    const parts = (pkg.version as string).split(".");
    _cachedVersion = `${parts[0]}.${parts[1]}`;
  }
  return _cachedVersion;
}

const BRANE_DIR = join(homedir(), ".brane");
const DB_PATH = join(BRANE_DIR, "brane.db");

export const SCHEMA_SQL = `
-- Brane instance identity and configuration
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Registered folds (spawn points)
CREATE TABLE IF NOT EXISTS folds (
  path TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_spawned INTEGER,
  archived INTEGER DEFAULT 0
);

-- Narratives (agent sessions)
CREATE TABLE IF NOT EXISTS narratives (
  id TEXT PRIMARY KEY,
  brane_id TEXT NOT NULL,
  fold_path TEXT,
  agent_type TEXT,
  role TEXT,
  created_at INTEGER NOT NULL,
  status TEXT DEFAULT 'active',
  agent_session_id TEXT,
  title TEXT,
  summary TEXT,
  launch_args TEXT,
  bind_token TEXT,
  session_ids TEXT
);

-- Narrative events (append-only log)
CREATE TABLE IF NOT EXISTS events (
  narrative_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  time INTEGER NOT NULL,
  type TEXT NOT NULL,
  content TEXT,
  content_type TEXT,
  source TEXT,
  re TEXT,
  payloads TEXT,
  meta TEXT,
  PRIMARY KEY (narrative_id, seq)
);

-- Daemon bearer tokens, by hash only (src/db/tokens.ts). Never deleted:
-- a token is revoked by stamping revoked_at.
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  -- 'minted' by this daemon, or 'adopted' from a plaintext token that
  -- predates hashing (and may have been logged).
  origin TEXT NOT NULL DEFAULT 'minted',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

-- Index for efficient event polling
CREATE INDEX IF NOT EXISTS idx_events_narrative_seq
  ON events (narrative_id, seq);
`;

function generateBraneId(): string {
  const slug = randomBase36(6);
  return `brane-${slug}`;
}

export function ensureBraneDir(): string {
  if (!existsSync(BRANE_DIR)) {
    mkdirSync(BRANE_DIR, { recursive: true, mode: 0o700 });
  }
  // Everything here is this user's alone: the database, the daemon's socket,
  // the payloads, the TLS key. `mode` only applies at creation, so the chmod is
  // what tightens a directory an older brane made 0755.
  try { chmodSync(BRANE_DIR, 0o700); } catch {}
  return BRANE_DIR;
}

/** `.daemon_token` beside a database: where older branes kept this machine's
 *  local token. Retired: the daemon reads it once at start, to revoke what it
 *  holds, then empties it, and nothing presents it (`bootstrapTokens`,
 *  src/db/tokens.ts). */
export function getTokenFilePath(db: Database.Database): string {
  return join(dirname(db.name), ".daemon_token");
}

/**
 * Bring a database created from `SCHEMA_SQL` up to the current shape.
 *
 * `SCHEMA_SQL` is the original table set; everything added since arrives here as
 * an idempotent `ALTER TABLE`/backfill. Kept separate from `openDatabase()` so
 * that *every* database — production and test fixtures alike — is built by the
 * same two steps. A column that exists only in this ladder is otherwise a column
 * that works in production and throws in tests.
 *
 * Safe to run on any database, any number of times.
 */
export function applyMigrations(db: Database.Database): void {
  // Migrate: add title and summary columns if missing
  const cols = db.pragma("table_info(narratives)") as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("title")) {
    db.exec("ALTER TABLE narratives ADD COLUMN title TEXT");
  }
  if (!colNames.has("summary")) {
    db.exec("ALTER TABLE narratives ADD COLUMN summary TEXT");
  }
  if (!colNames.has("archived")) {
    db.exec("ALTER TABLE narratives ADD COLUMN archived INTEGER DEFAULT 0");
  }
  if (!colNames.has("agent_session_id")) {
    db.exec("ALTER TABLE narratives ADD COLUMN agent_session_id TEXT");
  }
  if (!colNames.has("launch_args")) {
    db.exec("ALTER TABLE narratives ADD COLUMN launch_args TEXT");
  }
  // Per-narrative bind secret: authenticates the MCP bridge's claim to this
  // narrative id on /ws/mcp, so a crossed BRANE_NARRATIVE_ID (or a second
  // process reusing an nid) can't bind as a narrative it doesn't own. Nullable;
  // rows created before this column can no longer bind at all (see
  // resolveMcpBind); revive mints one for such a row before relaunching it.
  if (!colNames.has("bind_token")) {
    db.exec("ALTER TABLE narratives ADD COLUMN bind_token TEXT");
  }
  // Every agent session id a narrative has ever bound (JSON array). A narrative
  // rolls through multiple sessions over its life (revive, twin/agent-switch,
  // context compaction), and total cost is the sum across all of them — but
  // agent_session_id only ever holds the *current* one. session_ids is the
  // cumulative set so cost sampling can aggregate every session's usage.
  if (!colNames.has("session_ids")) {
    db.exec("ALTER TABLE narratives ADD COLUMN session_ids TEXT");
    // Backfill: seed the set from the current session so no existing narrative
    // loses its reading. Session ids are UUIDs ([0-9a-f-]), so the string-built
    // JSON array needs no escaping. Idempotent (guarded on session_ids IS NULL).
    db.exec(
      `UPDATE narratives SET session_ids = '["' || agent_session_id || '"]'
       WHERE session_ids IS NULL AND agent_session_id IS NOT NULL`,
    );
  }
  // Cumulative session cost, sampled from the agent's own usage log. Unit is
  // agent-defined ("USD", "AIC", …); cost_tokens is an optional JSON breakdown.
  if (!colNames.has("cost_amount")) {
    db.exec("ALTER TABLE narratives ADD COLUMN cost_amount REAL");
  }
  if (!colNames.has("cost_unit")) {
    db.exec("ALTER TABLE narratives ADD COLUMN cost_unit TEXT");
  }
  if (!colNames.has("cost_tokens")) {
    db.exec("ALTER TABLE narratives ADD COLUMN cost_tokens TEXT");
  }

  // Durable per-unit-of-work usage ledger. The transcripts the cost readers
  // parse belong to the harnesses, which may purge them; this table keeps what
  // was read. `key` is the dedup: an entry-level row ("<agent>:<message id>")
  // is inserted once and credited to the first narrative that saw it, so a
  // fork-copied message never counts twice even after the original file is
  // gone. A session-level row ("session:<agent>:<session id>") holds a
  // high-water mark for harnesses that only expose a cumulative total. Rows
  // are never deleted, and never re-priced implicitly: only an explicit
  // `brane cost reprice` rewrites `amount`, so between reprices a narrative's
  // ledger sum is monotonic by construction. narratives.cost_* caches that sum.
  // `cache_write_1h` (of `cache_write`, the 1-hour share) and `speed` are what
  // a reprice needs beyond model and tokens; rows written before they existed
  // have them recovered by the first reprice (src/cost/reprice.ts).
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_ledger (
      key TEXT PRIMARY KEY,
      narrative_id TEXT NOT NULL,
      session_id TEXT,
      agent_type TEXT,
      unit TEXT NOT NULL,
      amount REAL NOT NULL,
      model TEXT,
      input INTEGER,
      output INTEGER,
      cache_read INTEGER,
      cache_write INTEGER,
      first_seen INTEGER NOT NULL,
      cache_write_1h INTEGER,
      speed TEXT
    );
    CREATE INDEX IF NOT EXISTS usage_ledger_narrative ON usage_ledger(narrative_id);
  `);
  const ledgerCols = new Set((db.pragma("table_info(usage_ledger)") as Array<{ name: string }>).map((c) => c.name));
  if (!ledgerCols.has("model")) {
    db.exec("ALTER TABLE usage_ledger ADD COLUMN model TEXT");
  }
  if (!ledgerCols.has("cache_write_1h")) {
    db.exec("ALTER TABLE usage_ledger ADD COLUMN cache_write_1h INTEGER");
  }
  if (!ledgerCols.has("speed")) {
    db.exec("ALTER TABLE usage_ledger ADD COLUMN speed TEXT");
  }

  // Migrate: add meta column to events if missing
  const eventCols = db.pragma("table_info(events)") as Array<{ name: string }>;
  if (!eventCols.some((c) => c.name === "meta")) {
    db.exec("ALTER TABLE events ADD COLUMN meta TEXT");
  }

  // Migrate: add brane_id to folds if missing
  const foldCols = db.pragma("table_info(folds)") as Array<{ name: string }>;
  if (!foldCols.some((c) => c.name === "brane_id")) {
    db.exec("ALTER TABLE folds ADD COLUMN brane_id TEXT");
  }
  // Migrate: add archived to folds if missing. Archived folds are hidden from
  // the spawn dropdown but never deleted (see Golden Rule) — "prune" is soft.
  if (!foldCols.some((c) => c.name === "archived")) {
    db.exec("ALTER TABLE folds ADD COLUMN archived INTEGER DEFAULT 0");
  }

  // Backfill any folds missing brane_id to home brane (idempotent)
  db.exec(
    "UPDATE folds SET brane_id = (SELECT value FROM meta WHERE key = 'brane_id') WHERE brane_id IS NULL",
  );

  // Fix organelle-imported narratives that kept their original role instead of "absorbed"
  db.exec(
    "UPDATE narratives SET role = 'absorbed' WHERE agent_session_id LIKE 'organelle:%' AND role != 'absorbed'",
  );

  // Tool calls an agent made, alongside the narrative rather than inside it.
  //
  // Deliberately NOT events. `nid:seq` is a published permalink — it appears in
  // `re` back-references from other narratives and in exported HTML anchors that
  // have already left this machine — so existing seqs can never move. Backfilled
  // tool calls (from a session log or an absorb) would need to slot *between*
  // existing seqs, which is impossible without renumbering. Keeping them out of
  // the sequence also means a burst of 200 tool calls can't drown a `tail: 50`
  // context load or wake every blocked `listen`.
  //
  // Three keys, three jobs:
  //   after_seq + started_at — where a row renders (between event N and N+1).
  //     Anchoring to a seq rather than to wall time keeps placement deterministic
  //     when the hook process, the daemon, and an imported vendor file disagree
  //     about the clock. Reads the seq space; never writes to it.
  //   rev — the sync cursor. A row mutates (pending → completed) without moving,
  //     so a client resuming from a display key would miss every update.
  //   dedup_key — identity. Vendor tool_use_id where available, else a content
  //     hash. In the primary key so the same call arriving twice (live by hook,
  //     later by session-log backfill) collapses to one row.
  //
  // Most columns are nullable on purpose: agents report wildly different amounts
  // (some emit only a pre-call event, with no result, duration, or outcome ever).
  // One row shape for every agent, with gaps where a vendor can't fill them in.
  //   status: pending | allowed | denied | completed | failed | unknown
  //     ("unknown" = started and will never resolve — the renderer must not spin.)
  //   source: hook | session_log | absorb — distinguishes "the agent didn't do
  //     that" from "this agent can't report it".
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_uses (
      narrative_id  TEXT NOT NULL,
      dedup_key     TEXT NOT NULL,
      after_seq     INTEGER NOT NULL,
      started_at    INTEGER NOT NULL,
      rev           INTEGER NOT NULL,
      name          TEXT NOT NULL,
      input         TEXT,
      status        TEXT NOT NULL,
      output        TEXT,
      duration_ms   INTEGER,
      error         TEXT,
      decided_by    TEXT,
      decided_at    INTEGER,
      decision_note TEXT,
      source        TEXT NOT NULL,
      agent_type    TEXT,
      parent_id     TEXT,
      PRIMARY KEY (narrative_id, dedup_key)
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS tool_uses_order ON tool_uses (narrative_id, after_seq, started_at)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS tool_uses_sync ON tool_uses (narrative_id, rev)",
  );

  // Mentions. `@claude-4c7289d1` in one narrative addresses another, and the
  // whole point is to get an agent's attention *without commenting in its
  // narrative* — so a mention is deliberately not an event. That also keeps
  // `nid:seq` clean (see the tool_uses note above), makes a re-scan idempotent,
  // and avoids the recursion an event would invite by quoting the handle that
  // created it.
  //
  // Each row carries both the mention and what became of it:
  //
  //   The mention itself — mentioned_nid, src_narrative, src_seq, author, time
  //   — is derived data. A re-scan of the event log reproduces it exactly,
  //   because UNIQUE makes a second insert a no-op (the same trick as
  //   usage_ledger's INSERT OR IGNORE keys). Rebuild freely.
  //
  //   sent_at and seen_at are not derivable from anything. They record what
  //   passed between the daemon and one agent, and they answer two different
  //   questions that a single mark would conflate:
  //
  //     sent_at — this mention has been handed over. Governs whether a parked
  //       `listen` resolves right now, so a mention wakes an agent exactly
  //       once. Without it, "pending" would both resolve the listen and
  //       survive the resolve, and the next listen would return instantly,
  //       forever, at inference speed.
  //
  //     seen_at — the agent has demonstrably attended to it, evidenced by
  //       reading the narrative it was written in (ackMentionsByRead in
  //       db/mentions.ts). Governs what the receipt keeps showing, so a
  //       delivered-but-unread mention is a standing reminder rather than a
  //       loop.
  //
  // Per row rather than a high-water mark per narrative, because acknowledgment
  // is per *source*: reading narrative B says nothing about a mention written
  // in C. A scalar watermark over a shared id space settles every lower id
  // regardless of where it came from, silently marking unread mentions read —
  // exactly the drop this design exists to prevent. NULL → timestamp also
  // makes monotonicity structural: there is no value that could rewind.
  //
  // Rows are never deleted (Golden Rule), which is what lets `id` be a plain
  // rowid, and what makes a rebuild safe only when it is *additive*. A
  // delete-and-repopulate would reassign ids and discard sent_at/seen_at,
  // re-delivering settled mentions. Note memory resets itself with
  // `DELETE FROM memory_cursors` (memory/index.ts); the two look alike and
  // must not be reset alike.
  db.exec(`
    CREATE TABLE IF NOT EXISTS mentions (
      id            INTEGER PRIMARY KEY,
      mentioned_nid TEXT NOT NULL,
      src_narrative TEXT NOT NULL,
      src_seq       INTEGER NOT NULL,
      author        TEXT NOT NULL,
      time          INTEGER NOT NULL,
      sent_at       INTEGER,
      seen_at       INTEGER,
      UNIQUE (mentioned_nid, src_narrative, src_seq)
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS mentions_pending ON mentions (mentioned_nid, id)",
  );
  // The reverse lookup: which mentions ride in these specific events. Used to
  // annotate events as they are returned, and to settle exactly the mentions a
  // read actually delivered — the UNIQUE constraint's index leads with
  // mentioned_nid and can't answer either.
  db.exec(
    "CREATE INDEX IF NOT EXISTS mentions_src ON mentions (src_narrative, src_seq)",
  );

  // Absorb's memory of what it has already read, for sources that can be
  // re-read: a local agent's session store grows while brane runs, and
  // `brane absorb claude` is meant to be run again and again.
  //
  //   absorb_messages — provider-issued message id → where it landed. The
  //     dedup that makes a re-run idempotent *per message*, not just per
  //     conversation: Claude's `--fork-session` copies a predecessor's
  //     records, ids included, into the successor's file, so a count-based
  //     append would import the prefix twice under two narratives. Same
  //     trick as usage_ledger's keyed INSERT OR IGNORE — the first narrative
  //     to hold a key keeps it, and a later reading of the same key elsewhere
  //     becomes a cross-narrative `re` instead of a copy.
  //
  //   absorb_files — (size, mtime) of each session file at its last absorb,
  //     and the parser generation that read it. A file that has not changed
  //     since a parser as new as this one read it is skipped on the stat
  //     alone, which is what keeps a re-run over hundreds of unchanged
  //     sessions instant. It is an optimisation only: a changed file is
  //     re-read in full and absorb_messages catches every duplicate, so a
  //     stale or missing row costs time, never correctness.
  //
  // Both are keyed by **brane** as well as provider. `--brane` names a
  // destination, and a destination is independent of every other one: the
  // same store imported into two branes is two complete copies, each with
  // its own idempotent re-runs. The first cut keyed on provider alone, so a
  // second brane saw every file as already absorbed and read nothing
  // (claude-xiy9e8wq:38). The `managed` check in classifySessions stays
  // global on purpose — a live narrative owns its session whatever brane it
  // is in.
  //
  // Neither is ever deleted. Both are derivable from the files and the log,
  // and additive by construction. The provider-only tables from before the
  // brane column are carried over by joining each row to the narrative it
  // named, and kept under `_v1` names rather than dropped.
  db.exec(`
    CREATE TABLE IF NOT EXISTS absorb_messages (
      brane_id     TEXT NOT NULL,
      provider     TEXT NOT NULL,
      key          TEXT NOT NULL,
      narrative_id TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      PRIMARY KEY (brane_id, provider, key)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS absorb_files (
      brane_id       TEXT NOT NULL,
      provider       TEXT NOT NULL,
      external_id    TEXT NOT NULL,
      path           TEXT NOT NULL,
      bytes          INTEGER NOT NULL,
      mtime          INTEGER NOT NULL,
      absorbed_at    INTEGER NOT NULL,
      parser_version INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (brane_id, provider, external_id)
    )
  `);
  migrateAbsorbLedgersToBraneScope(db);
  // Which parser read the file (`LocalSource.parserVersion`). A row from
  // before the column existed reads as 0, older than any parser, so each
  // such file is read once more by the current one.
  const fileCols = new Set((db.pragma("table_info(absorb_files)") as Array<{ name: string }>).map((c) => c.name));
  if (!fileCols.has("parser_version")) {
    db.exec("ALTER TABLE absorb_files ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 0");
  }
  // What a token was first presented from, so the Devices list can tell rows
  // apart (`DbTokenStore.find`, src/db/tokens.ts). Written once and never
  // overwritten: a row keeps naming the device that claimed it.
  const tokenCols = new Set((db.pragma("table_info(tokens)") as Array<{ name: string }>).map((c) => c.name));
  if (!tokenCols.has("user_agent")) {
    db.exec("ALTER TABLE tokens ADD COLUMN user_agent TEXT");
  }
  if (!tokenCols.has("remote_addr")) {
    db.exec("ALTER TABLE tokens ADD COLUMN remote_addr TEXT");
  }
  // The latest sighting beside the first, and when the token was last
  // presented from an address other than its first: what shows a copy.
  if (!tokenCols.has("last_user_agent")) {
    db.exec("ALTER TABLE tokens ADD COLUMN last_user_agent TEXT");
  }
  if (!tokenCols.has("last_remote_addr")) {
    db.exec("ALTER TABLE tokens ADD COLUMN last_remote_addr TEXT");
  }
  if (!tokenCols.has("elsewhere_at")) {
    db.exec("ALTER TABLE tokens ADD COLUMN elsewhere_at INTEGER");
  }
  // Which token's request minted this one. Written at mint and impossible to
  // reconstruct later, so it is recorded before anything uses it.
  if (!tokenCols.has("minted_by")) {
    db.exec("ALTER TABLE tokens ADD COLUMN minted_by TEXT");
  }
  // The narrative an `agent` token belongs to: the only one it may bind as.
  if (!tokenCols.has("owner_nid")) {
    db.exec("ALTER TABLE tokens ADD COLUMN owner_nid TEXT");
  }
  // Which token's request last launched a narrative's process (spawn, run or
  // revive), so revoking a device can say which agents it started. Recorded
  // from now on; there is nothing to backfill it from.
  const launchCols = new Set((db.pragma("table_info(narratives)") as Array<{ name: string }>).map((c) => c.name));
  if (!launchCols.has("launched_by")) {
    db.exec("ALTER TABLE narratives ADD COLUMN launched_by TEXT");
  }
}

/** Carry provider-only `absorb_messages` / `absorb_files` rows (the shape
 *  #456 shipped) into the brane-scoped tables. Detected by the old table
 *  lacking a `brane_id` column; runs once, since the old table is renamed
 *  to `<name>_v1` afterwards and never touched again. Idempotent on a
 *  database that has already been migrated or never had the old shape. */
function migrateAbsorbLedgersToBraneScope(db: Database.Database): void {
  const cols = (table: string): Set<string> =>
    new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name));

  // The CREATE TABLE IF NOT EXISTS above is a no-op when the old table
  // exists, so an old-shape table is one that is present without brane_id.
  if (!cols("absorb_messages").has("brane_id")) {
    db.exec("ALTER TABLE absorb_messages RENAME TO absorb_messages_v1");
    db.exec(`
      CREATE TABLE absorb_messages (
        brane_id     TEXT NOT NULL,
        provider     TEXT NOT NULL,
        key          TEXT NOT NULL,
        narrative_id TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        PRIMARY KEY (brane_id, provider, key)
      )
    `);
    // A message's brane is its narrative's; a row whose narrative is gone
    // has nothing to be scoped to and stays only in the _v1 table.
    db.exec(`
      INSERT OR IGNORE INTO absorb_messages (brane_id, provider, key, narrative_id, seq)
      SELECT n.brane_id, m.provider, m.key, m.narrative_id, m.seq
        FROM absorb_messages_v1 m JOIN narratives n ON n.id = m.narrative_id
    `);
  }
  if (!cols("absorb_files").has("brane_id")) {
    db.exec("ALTER TABLE absorb_files RENAME TO absorb_files_v1");
    // Kept in step with the CREATE in applyMigrations; carried rows take
    // parser_version 0, so each is read once more by the current parser.
    db.exec(`
      CREATE TABLE absorb_files (
        brane_id       TEXT NOT NULL,
        provider       TEXT NOT NULL,
        external_id    TEXT NOT NULL,
        path           TEXT NOT NULL,
        bytes          INTEGER NOT NULL,
        mtime          INTEGER NOT NULL,
        absorbed_at    INTEGER NOT NULL,
        parser_version INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (brane_id, provider, external_id)
      )
    `);
    // A file's brane is that of the absorbed narrative holding its session
    // id. A file whose narrative is gone (or that parsed to nothing and so
    // has no narrative) is simply re-read next time — the stat-skip is an
    // optimisation, and losing it costs one parse.
    db.exec(`
      INSERT OR IGNORE INTO absorb_files (brane_id, provider, external_id, path, bytes, mtime, absorbed_at)
      SELECT n.brane_id, f.provider, f.external_id, f.path, f.bytes, f.mtime, f.absorbed_at
        FROM absorb_files_v1 f
        JOIN narratives n ON n.agent_session_id = f.external_id
                         AND n.agent_type = f.provider AND n.role = 'absorbed'
    `);
  }
}

export function openDatabase(): Database.Database {
  // Under `node --test` there is no operator: the suite builds its databases
  // with `createTestDb()`, and code under test is handed one. A path that
  // reaches this instead is about to open the operator's live `~/.brane` —
  // and run the migration ladder on it — from a test run, including the one
  // `brane doctor` starts on an installed machine. Refuse loudly so the path
  // gets a `db` threaded to it rather than quietly touching real data.
  if (process.env.NODE_TEST_CONTEXT) {
    throw new Error(
      "openDatabase() called under node --test: pass the test's db (createTestDb) instead of opening ~/.brane",
    );
  }
  ensureBraneDir();
  const db = new Database(DB_PATH);
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try { chmodSync(f, 0o600); } catch {}
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(SCHEMA_SQL);
  applyMigrations(db);

  // Ensure brane_id exists
  const existing = db.prepare("SELECT value FROM meta WHERE key = 'brane_id'").get() as
    | { value: string }
    | undefined;

  if (!existing) {
    const braneId = generateBraneId();
    db.prepare("INSERT INTO meta (key, value) VALUES ('brane_id', ?)").run(braneId);
  }

  return db;
}

export function getBraneId(db: Database.Database): string {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'brane_id'").get() as {
    value: string;
  };
  return row.value;
}

/** Where a running daemon listens, or null if none is. Cleans up stale
 *  entries. For callers that need the address but no credential — a hook
 *  script carries its narrative's bind secret, never the daemon token. */
export function getDaemonAddress(db: Database.Database): { port: string; version?: string } | null {
  const portRow = db.prepare("SELECT value FROM meta WHERE key = 'daemon_port'").get() as
    | { value: string }
    | undefined;
  const pidRow = db.prepare("SELECT value FROM meta WHERE key = 'daemon_pid'").get() as
    | { value: string }
    | undefined;

  if (!portRow || !pidRow) return null;

  try {
    process.kill(parseInt(pidRow.value, 10), 0);
  } catch {
    // Process is dead — clean up stale entry
    db.prepare("DELETE FROM meta WHERE key IN ('daemon_port', 'daemon_token', 'daemon_pid', 'daemon_version', 'daemon_socket')").run();
    return null;
  }

  const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'daemon_version'").get() as
    | { value: string }
    | undefined;

  return { port: portRow.value, version: versionRow?.value };
}

export type ClaimResult =
  | { claimed: true }
  | { claimed: false; pid: number };

/**
 * Atomically claim the daemon role using an exclusive SQLite transaction.
 * Returns { claimed: true } if we won, or { claimed: false, pid } if
 * another daemon is already running.
 */
export function claimDaemon(db: Database.Database): ClaimResult {
  // BEGIN EXCLUSIVE takes a database-level lock, preventing any other
  // connection from reading or writing until we commit/rollback.
  db.exec("BEGIN EXCLUSIVE");
  try {
    const pidRow = db.prepare("SELECT value FROM meta WHERE key = 'daemon_pid'").get() as
      | { value: string }
      | undefined;

    if (pidRow) {
      const existingPid = parseInt(pidRow.value, 10);
      try {
        process.kill(existingPid, 0);
        // Process is alive — another daemon owns the role
        db.exec("ROLLBACK");
        return { claimed: false, pid: existingPid };
      } catch {
        // Process is dead — clean up stale entry and claim
        db.prepare("DELETE FROM meta WHERE key IN ('daemon_token', 'daemon_pid', 'daemon_version', 'daemon_tls', 'daemon_socket')").run();
      }
    }

    // Claim: write our PID and version. No token: the database holds only
    // token hashes, and this machine's CLI presents none.
    const version = getPackageVersion();
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('daemon_pid', ?)").run(String(process.pid));
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('daemon_version', ?)").run(version);
    db.exec("COMMIT");
    return { claimed: true };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    throw err;
  }
}

export function getDbPath(): string {
  return DB_PATH;
}

export function getBraneDir(): string {
  return BRANE_DIR;
}

/** Get (and ensure exists) the payloads directory for a narrative */
export function getPayloadsDir(narrativeId: string): string {
  const dir = join(BRANE_DIR, "payloads", narrativeId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Convert an absolute path to ~/relative if under home directory
export function toPortablePath(absolutePath: string): string {
  const home = homedir();
  if (absolutePath === home) return "~";
  if (absolutePath.startsWith(home + "/")) {
    return "~/" + absolutePath.slice(home.length + 1);
  }
  return absolutePath;
}

// Resolve a ~/relative or absolute path to an absolute path
export function fromPortablePath(portablePath: string): string {
  if (portablePath === "~") return homedir();
  if (portablePath.startsWith("~/")) {
    return join(homedir(), portablePath.slice(2));
  }
  return portablePath;
}
