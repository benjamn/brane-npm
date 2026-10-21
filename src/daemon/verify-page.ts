/**
 * `GET /verify`: the ceremony page on the daemon's own origin
 * (docs/passkeys.md, "The hop" and "What the browser side must do"). The
 * RP ID is the daemon's hostname, so this is the only page that can run
 * WebAuthn for it: the hosted shell hops here, and so does the daemon's own
 * bundle. Self-contained (no bundle, no token, nothing fetched but the
 * daemon's own ceremony routes), so it works whatever app the device runs.
 *
 * What the phone taught the spike, kept here:
 *
 * - **The challenge is fetched before the tap**, and the next one the moment
 *   a tap takes the current one: WebKit refuses a prompt started too long
 *   after the tap that asked for it (claude-pbg4whll:15, :31).
 * - **One ceremony at a time**: the buttons are disabled while one is up.
 * - **`NotAllowedError` is routine** (cancel, timeout, no credential, rate
 *   limit): the page resets quietly and lets the operator tap again.
 * - **One button per kind enrolled** (`verifyKinds`): a prompt takes one
 *   `userVerification`, and the daemon decides it per kind, so a passkey is
 *   asked to verify the user and a security key only for a touch. With one
 *   kind there is one button, "Verify".
 *
 * The approval arrives in the fragment and is wiped from the address bar on
 * load, so it is not left in history. Inline script, so the CSP pins it by
 * hash: the page runs exactly this code and loads nothing else.
 */

import { createHash } from "node:crypto";

