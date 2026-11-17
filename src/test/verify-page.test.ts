/**
 * The ceremony page (src/daemon/verify-page.ts) is one inline script the CSP
 * pins by hash. Nothing else would notice a syntax slip in it, or a script
 * that drifted from its hash: either ships as a page that does nothing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { VERIFY_PAGE_HTML, verifyPageHeaders } from "../daemon/verify-page.js";

const script = VERIFY_PAGE_HTML.split("<script>")[1].split("</script>")[0];

describe("the /verify page", () => {
  it("carries a script that parses", () => {
    assert.doesNotThrow(() => new Function(script));
  });

  it("tells the password manager what the daemon still accepts, and what it no longer knows", () => {
    assert.match(script, /signalAllAcceptedCredentials\(\{ rpId: accepted\.rpId, userId: accepted\.userId, allAcceptedCredentialIds: accepted\.credentialIds \}\)/);
    assert.match(script, /signalUnknownCredential\(\{ rpId: rpId, credentialId: credentialId \}\)/);
    // Never with an empty list, which would hide every passkey.
    assert.match(script, /!accepted\.credentialIds\.length/);
  });

  it("runs exactly that script under its CSP", () => {
    const hash = createHash("sha256").update(script).digest("base64");
    assert.match(verifyPageHeaders()["Content-Security-Policy"], new RegExp(`script-src 'sha256-${hash.replace(/[+/]/g, "\\$&")}'`));
  });
});
