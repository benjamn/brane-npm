import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { ensureInstallFold, wikiFoldLabels } from "../daemon/server.js";
import { toPortablePath } from "../db/schema.js";

function foldsDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE folds (
    path TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_spawned INTEGER,
    archived INTEGER DEFAULT 0,
    brane_id TEXT
  )`);
  return db;
}

describe("ensureInstallFold", () => {
  it("registers the install directory once, in the given brane, and never rewrites it", () => {
    const db = foldsDb();
    const dir = mkdtempSync(join(tmpdir(), "brane-install-"));
    const first = ensureInstallFold(db, dir, () => "brane-home");
    assert.equal(first, toPortablePath(dir));
    const row = db.prepare("SELECT brane_id, archived FROM folds WHERE path = ?").get(first) as {
      brane_id: string;
      archived: number;
    };
    assert.equal(row.brane_id, "brane-home");
    assert.equal(row.archived, 0);

    // An operator's later changes to the row survive restarts.
    db.prepare("UPDATE folds SET archived = 1, brane_id = 'brane-other' WHERE path = ?").run(first);
    let called = 0;
    const second = ensureInstallFold(db, dir, () => {
      called++;
      return "brane-home";
    });
    assert.equal(second, first);
    assert.equal(called, 0, "brane resolution is not consulted for an existing row");
    const after = db.prepare("SELECT brane_id, archived FROM folds WHERE path = ?").get(first) as {
      brane_id: string;
      archived: number;
    };
    assert.deepEqual(after, { brane_id: "brane-other", archived: 1 });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM folds").get() as { n: number }).n, 1);
  });
});

describe("wikiFoldLabels", () => {
  it("labels folds by basename and disambiguates collisions in registration order", () => {
    const db = foldsDb();
    const root = mkdtempSync(join(tmpdir(), "brane-labels-"));
    const a = join(root, "one", "brane");
    const b = join(root, "two", "brane");
    const c = join(root, "personal");
    const ins = db.prepare("INSERT INTO folds (path, created_at, brane_id) VALUES (?, ?, 'x')");
    ins.run(toPortablePath(b), 20); // registered second, despite sorting first by path
    ins.run(toPortablePath(a), 10);
    ins.run(toPortablePath(c), 30);
    const labels = wikiFoldLabels(db);
    assert.equal(labels.get(a), "brane");
    assert.equal(labels.get(b), "brane~2");
    assert.equal(labels.get(c), "personal");
    // Labels are unique across the map.
    assert.equal(new Set(labels.values()).size, labels.size);
  });

  it("lets the install fold claim its basename ahead of an older fold with the same name", () => {
    const db = foldsDb();
    const root = mkdtempSync(join(tmpdir(), "brane-labels-"));
    const older = join(root, "archive", "brane");
    const install = join(root, "dev", "brane");
    const ins = db.prepare("INSERT INTO folds (path, created_at, brane_id, archived) VALUES (?, ?, 'x', ?)");
    ins.run(toPortablePath(older), 10, 1);
    ins.run(toPortablePath(install), 20, 0);
    // Registration order alone would hand the archived port the bare name.
    assert.equal(wikiFoldLabels(db).get(install), "brane~2");
    const labels = wikiFoldLabels(db, install);
    assert.equal(labels.get(install), "brane");
    assert.equal(labels.get(older), "brane~2");
    // Naming a fold that isn't registered changes nothing.
    assert.equal(wikiFoldLabels(db, join(root, "nowhere")).get(install), "brane~2");
  });

  it("never hands a fold the reserved 'protocols' label", () => {
    const db = foldsDb();
    const root = mkdtempSync(join(tmpdir(), "brane-labels-"));
    const p = join(root, "protocols");
    db.prepare("INSERT INTO folds (path, created_at, brane_id) VALUES (?, ?, 'x')").run(toPortablePath(p), 1);
    assert.equal(wikiFoldLabels(db).get(p), "protocols~2");
  });
});
