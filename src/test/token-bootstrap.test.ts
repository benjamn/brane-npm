/**
 * `bootstrapTokens` brings an install to "hashes only, and none for this
 * machine" at daemon start. Two properties matter most, and an operator would
 * notice either: upgrading signs no device out (the pre-hashing shared token
 * is adopted as a device row), and afterwards this machine holds no token at
 * all — the local token an older brane kept in `.daemon_token` is revoked,
 * the file emptied, and the CLI acts as an account row no token can open.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { SCHEMA_SQL, applyMigrations, getDaemonAddress } from "../db/schema.js";
import { resolveCredential } from "../daemon/client.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "./helpers.js";
import {
  ACCOUNT_HASH_PREFIX,
  bootstrapTokens,
  DbTokenStore,
  isTokenHash,
  LEGACY_TOKEN_LABEL,
  legacyTokenWarning,
  recordLauncher,
  tokenFileStanding,
} from "../db/tokens.js";
import { TokenRing, hashToken, ROTATED_LEGACY_LABEL } from "../daemon/token-ring.js";

function setup() {
  const db = createTestDb();
  const tokenFile = join(mkdtempSync(join(tmpdir(), "brane-tokens-")), ".daemon_token");
  const queue = ["mint-1", "mint-2", "mint-3"];
  const mint = () => queue.shift()!;
  return { db, tokenFile, mint };
}

const plaintextAnywhere = (db: ReturnType<typeof createTestDb>, token: string) =>
  JSON.stringify(db.prepare("SELECT * FROM tokens").all()).includes(token) ||
  JSON.stringify(db.prepare("SELECT * FROM meta").all()).includes(token);

const liveLocals = (db: ReturnType<typeof createTestDb>) =>
  db.prepare("SELECT id, hash, label FROM tokens WHERE kind = 'local' AND revoked_at IS NULL").all() as Array<{
    id: string;
    hash: string;
    label: string;
  }>;

describe("bootstrapTokens", () => {
  it("adopts the pre-hashing token as a device, so every melded device keeps working", () => {
    const { db, tokenFile, mint } = setup();
    db.prepare("INSERT INTO meta (key, value) VALUES ('daemon_token', 'legacy')").run();
    writeFileSync(tokenFile, "legacy\n", { mode: 0o644 });

    const boot = bootstrapTokens(db, { tokenFile, mint });

    assert.deepEqual(boot, { adopted: [LEGACY_TOKEN_LABEL], retiredLocal: 0, tokenFile: "emptied" });
    const ring = new TokenRing(new DbTokenStore(db), mint);
    const legacy = ring.authenticate("legacy");
    assert.ok(legacy.ok);
    assert.equal(legacy.record.kind, "device");
    const account = ring.authenticateAccount();
    assert.ok(account.ok);
    assert.equal(account.record.kind, "local");
  });

  it("leaves no plaintext behind: not in meta, not in the table, not in the file", () => {
    const { db, tokenFile, mint } = setup();
    db.prepare("INSERT INTO meta (key, value) VALUES ('daemon_token', 'legacy')").run();
    writeFileSync(tokenFile, "legacy\n", { mode: 0o644 });

    bootstrapTokens(db, { tokenFile, mint });

    assert.equal(plaintextAnywhere(db, "legacy"), false);
    // Emptied, not removed: removing it is the operator's to do.
    assert.equal(readFileSync(tokenFile, "utf-8"), "");
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  });

  it("is idempotent once migrated, and never creates the file", () => {
    const { db, tokenFile, mint } = setup();
    assert.deepEqual(bootstrapTokens(db, { tokenFile, mint }), { adopted: [], retiredLocal: 0, tokenFile: "absent" });
    const [account] = liveLocals(db);
    const second = bootstrapTokens(db, { tokenFile, mint });
    assert.deepEqual(second, { adopted: [], retiredLocal: 0, tokenFile: "absent" });
    assert.deepEqual(liveLocals(db), [account], "the same account row, so what it minted stays its own");
    assert.equal(existsSync(tokenFile), false);
  });

  it("never re-adopts a revoked token, from a stale file or a stale --token", () => {
    const { db, tokenFile, mint } = setup();
    writeFileSync(tokenFile, "legacy\n");
    bootstrapTokens(db, { tokenFile, mint });
    const store = new DbTokenStore(db);
    const legacy = store.find(hashToken("legacy"), 0)!;
    store.revoke([legacy.id], 1);

    writeFileSync(tokenFile, "legacy\n");
    const boot = bootstrapTokens(db, { tokenFile, configured: "legacy", mint });

    assert.deepEqual(boot.adopted, []);
    assert.equal(new TokenRing(store, mint).authenticate("legacy").ok, false);
    assert.deepEqual(liveLocals(db).map((r) => r.label), ["this machine"]);
    assert.equal(readFileSync(tokenFile, "utf-8"), "", "and the stale file is emptied again");
  });

  it("adopts a configured --token as a device", () => {
    const { db, tokenFile, mint } = setup();
    const boot = bootstrapTokens(db, { tokenFile, configured: "from-flag", mint });
    assert.deepEqual(boot.adopted, ["configured with --token"]);
    const a = new TokenRing(new DbTokenStore(db), mint).authenticate("from-flag");
    assert.ok(a.ok);
    assert.equal(a.record.kind, "device");
  });
});

describe("retiring the local token", () => {
  /** An install as the previous brane left it: a `local` row whose token is
   *  in `.daemon_token`, and a device that row minted with `brane meld`. */
  function previous() {
    const s = setup();
    const store = new DbTokenStore(s.db);
    const oldLocal = store.insert(hashToken("old-local"), "local", "this machine", 10);
    const phone = store.insert(hashToken("phone"), "device", "phone", 11, { used: true, mintedBy: oldLocal.id });
    s.db.prepare("INSERT INTO narratives (id, brane_id, agent_type, created_at, status) VALUES ('claude-shell001', 'b', 'claude', 12, 'active')").run();
    recordLauncher(s.db, "claude-shell001", oldLocal.id);
    writeFileSync(s.tokenFile, "old-local\n", { mode: 0o600 });
    return { ...s, store, oldLocal, phone };
  }

  it("revokes the token the file held, empties the file, and keeps the account", () => {
    const { db, tokenFile, mint, store, oldLocal, phone } = previous();

    const boot = bootstrapTokens(db, { tokenFile, mint, now: 20 });

    assert.deepEqual(boot, { adopted: [], retiredLocal: 1, tokenFile: "emptied" });
    const ring = new TokenRing(store, mint);
    assert.deepEqual(ring.authenticate("old-local", 21), { ok: false }, "a copy of the old file opens nothing");
    assert.equal(readFileSync(tokenFile, "utf-8"), "");
    const account = ring.authenticateAccount(21);
    assert.ok(account.ok);
    assert.notEqual(account.record.id, oldLocal.id);
    assert.equal(ring.authenticate("phone", 21).ok, true, "no device is signed out");
    assert.equal(store.get(phone.id)?.minted_by, account.record.id, "still added by this machine");
    assert.deepEqual(
      store.launched().get(account.record.id)?.map((a) => a.id),
      ["claude-shell001"],
      "and what the shell spawned is still listed under it",
    );
    // Revoked, never deleted: its hash stays known, so an older brane started
    // later cannot adopt the same token as a device.
    assert.equal(store.known(hashToken("old-local")), true);
    assert.deepEqual(bootstrapTokens(db, { tokenFile, mint, now: 30 }), { adopted: [], retiredLocal: 0, tokenFile: "absent" });
  });

  it("carries over what an earlier, already revoked local row launched and minted", () => {
    // A shell `brane token rotate` on an older brane replaced the local row
    // and moved what it had minted, but never what it had launched.
    const { db, tokenFile, mint, store, oldLocal } = previous();
    const before = store.insert(hashToken("local-before-rotate"), "local", "this machine", 1);
    store.revoke([before.id], 5);
    const tablet = store.insert(hashToken("tablet"), "device", "tablet", 6, { used: true, mintedBy: before.id });
    db.prepare("INSERT INTO narratives (id, brane_id, agent_type, created_at, status) VALUES ('claude-shell000', 'b', 'claude', 2, 'active')").run();
    recordLauncher(db, "claude-shell000", before.id);

    bootstrapTokens(db, { tokenFile, mint, now: 20 });

    const [account] = liveLocals(db);
    assert.notEqual(account.id, oldLocal.id);
    assert.equal(store.get(tablet.id)?.minted_by, account.id);
    assert.deepEqual(
      store.launched().get(account.id)?.map((a) => a.id).sort(),
      ["claude-shell000", "claude-shell001"],
    );
  });

  it("survives an older daemon started in between, which puts a local token back", () => {
    const { db, tokenFile, mint, store, phone } = previous();
    bootstrapTokens(db, { tokenFile, mint, now: 20 });
    const [first] = liveLocals(db);
    // What the previous brane's start does: one live local row, opened by a
    // token it writes to the file.
    store.revoke([first.id], 30);
    store.insert(hashToken("local-again"), "local", "this machine", 30);
    writeFileSync(tokenFile, "local-again\n", { mode: 0o600 });

    const boot = bootstrapTokens(db, { tokenFile, mint, now: 40 });

    assert.deepEqual(boot, { adopted: [], retiredLocal: 1, tokenFile: "emptied" });
    const ring = new TokenRing(store, mint);
    assert.deepEqual(ring.authenticate("local-again", 41), { ok: false });
    const [account] = liveLocals(db);
    assert.notEqual(account.id, first.id);
    assert.equal(isTokenHash(account.hash), false);
    assert.equal(store.get(phone.id)?.minted_by, account.id, "lineage follows through the row revoked in between");
    assert.deepEqual(store.launched().get(account.id)?.map((a) => a.id), ["claude-shell001"]);
  });

  it("retires a local token even when its file is gone", () => {
    const { db, mint, store } = previous();
    const elsewhere = join(mkdtempSync(join(tmpdir(), "brane-tokens-")), ".daemon_token");
    const boot = bootstrapTokens(db, { tokenFile: elsewhere, mint, now: 20 });
    assert.deepEqual(boot, { adopted: [], retiredLocal: 1, tokenFile: "absent" });
    assert.deepEqual(new TokenRing(store, mint).authenticate("old-local", 21), { ok: false });
  });

  it("gives the account a row no token can open", () => {
    const { db, tokenFile, mint } = setup();
    bootstrapTokens(db, { tokenFile, mint });
    const [account] = liveLocals(db);
    assert.equal(account.hash, `${ACCOUNT_HASH_PREFIX}mint-1`);
    assert.equal(isTokenHash(account.hash), false);
    assert.equal(isTokenHash(hashToken("anything")), true);
    const ring = new TokenRing(new DbTokenStore(db), mint);
    for (const guess of ["mint-1", account.hash, account.id, ""]) {
      assert.deepEqual(ring.authenticate(guess), { ok: false }, `"${guess}" opens nothing`);
    }
  });

  it("reports a file it could not empty, and still retires the token", { skip: process.getuid?.() === 0 && "root can write anything" }, () => {
    const { db, tokenFile, mint, store } = previous();
    chmodSync(tokenFile, 0o400);
    const boot = bootstrapTokens(db, { tokenFile, mint, now: 20 });
    assert.equal(boot.retiredLocal, 1);
    assert.ok(typeof boot.tokenFile === "object" && /EACCES|EPERM/.test(boot.tokenFile.error));
    assert.deepEqual(new TokenRing(store, mint).authenticate("old-local", 21), { ok: false });
    // What `brane doctor` then says about the token still sitting there.
    assert.equal(tokenFileStanding(db, "old-local"), "dead");
    assert.equal(tokenFileStanding(db, "phone"), "live");
  });
});

