import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.js";
import { getConfig } from "../commands/config.js";
import { openDatabase } from "../db/schema.js";

// Test the config logic directly against the meta table,
// since the config command's run() relies on openDatabase()
// which opens the real ~/.brane/brane.db.

describe("config storage", () => {
  it("stores and retrieves a config value", () => {
    const db = createTestDb();

    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      "config.app_domain",
      "my.domain.dev",
    );

    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get("config.app_domain") as
      | { value: string }
      | undefined;
    assert.equal(row?.value, "my.domain.dev");
  });

  it("overwrites an existing config value", () => {
    const db = createTestDb();

    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      "config.app_domain",
      "old.domain.dev",
    );
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      "config.app_domain",
      "new.domain.dev",
    );

    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get("config.app_domain") as {
      value: string;
    };
    assert.equal(row.value, "new.domain.dev");
  });

  it("deletes a config value", () => {
    const db = createTestDb();

    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
      "config.app_domain",
      "test.dev",
    );
    const result = db.prepare("DELETE FROM meta WHERE key = ?").run("config.app_domain");
    assert.equal(result.changes, 1);

    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get("config.app_domain");
    assert.equal(row, undefined);
  });

  it("lists config values with config. prefix", () => {
    const db = createTestDb();

    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
      "config.app_domain",
      "test.dev",
    );
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("config.theme", "dark");
    // This is NOT a config key
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("daemon_pid", "12345");

    const rows = db
      .prepare("SELECT key, value FROM meta WHERE key LIKE 'config.%' ORDER BY key")
      .all() as Array<{ key: string; value: string }>;

    assert.equal(rows.length, 2);
    assert.equal(rows[0].key, "config.app_domain");
    assert.equal(rows[1].key, "config.theme");
  });

  it("config keys don't collide with daemon state", () => {
    const db = createTestDb();

    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("daemon_port", "7890");
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("config.port", "8080");

    const daemonPort = db.prepare("SELECT value FROM meta WHERE key = 'daemon_port'").get() as {
      value: string;
    };
    const configPort = db.prepare("SELECT value FROM meta WHERE key = 'config.port'").get() as {
      value: string;
    };

    assert.equal(daemonPort.value, "7890");
    assert.equal(configPort.value, "8080");
  });
});

describe("the suite never opens ~/.brane", () => {
  it("getConfig reads the db it is handed", () => {
    const db = createTestDb();
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("config.mentions.receipt_limit", "3");
    assert.equal(getConfig("mentions.receipt_limit", db), "3");
    // Unset keys still fall back to the defaults table.
    assert.equal(getConfig("app_domain", db), "brane.organelle.dev");
  });

  it("openDatabase() refuses under node --test", () => {
    // The backstop: a path with no db threaded to it fails the test that
    // reached it, instead of opening the operator's live database (and running
    // migrations on it) from a test run — `brane doctor`'s included.
    assert.ok(process.env.NODE_TEST_CONTEXT, "node --test sets NODE_TEST_CONTEXT in each test process");
    assert.throws(() => openDatabase(), /under node --test/);
    assert.throws(() => getConfig("app_domain"), /under node --test/);
  });
});
