/**
 * The rename warning (src/daemon/verification-rename.ts): a credential is
 * bound to the host it was enrolled for, so after a rename the daemon says
 * which ones are orphaned, and the switch refuses to turn the gate on with
 * nothing that can verify.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.js";
import { DbCredentialStore } from "../db/credentials.js";
import { RP_ID_META_KEY, RenameWatch, orphanedCredentials, recordRpId, recordedRpId, renameWarning, usableCredentials } from "../daemon/verification-rename.js";
import { configSetRefusal, describeCredentials } from "../commands/config.js";

const T0 = Date.UTC(2026, 9, 29, 12);

function enrollFor(db: ReturnType<typeof createTestDb>, rpId: string, label: string): void {
  new DbCredentialStore(db).insert(
    {
      credentialId: Buffer.from(label),
      rpId,
      publicKey: Buffer.from("key"),
      alg: -7,
      transports: ["internal"],
      aaguid: "00000000-0000-0000-0000-000000000000",
      signCount: 0,
      backupEligible: true,
      backedUp: true,
      attested: false,
      attestationFmt: "none",
      attestationRoot: null,
      label,
      enrolledBy: "presence at this machine",
      enrolledVia: "tok-phone",
    },
    T0,
  );
}

describe("orphanedCredentials", () => {
  it("counts live credentials by the host they were enrolled for, other than the one served", () => {
    const live = [{ rp_id: "old.tail1234.ts.net" }, { rp_id: "old.tail1234.ts.net" }, { rp_id: "new.tail1234.ts.net" }, { rp_id: "older.tail9999.ts.net" }];
    assert.deepEqual([...orphanedCredentials(live, "new.tail1234.ts.net")], [["old.tail1234.ts.net", 2], ["older.tail9999.ts.net", 1]]);
    assert.equal(orphanedCredentials(live, "old.tail1234.ts.net").size, 2);
  });

  it("names no orphan while the host is unknown: nothing to compare against yet", () => {
    assert.equal(orphanedCredentials([{ rp_id: "old.tail1234.ts.net" }], null).size, 0);
  });
});

describe("usableCredentials", () => {
  it("counts the live credentials enrolled for the served host, and nothing while the host is unknown", () => {
    const live = [{ rp_id: "old.tail1234.ts.net" }, { rp_id: "new.tail1234.ts.net" }];
    assert.equal(usableCredentials(live, "new.tail1234.ts.net"), 1);
    assert.equal(usableCredentials(live, "other.tail1234.ts.net"), 0);
    assert.equal(usableCredentials(live, null), null);
  });
});

describe("renameWarning", () => {
  it("is silent when every credential matches", () => {
    assert.equal(renameWarning(new Map(), "mac.tail1234.ts.net", 2, "passkey"), null);
  });

  it("names the hosts and counts, and says whether anything can still verify", () => {
    const orphans = new Map([["old.tail1234.ts.net", 2]]);
    const some = renameWarning(orphans, "new.tail1234.ts.net", 1, "off")!;
    assert.match(some, /serves new\.tail1234\.ts\.net/);
    assert.match(some, /2 credential\(s\) were enrolled for another host \(2 for old\.tail1234\.ts\.net\)/);
    assert.match(some, /1 enrolled for new\.tail1234\.ts\.net still can/);
    const none = renameWarning(orphans, "new.tail1234.ts.net", 0, "off")!;
    assert.match(none, /no device can verify here/);
    assert.match(none, /brane config verification passkey/);
  });

  it("with the gate on and nothing usable, says every device is locked out and names the switch that frees them", () => {
    const orphans = new Map([["old.tail1234.ts.net", 1]]);
    const locked = renameWarning(orphans, "new.tail1234.ts.net", 0, "passkey")!;
    assert.match(locked, /every device is locked out/);
    assert.match(locked, /brane config verification off/);
    assert.match(locked, /add a credential for new\.tail1234\.ts\.net/);
    assert.doesNotMatch(locked, /refuses meanwhile/);
    // Something usable, and the mode makes no difference.
    assert.match(renameWarning(orphans, "new.tail1234.ts.net", 1, "passkey")!, /1 enrolled for new\.tail1234\.ts\.net still can/);
  });
});

describe("RenameWatch", () => {
  const orphan = { rp_id: "old.tail1234.ts.net" };
  const usable = { rp_id: "new.tail1234.ts.net" };

  it("logs a warning once, stays quiet on a reload that says the same, and speaks again when it changes", () => {
    const watch = new RenameWatch();
    assert.equal(watch.check([usable], "new.tail1234.ts.net", "off"), null, "nothing wrong, nothing logged");
    const first = watch.check([orphan], "new.tail1234.ts.net", "off");
    assert.match(first!, /1 for old\.tail1234\.ts\.net/);
    assert.equal(watch.check([orphan], "new.tail1234.ts.net", "off"), null, "the same text again: a cert reload");
    const more = watch.check([orphan, orphan], "new.tail1234.ts.net", "off");
    assert.match(more!, /2 for old\.tail1234\.ts\.net/, "the counts changed, so it is said again");
    assert.match(watch.check([orphan, orphan], "new.tail1234.ts.net", "passkey")!, /locked out/, "so did what the operator must do");
    assert.equal(watch.check([orphan, orphan, usable], "new.tail1234.ts.net", "passkey")?.includes("still can"), true);
  });

  it("warns again after the orphans were gone and came back", () => {
    const watch = new RenameWatch();
    assert.notEqual(watch.check([orphan], "new.tail1234.ts.net", "off"), null);
    assert.equal(watch.check([], "new.tail1234.ts.net", "off"), null);
    assert.notEqual(watch.check([orphan], "new.tail1234.ts.net", "off"), null);
  });
});

describe("the recorded host", () => {
  it("is written when known and kept when not: the last host served stands", () => {
    const db = createTestDb();
    assert.equal(recordedRpId(db), null);
    recordRpId(db, "mac.tail1234.ts.net");
    assert.equal(recordedRpId(db), "mac.tail1234.ts.net");
    recordRpId(db, null);
    assert.equal(recordedRpId(db), "mac.tail1234.ts.net");
    assert.equal((db.prepare("SELECT value FROM meta WHERE key = ?").get(RP_ID_META_KEY) as { value: string }).value, "mac.tail1234.ts.net");
  });
});

describe("brane config verification passkey after a rename", () => {
  it("refuses when no live credential matches the host the daemon serves, and says why", () => {
    const db = createTestDb();
    enrollFor(db, "old.tail1234.ts.net", "Passkey from Safari on iPhone");
    assert.equal(configSetRefusal("verification", "passkey", db), null, "the host is unknown, so the credential counts");
    recordRpId(db, "new.tail1234.ts.net");
    const refused = configSetRefusal("verification", "passkey", db)!;
    assert.match(refused, /enrolled for old\.tail1234\.ts\.net/);
    assert.match(refused, /serves new\.tail1234\.ts\.net/);
    assert.match(refused, /lock every device out/);
    // A credential for the new host, and the switch is allowed again.
    enrollFor(db, "new.tail1234.ts.net", "Passkey from Chrome on Mac");
    assert.equal(configSetRefusal("verification", "passkey", db), null);
    // Turning it off is never refused.
    assert.equal(configSetRefusal("verification", "off", db), null);
  });

  it("marks each orphaned credential in the list the switch prints", () => {
    const db = createTestDb();
    enrollFor(db, "old.tail1234.ts.net", "Passkey from Safari on iPhone");
    enrollFor(db, "new.tail1234.ts.net", "Passkey from Chrome on Mac");
    recordRpId(db, "new.tail1234.ts.net");
    const lines = describeCredentials(db);
    assert.match(lines[0], /1 credential\(s\) will be able to verify a device/, "the orphan is not counted");
    // Each credential is a block of lines; the orphan's ends with the note.
    const block = (label: string) => {
      const i = lines.findIndex((l) => l.includes(label));
      const next = lines.findIndex((l, j) => j > i && /^  \S/.test(l));
      return lines.slice(i, next === -1 ? lines.length - 1 : next).join("\n");
    };
    assert.match(block("Passkey from Safari on iPhone"), /! enrolled for old\.tail1234\.ts\.net, not this daemon's new\.tail1234\.ts\.net: cannot verify here/);
    assert.doesNotMatch(block("Passkey from Chrome on Mac"), /cannot verify here/);
  });
});
