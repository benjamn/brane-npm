import { defineCommand } from "citty";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/schema.js";

// Well-known config keys and their defaults
export const CONFIG_DEFAULTS: Record<string, string> = {
  app_domain: "brane.organelle.dev",
  "session-affinity.enabled": "true",
};

/** Reads a config key. Pass the caller's `db` whenever it has one: the daemon
 *  and every test do. Without it this opens `~/.brane/brane.db` itself — right
 *  for a CLI command, and exactly wrong anywhere else. That fallback is how a
 *  test that drove a mention receipt used to open the operator's live database
 *  and run the migration ladder on it, and how the daemon used to open (and
 *  never close) a fresh connection on every `listen` reply. */
export function getConfig(key: string, db?: Database.Database): string | undefined {
  const conn = db ?? openDatabase();
  try {
    const row = conn.prepare("SELECT value FROM meta WHERE key = ?").get(`config.${key}`) as
      | { value: string }
      | undefined;
    return row?.value ?? CONFIG_DEFAULTS[key];
  } finally {
    if (!db) conn.close();
  }
}

export const configCommand = defineCommand({
  meta: {
    name: "config",
    description: "Get or set brane configuration",
  },
  args: {
    key: {
      type: "positional",
      description: "Configuration key",
      required: false,
    },
    value: {
      type: "positional",
      description: "Value to set (omit to get current value)",
      required: false,
    },
    list: {
      type: "boolean",
      description: "List all configuration values",
    },
    unset: {
      type: "boolean",
      description: "Remove a configuration key",
    },
  },
  run({ args }) {
    const db = openDatabase();

    // --list: show all config
    if (args.list) {
      const rows = db
        .prepare("SELECT key, value FROM meta WHERE key LIKE 'config.%' ORDER BY key")
        .all() as Array<{ key: string; value: string }>;

      if (rows.length === 0 && Object.keys(CONFIG_DEFAULTS).length === 0) {
        console.log("No configuration set.");
        return;
      }

      // Show defaults that haven't been overridden
      const setKeys = new Set(rows.map((r) => r.key.replace(/^config\./, "")));
      for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
        if (!setKeys.has(key)) {
          console.log(`${key}=${value} (default)`);
        }
      }

      // Show explicitly set values
      for (const row of rows) {
        const key = row.key.replace(/^config\./, "");
        console.log(`${key}=${row.value}`);
      }
      return;
    }

    const key = args.key as string | undefined;

    if (!key) {
      // No key provided and no --list flag: show usage
      console.log("Usage: brane config <key> [value]");
      console.log("       brane config --list");
      console.log("       brane config --unset <key>");
      return;
    }

    // --unset: remove a key
    if (args.unset) {
      const deleted = db.prepare("DELETE FROM meta WHERE key = ?").run(`config.${key}`);
      if (deleted.changes > 0) {
        console.log(`Unset ${key}`);
      } else {
        console.log(`${key} is not set`);
      }
      return;
    }

    const value = args.value as string | undefined;

    if (value === undefined) {
      // Get
      const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(`config.${key}`) as
        | { value: string }
        | undefined;

      if (row) {
        console.log(row.value);
      } else if (CONFIG_DEFAULTS[key] !== undefined) {
        console.log(`${CONFIG_DEFAULTS[key]} (default)`);
      } else {
        // Key not found, exit silently like git config
        process.exit(1);
      }
    } else {
      // Set
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
        `config.${key}`,
        value,
      );
      console.log(`${key}=${value}`);
    }
  },
});
