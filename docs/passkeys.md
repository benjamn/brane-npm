# Passkeys

Passkeys are **designed, spiked and tested on real devices, but not built**.
This page is the design and the evidence behind it, for whoever builds
enrollment. The pieces already in the code are per-device tokens (#549,
#552), the lapse for unused tokens (#555), and the presence check
(`src/presence.ts`, [Presence Check](presence.md)).

## The rule

**A passkey guards minting a token, never using one.** Every request keeps
authenticating with its device token, so a browser that cannot do WebAuthn
— the plain-HTTP fallback, an in-app webview, one with a flaky ceremony —
keeps working once it holds a token. The ceremony happens only when a new
device is let in (claude-pbg4whll:21). The worst outcome of a passkey
failure is a slower way to add a device, never a browser locked out of
brane.

What else a passkey guards — "Sign out other devices", an agent asking for
a token — is **not decided** (claude-pbg4whll:40).

## Decisions

| Decision | Why | Where |
|---|---|---|
| The RP ID is the daemon's own hostname (`<machine>.<tailnet>.ts.net`) | The daemon works with nothing outside the machine and the tailnet | claude-0d36vrut:16, claude-0d36vrut:21 |
| The hosted shell (`brane.organelle.dev`) does not share the passkey | It hops to the daemon's own page for the rare ceremony. No `/.well-known/webauthn`, no port 443, no `tailscale serve`, no reliance on related-origins support | claude-pbg4whll:35 |
| No attestation, random user handle | The daemon learns a public key and nothing about the authenticator — except for the bootstrap key (below) | claude-82b6w9o3:12 |
| The first enrollment needs the presence check | A software authenticator sets "user verified" with nobody present, and without attestation the daemon cannot tell; an agent acting as this account could otherwise enroll its own passkey | claude-pbg4whll:42 |
| YubiKeys stay possible and the top tier | Attested hardware proves itself; a key also covers headless Linux | claude-pbg4whll:49, claude-pbg4whll:50 |
| Ship enrollment before requiring it | Enrolling changes nothing until the restriction is switched on, so it can ship and be lived with first | claude-pbg4whll:33 |

## Evidence

**Spike, headless Chromium** (claude-0d36vrut:21). A virtual authenticator
against a `node:crypto`-only verifier: single-use challenge, origin
allowlist, RP ID hash, user-verified flag, ES256 signature. A passkey on
the daemon's hostname enrolled and signed in on the daemon's page; a
replayed assertion and an unlisted origin were refused. An RP ID of the
whole tailnet (`<tailnet>.ts.net`) works on the daemon's page but nothing
can serve its `.well-known`, so it was dropped.

**Check 1, real devices** (claude-pbg4whll:29). The same verifier on a
spare port, tailnet-only, with the daemon's Tailscale certificate:

| Browser | Enroll | Sign in | Replay refused |
|---|---|---|---|
| iOS Safari | ✅ Face ID | ✅ | ✅ |
| iOS Chrome | ✅ | ✅ 5/5 after the fix below | not rerun |
| Mac Chrome 152 | — | ✅ through the phone QR (hybrid) | ✅ |
| Mac Safari, Firefox, Android, Windows | not tried | | |

- The passkey **synced to iCloud Keychain** (backup-eligible and
  backed-up flags both set), and Face ID set user-verified.
- The origin carried the non-standard port (`:47443`) and verified; the
  port is not part of the RP ID.
- Mac Chrome did not offer the iCloud passkey directly and went through
  the phone. Whether a Chrome setting changes that is unverified.

## What the browser side must do

Learned on the phone, then confirmed by the research below:

1. **Have the challenge before the tap.** Fetching it between the tap and
   `navigator.credentials.get/create` made iOS refuse with
   `NotAllowedError` (2 of 7 sign-ins succeeded in iOS Chrome before the
   fix, 5 of 5 after). Fetch the next challenge the moment one is taken.
2. **One ceremony at a time.** Disable the button and keep a single
   `AbortController`, aborting the previous request before starting
   another. A second tap while a prompt was open failed in testing.
3. **Treat `NotAllowedError` as routine.** It means cancel, timeout, no
   credential, or no user activation, and since Safari 17.4 WebKit also
   rate-limits ceremonies (unverified: a vendor blog, no Apple figures).
   Reset quietly and let the operator tap again; never show it as a fault.
4. **If no challenge is ready, wait for one** with a spinner, then ask for
   a fresh tap. Calling the prompt without one is what WebKit refuses.

## Daemon side

- **Challenges** are random, single-use, bound to the pending ceremony, and
  expire with the ceremony's `timeout` (a few minutes; the exact lifetime is
  a choice, not a sourced figure).