const SCRIPT = String.raw`
(function () {
  "use strict";
  var params = new URLSearchParams(location.hash.slice(1));
  var approval = params.get("approval");
  var purpose = params.get("purpose") === "enroll" ? "enroll" : "verify";
  var back = params.get("return");
  try { history.replaceState(null, "", location.pathname); } catch (e) {}
  // A second link opened in this tab changes only the fragment, which does
  // not reload the page: start over with the new approval.
  window.addEventListener("hashchange", function () { location.reload(); });

  var $ = function (id) { return document.getElementById(id); };
  var title = $("title"), lede = $("lede"), status = $("status"), actions = $("actions"), done = $("done");
  var base = purpose === "enroll" ? "/api/credentials" : "/api/verify";
  var ready = null;      // the challenge held for the next tap
  var fetching = null;   // the fetch that will fill it
  var busy = false;
  var enrolled = 0;

  function b64uToBuf(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  function bufToB64u(buf) {
    var b = new Uint8Array(buf), s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function say(text, kind) {
    status.textContent = text || "";
    status.className = kind || "";
  }
  function post(path, body) {
    return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; }); });
  }
  function setBusy(b) {
    busy = b;
    var buttons = actions.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = b || !ready;
  }
  function expired() {
    ready = null;
    actions.hidden = true;
    say("This link has expired or was already used. Go back to brane and start again.", "error");
    showBack();
  }
  function prefetch() {
    if (fetching || ready) return fetching;
    fetching = post(base + "/challenge", { approval: approval }).then(function (r) {
      fetching = null;
      if (r.status === 410) { expired(); return; }
      if (r.status !== 200) { say(r.body.error || "The daemon refused (" + r.status + ")", "error"); return; }
      ready = r.body.publicKey;
      enrolled = r.body.enrolled;
      render();
    }, function () {
      fetching = null;
      say("Could not reach the daemon. Check the connection and reload.", "error");
    });
    return fetching;
  }
  function showBack() {
    if (back && /^https?:\/\//.test(back)) {
      var a = document.createElement("a");
      a.href = back;
      a.textContent = "Return to brane";
      a.className = "button";
      done.appendChild(a);
    }
  }
  function finish(text) {
    actions.hidden = true;
    say(text, "ok");
    showBack();
    // A window the app opened can close itself; elsewhere this does nothing.
    setTimeout(function () { try { window.close(); } catch (e) {} }, 1200);
  }

  function requestOptions(kind) {
    var o = ready;
    var k = o.kinds.filter(function (x) { return x.kind === kind; })[0] || o.kinds[0];
    return {
      challenge: b64uToBuf(o.challenge),
      rpId: o.rpId,
      timeout: o.timeout,
      userVerification: k.userVerification,
      allowCredentials: k.allowCredentials.map(function (c) { return { type: c.type, id: b64uToBuf(c.id), transports: c.transports }; })
    };
  }
  function creationOptions(kind) {
    var o = ready;
    var opts = {
      challenge: b64uToBuf(o.challenge),
      rp: o.rp,
      user: { id: b64uToBuf(o.user.id), name: o.user.name, displayName: o.user.displayName },
      pubKeyCredParams: o.pubKeyCredParams,
      timeout: o.timeout,
      attestation: o.attestation,
      excludeCredentials: o.excludeCredentials.map(function (c) { return { type: c.type, id: b64uToBuf(c.id), transports: c.transports }; })
    };
    if (kind === "security-key") {
      opts.authenticatorSelection = { authenticatorAttachment: "cross-platform", residentKey: "discouraged", userVerification: "discouraged" };
      opts.hints = ["security-key"];
    } else {
      opts.authenticatorSelection = { residentKey: "required", userVerification: "required" };
      opts.hints = ["client-device", "hybrid"];
    }
    return opts;
  }

  function ceremony(kind) {
    if (busy) return;
    if (!ready) { say("Getting ready… tap again in a moment.", "wait"); prefetch(); return; }
    setBusy(true);
    say(purpose === "enroll" ? "Follow your browser's prompt…" : "Confirm with Face ID, Touch ID or your security key…");
    var call = purpose === "enroll"
      ? navigator.credentials.create({ publicKey: creationOptions(kind) })
      : navigator.credentials.get({ publicKey: requestOptions(kind) });
    // The tap has taken this challenge: fetch the next now, not after.
    ready = null;
    prefetch();
    call.then(function (cred) {
      var r = cred.response;
      if (purpose === "enroll") {
        say("Checking… if your Mac asks you to confirm, approve it there.");
        return post("/api/credentials", {
          approval: approval,
          credential: { response: {
            clientDataJSON: bufToB64u(r.clientDataJSON),
            attestationObject: bufToB64u(r.attestationObject),
            transports: typeof r.getTransports === "function" ? r.getTransports() : []
          } }
        }).then(function (res) {
          if (res.status === 200) {
            var c = res.body.credential;
            finish("Added: " + c.label + (c.attested ? " (hardware attested)." : ".") + (c.backup_eligible ? "" : " A key like this is not synced: enroll a second one as a backup."));
          } else if (res.status === 410) expired();
          else { say(res.body.error || "Refused (" + res.status + ")", "error"); setBusy(false); }
        });
      }
      return post("/api/verify/webauthn", {
        approval: approval,
        credential: { rawId: bufToB64u(cred.rawId), response: {
          clientDataJSON: bufToB64u(r.clientDataJSON),
          authenticatorData: bufToB64u(r.authenticatorData),
          signature: bufToB64u(r.signature)
        } }
      }).then(function (res) {
        if (res.status === 200) finish("Verified. You can return to brane.");
        else if (res.status === 410) expired();
        else if (res.body.reason === "user-verification") {
          say("That passkey answered without Face ID, Touch ID or a PIN, though brane asked for one. Check its settings, or use another passkey or key.", "error");
          setBusy(false);
        }
        else { say(res.body.error || "Refused (" + res.status + ")", "error"); setBusy(false); }
      });
    }, function (err) {
      // Cancel, timeout, no credential, a rate limit: routine. Reset quietly.
      if (err && err.name === "InvalidStateError" && purpose === "enroll") say("This authenticator is already enrolled.", "ok");
      else if (err && err.name === "NotAllowedError") say("Cancelled. Tap to try again.");
      else say((err && err.message) || "The browser refused.", "error");
      setBusy(false);
      prefetch();
    }).then(null, function () {
      say("Could not reach the daemon. Check the connection and try again.", "error");
      setBusy(false);
    });
  }

  function button(label, kind) {
    var b = document.createElement("button");
    b.textContent = label;
    b.disabled = true;
    b.addEventListener("click", function () { ceremony(kind); });
    actions.appendChild(b);
  }

  function render() {
    if (purpose === "verify" && enrolled === 0) {
      actions.hidden = true;
      say("No passkey or security key is enrolled on this daemon yet. Add one from brane's Devices view first.", "error");
      return;
    }
    if (purpose === "verify" && !actions.firstChild) {
      var names = { passkey: "Passkey", "security-key": "Security key" };
      ready.kinds.forEach(function (k) { button(ready.kinds.length > 1 ? names[k.kind] : "Verify", k.kind); });
    }
    setBusy(busy);
    // Clear only a "getting ready" note: what the last attempt said (it was
    // cancelled, the key is already enrolled) stays until the next tap.
    if (!busy && status.className === "wait") say("");
  }

  if (!approval) {
    title.textContent = "Nothing to verify";
    lede.textContent = "Open this page from brane, which adds what it needs to the link.";
    actions.hidden = true;
    return;
  }
  if (!window.PublicKeyCredential || !navigator.credentials) {
    lede.textContent = "This browser cannot use passkeys or security keys here. Try Safari or Chrome, outside any in-app browser.";
    actions.hidden = true;
    return;
  }
  if (purpose === "enroll") {
    title.textContent = "Add a passkey or security key";
    lede.textContent = "Either one can then verify any of your devices. A passkey is confirmed at your Mac before it is added; a YubiKey vouches for itself. On iPhone, turn on Stolen Device Protection so a passcode someone saw cannot stand in for Face ID.";
    button("Passkey on this device", "passkey");
    button("Security key", "security-key");
  } else {
    title.textContent = "Verify it's you";
    lede.textContent = "brane needs a fresh proof before this device acts.";
  }
  say("Getting ready…", "wait");
  prefetch();
})();
`;

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f6f4; --fg: #1d1d1b; --muted: #6b6b66; --accent: #2f5bd3; --err: #b3261e; --ok: #1e7b34; --card: #ffffff; --line: #deded8; }
@media (prefers-color-scheme: dark) { :root { --bg: #121211; --fg: #ecece8; --muted: #9a9a94; --accent: #8aa8ff; --err: #ff8a80; --ok: #7bd88f; --card: #1c1c1a; --line: #2e2e2b; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg); color: var(--fg);
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 16px; }
main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 24px; }
h1 { font-size: 20px; margin: 0 0 8px; }
p { margin: 0 0 16px; color: var(--muted); }
#actions { display: flex; flex-direction: column; gap: 10px; }
button, .button { display: block; width: 100%; padding: 14px; border-radius: 10px; border: 0; background: var(--accent); color: #fff;
  font: inherit; font-weight: 600; text-align: center; text-decoration: none; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
#status { min-height: 1.5em; margin: 16px 0 0; color: var(--muted); }
#status.error { color: var(--err); }
#status.ok { color: var(--ok); }
#done { margin-top: 12px; }
`;

export const VERIFY_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>brane · verify</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1 id="title">Verify it's you</h1>
<p id="lede"></p>
<div id="actions"></div>
<p id="status" role="status" aria-live="polite"></p>
<div id="done"></div>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;

const SCRIPT_HASH = createHash("sha256").update(SCRIPT).digest("base64");
const STYLE_HASH = createHash("sha256").update(STYLE).digest("base64");

/** Headers for the page: nothing cached, never framed (a framed ceremony
 *  is a clickjacked one), no referrer, and a CSP that runs exactly the
 *  inline script above and talks only to its own origin. */
export function verifyPageHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": [
      "default-src 'none'",
      `script-src 'sha256-${SCRIPT_HASH}'`,
      `style-src 'sha256-${STYLE_HASH}'`,
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  };
}
