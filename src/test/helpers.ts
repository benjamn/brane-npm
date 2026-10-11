import Database from "better-sqlite3";
import { SCHEMA_SQL, applyMigrations } from "../db/schema.js";

/**
 * Create a fresh in-memory database with the brane schema applied.
 * Each test gets its own isolated DB instance.
 *
 * Built the same way `openDatabase()` builds the real one — `SCHEMA_SQL` then
 * the migration ladder — so a column added by migration (cost_amount, archived,
 * …) is present here too, and tests can't pass against a shape production never
 * has.
 */
export function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  db.prepare("INSERT INTO meta (key, value) VALUES ('brane_id', 'brane-test')").run();
  return db;
}
