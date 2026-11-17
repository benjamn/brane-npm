/**
 * The app's side of the verification gate, as pure decisions
 * (src/shared/verification-hop.ts): which responses open the lock sheet,
 * where a same-tab hop goes, and when backgrounding ends the window.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { noCredentialCanVerify, proofName, sameTabHopUrl, shouldEndOnHide, verificationRefusal, verifiedPerStatus } from "../shared/verification-hop.js";

describe("verificationRefusal", () => {
  it("is the gate's 403 and nothing else", () => {
    assert.equal(verificationRefusal(403, { error: "x", verification: "required" }), "required");
    assert.equal(verificationRefusal(403, { error: "x", verification: "fresh" }), "fresh");
    assert.equal(verificationRefusal(403, { error: "x", presence: "canceled" }), null, "the presence gate's refusal is not one");
    assert.equal(verificationRefusal(403, { error: "agents may not" }), null);
    assert.equal(verificationRefusal(401, { verification: "required" }), null, "401 is a dead token, never this");
    assert.equal(verificationRefusal(403, null), null);
    assert.equal(verificationRefusal(403, { verification: "later" }), null);
  });
});

describe("sameTabHopUrl", () => {
  it("adds the way back to the fragment, beside the approval", () => {
    const page = "https://mac.tail0000.ts.net:47443/verify#approval=abc&purpose=verify";
    const url = new URL(sameTabHopUrl(page, "https://brane.organelle.dev/claude-x?tab=terminal"));
    assert.equal(url.search, "");
    const frag = new URLSearchParams(url.hash.slice(1));
    assert.equal(frag.get("approval"), "abc");
    assert.equal(frag.get("return"), "https://brane.organelle.dev/claude-x?tab=terminal");
  });

  it("offers no way back to anything but a web page", () => {
    const page = "https://h/verify#approval=abc";
    assert.equal(sameTabHopUrl(page, "javascript:alert(1)"), page);
  });
});

describe("shouldEndOnHide", () => {
  const now = 1_000_000;
  it("ends a live window when the app goes to the background", () => {
    assert.equal(shouldEndOnHide({ mode: "passkey", verifiedUntil: now + 1, hopping: false, now }), true);
  });
  it("never mid-hop: the request could land after the proof it would cancel", () => {
    assert.equal(shouldEndOnHide({ mode: "passkey", verifiedUntil: now + 1, hopping: true, now }), false);
  });
  it("not with the gate off, unknown, or the window already over", () => {
    assert.equal(shouldEndOnHide({ mode: "off", verifiedUntil: now + 1, hopping: false, now }), false);
    assert.equal(shouldEndOnHide({ mode: null, verifiedUntil: now + 1, hopping: false, now }), false);
    assert.equal(shouldEndOnHide({ mode: "passkey", verifiedUntil: now, hopping: false, now }), false);
    assert.equal(shouldEndOnHide({ mode: "passkey", verifiedUntil: null, hopping: false, now }), false);
  });
});

describe("verifiedPerStatus", () => {
  const now = 1_000_000;
  it("reads the device's own window, and treats an absent or off gate as verified", () => {
    assert.equal(verifiedPerStatus({ verification: { mode: "passkey", verified_until: now + 1 } }, now), true);
    assert.equal(verifiedPerStatus({ verification: { mode: "passkey", verified_until: now } }, now), false);
    assert.equal(verifiedPerStatus({ verification: { mode: "passkey", verified_until: null } }, now), false);
    assert.equal(verifiedPerStatus({ verification: { mode: "off" } }, now), true);
    assert.equal(verifiedPerStatus({}, now), true);
  });
});


describe("noCredentialCanVerify", () => {
  it("names the rename, and the switch from the shell, when the gate is on and nothing enrolled matches the host", () => {
    const renamed = noCredentialCanVerify({ mode: "passkey", rp_id: "new.tail1234.ts.net", rp_mismatch: ["old.tail1234.ts.net"], usable_credentials: 0 })!;
    assert.match(renamed, /enrolled for old\.tail1234\.ts\.net/);
    assert.match(renamed, /now serves new\.tail1234\.ts\.net/);
    assert.match(renamed, /brane config verification off/);
  });

  it("says so without a rename too: the last credential was revoked", () => {
    const none = noCredentialCanVerify({ mode: "passkey", rp_id: "mac.tail1234.ts.net", rp_mismatch: [], usable_credentials: 0 })!;
    assert.match(none, /No passkey or security key is enrolled/);
    assert.match(none, /brane config verification off/);
  });

  it("offers Verify whenever a proof is possible, or nothing is known", () => {
    assert.equal(noCredentialCanVerify({ mode: "passkey", rp_id: "new.tail1234.ts.net", rp_mismatch: ["old.tail1234.ts.net"], usable_credentials: 1 }), null, "one still answers");
    assert.equal(noCredentialCanVerify({ mode: "off", rp_id: "new.tail1234.ts.net", rp_mismatch: ["old.tail1234.ts.net"], usable_credentials: 0 }), null, "the gate is off: nothing is refused");
    assert.equal(noCredentialCanVerify({ mode: "passkey", rp_id: null, rp_mismatch: [], usable_credentials: null }), null, "no host yet");
    assert.equal(noCredentialCanVerify({ mode: "passkey" }), null, "a daemon from before phase 4");
    assert.equal(noCredentialCanVerify(undefined), null);
  });
});

describe("proofName, how a list names what verified a device", () => {
  it("quotes a credential's label, so it reads as a name and not as where the proof came from", () => {
    assert.equal(proofName({ by: "Passkey from Chrome on macOS", by_id: "cred-1" }), '"Passkey from Chrome on macOS"');
  });

  it("keeps the daemon's revoked mark outside the quotes", () => {
    assert.equal(proofName({ by: "Passkey from Chrome on macOS (revoked)", by_id: "cred-1" }), '"Passkey from Chrome on macOS" (revoked)');
  });

  it("leaves an id with no label bare: an OIDC subject, or a row the daemon no longer knows", () => {
    assert.equal(proofName({ by: "oidc:1234", by_id: "oidc:1234" }), "oidc:1234");
    assert.equal(proofName({ by: "cred-gone", by_id: "cred-gone" }), "cred-gone");
  });
});