- **Verify the full origin, port included**, against the daemon's own list;
  the RP ID hash; user-verified; the signature.
- **Ignore `signCount` when it is 0**, which is every synced passkey.
  Enforce it only for a credential that has reported a non-zero count.
- **Store at registration:** credential id, public key, algorithm,
  transports, AAGUID, sign count, and the backup-eligible / backed-up
  flags. Record which presence method confirmed the enrollment.
- **When a device-bound key enrolls** (backup-eligible = 0, e.g. a
  YubiKey), prompt for a second credential as its backup.
- **Bootstrap attestation:** ask for `attestation: "direct"` on the first
  enrollment only. A YubiKey 5+ answers with a certificate the daemon can
  verify against the FIDO Metadata Service by AAGUID; that counts as
  presence by itself. iCloud passkeys send none and fall back to the
  presence check.

## Research

From a web survey on making passkeys robust (claude-pbg4whll:70). Claims
from vendor blogs are marked.

- **`excludeCredentials` on create**, with stored transports; treat
  `InvalidStateError` ("already registered") as success.
  [web.dev](https://web.dev/articles/passkey-registration)
- **`hints: ["security-key", …]`** keeps YubiKeys first-class; without it
  Chrome on Android may not offer an NFC key. Chrome 128+ honours hints;
  Safari and Firefox are unverified.
  [Chrome](https://developer.chrome.com/blog/passkeys-updates-chrome-129)
- **Discoverable credentials with an empty `allowCredentials`**: a list
  whose transports are only `internal` makes Chrome hide the phone QR.
  [Corbado](https://www.corbado.com/blog/webauthn-passkey-qr-code) (vendor)
- **The Signal API** cleans stale passkeys out of the password manager —
  the remedy for the orphan the test page left on the operator's phone.
  `signalAllAcceptedCredentials` after a device is added or removed, never
  with an empty list (that hides every passkey). Chrome 132+; Safari 26
  partial; Firefox none.
  [Chrome](https://developer.chrome.com/docs/identity/webauthn-signal-api)
- **Feature-detect with `PublicKeyCredential.getClientCapabilities()`**
  (Safari 17.4+, Chrome 133+, Firefox 135+) to choose which buttons to
  show, never to block.
  [web.dev](https://web.dev/articles/webauthn-client-capabilities)
- **Hybrid (phone QR) is the most fragile path**: Bluetooth on both
  devices, close together; Chrome on macOS can fail to find the phone after
  its Bluetooth permission prompt
  ([Chromium 349393380](https://issues.chromium.org/issues/349393380)).
- **Passkey autofill (conditional UI) adds little**: brane has no username
  field and the ceremony is rare.
- **The RP ID cannot change.** Renaming the machine or the tailnet orphans
  every passkey; recovery covers it.
- **WebAuthn refuses a page with a certificate error**, and the HTTP
  fallback can never run a ceremony.

## Open questions

1. **What a passkey guards beyond adding a device** — the operator's call
   (claude-pbg4whll:40).
2. **The flow for approving a new device from one already trusted**: the
   new device shows a code, the trusted one approves with Face ID. Not
   designed; includes how the approval returns to an app saved to the home
   screen, which may open Safari.
3. **The hop from the hosted shell** to the daemon's page and back must
   carry a short-lived, single-use approval, never a token.
4. **Renames**: should the daemon record each passkey's RP ID and warn
   before a hostname change?
5. **Untried**: Mac Safari and Firefox; Android; the presence check's
   Windows/WSL and polkit backends; a YubiKey's attestation and its
   signature as a presence method (claude-pbg4whll:63).

## Build order

1. ~~Unused-token lapse~~ — #555, verified live: an unscanned meld token
   was revoked by the sweep 31 s after its deadline (claude-pbg4whll:96).
2. ~~Devices list~~ — #558: each row records the browser, platform and address
   it was first presented from, and revoke is a bodiless
   `POST /api/tokens/:id/revoke` (claude-59qp4ud5:4). See [Token
   Rotation](token-rotation.md#the-devices-list). Revoking is no more gated
   than "Sign out other devices" yet; whether a passkey should guard it is
   open question 1.
3. **Passkey enrollment and verification**, nothing yet required.
4. **Wire in `confirmPresence`** for the first enrollment and for
   recovery, with `reason` built on the daemon.
5. **Switch the restriction on**: after the first passkey, this machine's
   account (a tokenless request over `daemon.sock`) can no longer mint
   device tokens, and meld tickets need a passkey.
