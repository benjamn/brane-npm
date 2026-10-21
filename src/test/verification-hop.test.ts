/**
 * The app's side of the verification gate, as pure decisions
 * (src/shared/verification-hop.ts): which responses open the lock sheet,
 * where a same-tab hop goes, and when backgrounding ends the window.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sameTabHopUrl, shouldEndOnHide, verificationRefusal, verifiedPerStatus } from "../shared/verification-hop.js";

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
