import { defineCommand } from "citty";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/schema.js";
import { cleanAppHost } from "../shared/app-origin.js";
import { configValueRefusal } from "../daemon/verification-gate.js";
import { DbCredentialStore } from "../db/credentials.js";

// Well-known config keys and their defaults
export const CONFIG_DEFAULTS: Record<string, string> = {
  // The hostname that serves the shared app: where `brane meld` points a QR
  // unless `--app` says otherwise, and what `GET /api/status` reports so a
  // daemon's own bundle knows where Isolate hops out to. Never a trust
  // decision: the daemon accepts any origin (SECURITY.md, Authentication).
  // A fork changes this one line, and its daemons point at its own shell.
  app_domain: "brane.organelle.dev",
  "session-affinity.enabled": "true",
  // Operator verification (docs/passkeys.md). `off` until a credential is
  // enrolled, which phase 3 builds; the gate module validates these.
  verification: "off",
  "verification.window": "10",
  "verification.fresh": "mint,mcp-dial,enroll,revoke-credential",
};

/** The shared app's host from a configured or given `app_domain` value,
 *  reduced to a host (`cleanAppHost`); a blank one means the default, so
 *  `brane config app_domain ""` or `brane meld --app ""` can never make a QR
 *  for `https:///`. Every reader applies this one rule — `brane meld`
 *  (`buildMeldUrl`) and `GET /api/status` (`statusAppDomain`) — so a daemon's
 *  bundle and the QR always agree on where the shared app is. Lives here,
 *  beside the default it falls back to, so the daemon need not import the
 *  meld command to read it. */
export function resolveAppHost(value: string | null | undefined): string {
  return cleanAppHost(value ?? "") || cleanAppHost(CONFIG_DEFAULTS.app_domain);
}

/** Why `brane config <key> <value>` is refused, or null. Only the
 *  `verification*` keys are validated: a wrong value there would lock every
 *  device out or loosen the gate. */
export function configSetRefusal(key: string, value: string, db?: Database.Database): string | null {
  if (!key.startsWith("verification")) return null;
  const credentials = db ? new DbCredentialStore(db).count() : 0;
  return configValueRefusal(key, value, { credentials });
}

/** What switching the gate on will trust, printed before it flips: every
 *  credential that can verify, how it was admitted, and from which device,
 *  so a key nobody remembers enrolling is seen before it counts
 *  (claude-vxnhxcg9:25, :26). */
export function describeCredentials(db: Database.Database): string[] {
  const list = new DbCredentialStore(db).list();
  const lines = [`${list.length} credential(s) will be able to verify a device:`];
  for (const c of list) {
    const via = c.enrolled_via ? `, from token ${c.enrolled_via}` : "";
    lines.push(`  ${c.id}  ${c.label}  [${c.attested ? "attested" : "unattested"}, aaguid ${c.aaguid ?? "?"}]`);
    lines.push(`      enrolled ${new Date(c.enrolled_at).toISOString()} by ${c.enrolled_by}${via}`);
  }
  lines.push("Revoke any you do not recognise before relying on the gate (POST /api/credentials/:id/revoke).");
  return lines;
}

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
      const refused = configSetRefusal(key, value, db);
      if (refused) {
        console.error(refused);
        process.exit(1);
      }
      if (key === "verification" && value !== "off") for (const line of describeCredentials(db)) console.log(line);
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
        `config.${key}`,
        value,
      );
      console.log(`${key}=${value}`);
    }
  },
});