describe("legacyTokenWarning", () => {
  it("speaks while the pre-hashing token is live, and stops once a rotation retires it", () => {
    const { db, tokenFile, mint } = setup();
    assert.equal(legacyTokenWarning(db), null);
    writeFileSync(tokenFile, "legacy\n");
    bootstrapTokens(db, { tokenFile, mint });
    assert.match(legacyTokenWarning(db) ?? "", /Sign out other devices/);

    const ring = new TokenRing(new DbTokenStore(db), () => "rotated");
    const legacy = ring.authenticate("legacy");
    assert.ok(legacy.ok);
    ring.beginRotation(legacy.record);
    const rotated = ring.authenticate("rotated");
    assert.ok(rotated.ok);
    assert.equal(legacyTokenWarning(db), null);
    // The replacement was minted just now, so it must not keep a label that
    // says it was melded before hashing.
    assert.equal(rotated.record.label, ROTATED_LEGACY_LABEL);
  });
});

// File-backed, because the claims these pin are about bytes on disk: what a
// copied ~/.brane holds.
function fileDb() {
  const dir = mkdtempSync(join(tmpdir(), "brane-tokens-file-"));
  const db = new Database(join(dir, "brane.db"));
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  db.prepare("INSERT INTO meta (key, value) VALUES ('brane_id', 'brane-test')").run();
  return { db, dir, tokenFile: join(dir, ".daemon_token") };
}

