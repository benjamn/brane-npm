/**
 * Archived branes (src/db/branes.ts) and a device signing itself out
 * (`forgetSelfRoute`), the two daemon halves of the switcher's archive menus.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import { createTestDb } from "./helpers.js";
import { archivedBraneIds, braneArchiveRefusal, setBraneArchived, visibleUnscopedClause } from "../db/branes.js";
import { DbTokenStore } from "../db/tokens.js";
import { TokenRing, hashToken } from "../daemon/token-ring.js";
import { forgetSelfRoute } from "../daemon/token-routes.js";

const HOME = "brane-home";

function addNarrative(db: Database.Database, id: string, braneId: string, status: string): void {
  db.prepare("INSERT INTO narratives (id, brane_id, created_at, status) VALUES (?, ?, ?, ?)").run(id, braneId, 1, status);
}

function setup() {
  const db = createTestDb();
  addNarrative(db, "claude-h1", HOME, "ended");
  addNarrative(db, "claude-a1", "brane-absorbed", "ended");
  addNarrative(db, "claude-a2", "brane-absorbed", "active");
  addNarrative(db, "claude-a3", "brane-absorbed", "ended");
  addNarrative(db, "claude-o1", "brane-other", "ended");
  return db;
}

function unscoped(db: Database.Database, connected: string[] = []): string[] {
  const v = visibleUnscopedClause(connected);
  return (db.prepare(`SELECT id FROM narratives WHERE ${v.sql} ORDER BY id`).all(...v.params) as Array<{ id: string }>).map((r) => r.id);
}

describe("archiving a brane", () => {
  it("is refused for the home brane", () => {
    const db = setup();
    assert.equal(braneArchiveRefusal(db, HOME, true, HOME)?.status, 400);
    assert.match(braneArchiveRefusal(db, HOME, true, HOME)!.error, /home brane/);
  });

  it("is refused for the last brane not already archived, even when that is not the home brane", () => {
    const db = createTestDb();
    addNarrative(db, "claude-x", "brane-only", "ended");
    const refusal = braneArchiveRefusal(db, "brane-only", true, HOME);
    assert.equal(refusal?.status, 400);
    assert.match(refusal!.error, /last brane/);

    const db2 = setup();
    // Home can't be archived, so "last" is reached by archiving the others.
    assert.equal(braneArchiveRefusal(db2, "brane-absorbed", true, HOME), null);
    setBraneArchived(db2, "brane-absorbed", true);
    setBraneArchived(db2, "brane-other", true);
    assert.equal(braneArchiveRefusal(db2, HOME, true, "brane-elsewhere")?.status, 400);
    assert.match(braneArchiveRefusal(db2, HOME, true, "brane-elsewhere")!.error, /last brane/);
  });

  it("is 404 for a brane with no narratives, either way", () => {
    const db = setup();
    assert.equal(braneArchiveRefusal(db, "brane-nope", true, HOME)?.status, 404);
    assert.equal(braneArchiveRefusal(db, "brane-nope", false, HOME)?.status, 404);
  });

  it("is undone by unarchiving, which is never refused for a brane that exists", () => {
    const db = setup();
    setBraneArchived(db, "brane-other", true, 5);
    assert.deepEqual([...archivedBraneIds(db)], ["brane-other"]);
    assert.equal(braneArchiveRefusal(db, "brane-other", false, HOME), null);
    setBraneArchived(db, "brane-other", false, 6);
    assert.deepEqual([...archivedBraneIds(db)], []);
    // The row is kept, flag cleared: never deleted.
    assert.deepEqual(db.prepare("SELECT * FROM branes").all(), [{ brane_id: "brane-other", archived: 0, archived_at: null }]);
  });
});

describe("listings that name no brane", () => {
  it("leave out an archived brane's ended narratives and keep its running ones", () => {
    const db = setup();
    assert.deepEqual(unscoped(db), ["claude-a1", "claude-a2", "claude-a3", "claude-h1", "claude-o1"]);
    setBraneArchived(db, "brane-absorbed", true);
    assert.deepEqual(unscoped(db), ["claude-a2", "claude-h1", "claude-o1"]);
  });

  it("keep a narrative whose agent is on the bridge, whatever its row says", () => {
    const db = setup();
    setBraneArchived(db, "brane-absorbed", true);
    assert.deepEqual(unscoped(db, ["claude-a3"]), ["claude-a2", "claude-a3", "claude-h1", "claude-o1"]);
  });

  it("qualify their columns when given an alias", () => {
    const v = visibleUnscopedClause(["claude-a3"], "n");
    assert.match(v.sql, /^\(n\.brane_id NOT IN .* OR n\.status IS NOT 'ended' OR n\.id IN \(\?\)\)$/);
  });
});

describe("a device signing itself out", () => {
  function tokens() {
    const db = createTestDb();
    const store = new DbTokenStore(db);
    const ring = new TokenRing(store, () => "unexpected-mint");
    const local = store.insert(hashToken("local"), "local", "this machine", 1);
    const phone = store.insert(hashToken("phone"), "device", "phone", 2);
    const laptop = store.insert(hashToken("laptop"), "device", "laptop", 3);
    return { store, ring, local, phone, laptop };
  }

  it("revokes its own token and leaves the others", () => {
    const { store, ring, phone, laptop } = tokens();
    const answer = forgetSelfRoute(store, ring, phone, 10);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.status === 200 && answer.body.ids, [phone.id]);
    assert.equal(store.get(phone.id), null);
    assert.ok(store.get(laptop.id));
  });

  it("is refused for this machine's account, which holds no token", () => {
    const { store, ring, local } = tokens();
    const answer = forgetSelfRoute(store, ring, local, 10);
    assert.equal(answer.status, 400);
    assert.ok(store.get(local.id));
  });
});