describe("hashed tokens on disk", () => {
  it("leaves the pre-hashing token's bytes in no file of the brane dir, the token file included", () => {
    const { db, dir, tokenFile } = fileDb();
    const secret = "legacy-0b7e1c52-secret";
    db.prepare("INSERT INTO meta (key, value) VALUES ('daemon_token', ?)").run(secret);
    writeFileSync(tokenFile, secret + "\n");

    bootstrapTokens(db, { tokenFile });
    db.close();

    for (const name of readdirSync(dir)) {
      assert.equal(readFileSync(join(dir, name)).includes(secret), false, `${name} still holds the old token`);
    }
  });

  it("leaves a retired local token's bytes in no file either", () => {
    const { db, dir, tokenFile } = fileDb();
    const secret = "local-5d1f0c9a-secret";
    new DbTokenStore(db).insert(hashToken(secret), "local", "this machine", 1);
    writeFileSync(tokenFile, secret + "\n");

    bootstrapTokens(db, { tokenFile });
    db.close();

    for (const name of readdirSync(dir)) {
      assert.equal(readFileSync(join(dir, name)).includes(secret), false, `${name} still holds the local token`);
    }
  });

  it("finding the daemon needs no token, and outside a session neither does talking to it", () => {
    const { db, tokenFile } = fileDb();
    db.prepare("INSERT INTO meta (key, value) VALUES ('daemon_port', '4000'), ('daemon_pid', ?)").run(String(process.pid));
    assert.deepEqual(getDaemonAddress(db), { port: "4000", version: undefined });
    assert.equal(resolveCredential({}), null);
    // A file an older brane left is not read: what it holds is never presented.
    writeFileSync(tokenFile, "local-token\n");
    assert.equal(resolveCredential({}), null);
  });

  it("an agent session presents its own token", () => {
    assert.equal(resolveCredential({ BRANE_NARRATIVE_SECRET: "agent-secret" }), "agent-secret");
  });
});

describe("adopted tokens are marked by origin, not by label", () => {
  it("still warns after the legacy device is renamed", () => {
    const { db, tokenFile, mint } = setup();
    writeFileSync(tokenFile, "legacy\n");
    bootstrapTokens(db, { tokenFile, mint });
    db.prepare("UPDATE tokens SET label = 'my phone' WHERE label = ?").run(LEGACY_TOKEN_LABEL);
    assert.notEqual(legacyTokenWarning(db), null);
  });

  it("warns for a --token too, which older daemons logged the same way", () => {
    const { db, tokenFile, mint } = setup();
    bootstrapTokens(db, { tokenFile, configured: "from-flag", mint });
    assert.notEqual(legacyTokenWarning(db), null);
  });
});

describe("bootstrapTokens where no token file could be written", () => {
  it("has nothing to write, so the daemon starts all the same", () => {
    const { db, mint } = setup();
    const dir = join(tmpdir(), "brane-no-such-dir-" + process.pid);
    const tokenFile = join(dir, "nested", ".daemon_token");
    assert.deepEqual(bootstrapTokens(db, { tokenFile, mint }), { adopted: [], retiredLocal: 0, tokenFile: "absent" });
    assert.equal(existsSync(dir), false);
  });
});
