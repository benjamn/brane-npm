# Presence Check

`confirmPresence(reason)` (`src/presence.ts`) asks the operator to prove
they are at this machine, using the operating system's own
owner-authentication prompt. It is the piece passkey enrollment and
recovery rest on, and what [the gate](#the-gate) holds meld, a device's
sign-out and rotation on. Passing it is what makes someone
the operator — see [Who the operator is](../SECURITY.md#who-the-operator-is).

## Why passkeys need it

A passkey's "user verified" flag says a person unlocked the authenticator,
but a software authenticator can set that flag with nobody present (the
passkey spike did exactly that with a virtual authenticator). iCloud
passkeys carry no attestation, so the daemon cannot tell one from a
script. An agent acting as this account could therefore enroll a passkey
of its own. The first enrollment, and recovery when no passkey works, are
confirmed here instead: an agent running as the operator can raise the
system prompt but cannot put a finger on the sensor or type a password it
does not know.

An attested hardware key (a YubiKey 5 or later) proves itself without this
check and remains the strongest option; see [Operator Verification](passkeys.md).

## Backends

Each runs a tool the OS already ships, so brane carries no native module.

| Platform | Tool | Asks for | Tested |
|---|---|---|---|
| macOS | `osascript -l JavaScript` → `LAContext`, policy `deviceOwnerAuthentication` | Touch ID, Apple Watch, or the login password | yes, on a real prompt; and raised by the daemon's gate: approve, decline, cooldown, Ctrl-C (2026-10-05) |
| Windows, WSL | `powershell.exe` (5.1) → `UserConsentVerifier` | Windows Hello: face, fingerprint, or PIN | no |
| Linux desktop | `pkcheck` against `dev.brane.confirm-presence` | the user's own password (`auth_self`) | no |
| Headless Linux | — | `unavailable` | — |

Less obvious than it looks:

- **macOS has no approve button.** The dialog's only ways through are
  biometrics or the password field, so synthetic clicks can cancel it but
  never pass it.
- **Every command is a fixed absolute system path** (`/usr/bin/osascript`,
  `/usr/bin/pkcheck`, `C:\Windows\System32\…\powershell.exe`), never a
  bare name on the daemon's inherited `PATH` nor a path built from its
  environment (`%SystemRoot%`). This is hygiene against a careless agent's
  `PATH`, not a defence against a hostile one: a process running as the
  operator can already edit `dist/` or `brane.db`, which brane accepts as
  out of scope. The check raises the bar for agents that follow the rules.
- **The reason never enters a script.** On macOS it is an `argv` element;
  on Windows it is a PowerShell single-quoted literal inside a script sent
  as `-EncodedCommand` (UTF-16LE base64), which survives WSL interop's
  quoting untouched.
- **WSL uses Windows Hello**, not polkit: the prompt appears on the Windows
  desktop, out of reach of anything inside the Linux VM. PowerShell 7
  (`pwsh`) lacks the WinRT projection, hence `powershell.exe`.
- **`canceled` means the operator said no, and nothing else.** A system
  that took the dialog away, too many wrong attempts, or polkit refusing
  without asking (a daemon outside the active desktop session, e.g. started
  over SSH: pkcheck exit 1) are all `failed`.
- **Linux needs brane's polkit policy installed.** polkit's built-in
  actions mostly ask for an administrator, which is the wrong question; this
  one asks the operator to prove they are themselves (`auth_self`), every
  time (no `_keep`). Without it the check reports `unavailable`; the "no
  such action" message is matched before the exit code, since pkcheck
  reports errors as 127 (untested against a real polkit). brane ships no
  copy of the file; install it with:

  ```sh
  sudo tee /usr/share/polkit-1/actions/dev.brane.confirm-presence.policy >/dev/null <<'EOF'
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE policyconfig PUBLIC
   "-//freedesktop//DTD PolicyKit Policy Configuration 1.0//EN"
   "http://www.freedesktop.org/standards/PolicyKit/1/policyconfig.dtd">
  <policyconfig>
    <vendor>brane</vendor>
    <vendor_url>https://github.com/benjamn/brane-npm</vendor_url>
    <action id="dev.brane.confirm-presence">
      <description>Confirm you are at this machine for brane</description>
      <message>brane wants to confirm you are at this machine before it trusts a new passkey or device</message>
      <defaults>
        <allow_any>no</allow_any>
        <allow_inactive>no</allow_inactive>
        <allow_active>auth_self</allow_active>
      </defaults>
    </action>
  </policyconfig>
  EOF
  ```
- **Headless Linux is `unavailable` on purpose.** polkit would fall back to
  a password prompt in the terminal, and agents run in terminals.

## The gate

`PresenceGate` (`src/daemon/presence-gate.ts`) is where the daemon calls
it, and `src/daemon/gated-routes.ts` holds the routes that ask it. Four
acts, asked from this machine's shell (a tokenless request over
`daemon.sock`), wait in the route until the operator answers:

| Act | Route | CLI | The prompt says |
|---|---|---|---|
| `meld` | `POST /api/tokens` | `brane meld`, `brane spawn --meld` | add a device to brane |
| `meld-remote` | `POST /api/tokens/remote` | `brane meld --remote` | add a device to brane on another machine |
| `revoke-device` | `POST /api/tokens/:id/revoke`, when it signs out a device | `brane token revoke <device>` | sign out a device from brane |
| `rotate` | `POST /api/token/rotate` | `brane token rotate` | sign out every other device from brane |
| `enroll` | `POST /api/credentials`, when no hardware attestation verified | the enrollment page (`GET /verify`), from a signed-in device | add a passkey or security key to brane |

A device token is never prompted for these four: the app's Meld sheet,
Revoke and "Sign out other devices" are the operator's delegate acting, and
work from anywhere. The one prompt a device raises is `enroll` ("add a
passkey or security key to brane"): a credential no hardware attestation
vouched for waits here before it joins the list, because a software
authenticator can claim "user verified" with nobody present
([Operator Verification](passkeys.md), decision 14). **An agent's token is refused all three, unasked** (403,
`presence: "agent"`; `gateStanding`): they are the operator's acts, and an
agent that follows the rules should never put a dialog in front of the
operator — one that read exactly like the prompt their own `brane meld`
raises would be approved out of habit. So an agent cannot `brane spawn
--meld`; the operator scans from the Meld sheet instead. Who is asking is
read from the token's kind, never from the address. Revoking an agent is
not gated, for an agent or the shell; stopping an agent the account
started is the account's to do.

Less obvious than it looks:

- **The prompt's words are fixed per act.** Nothing from a request reaches
  them, not a device's label nor its user agent: whoever minted a token
  chose those, and an agent that could write the prompt could make it read
  like the one the operator is expecting.
- **Check, ask, check again.** A request the route would refuse (a bad
  mint body; revoking this machine's own row, the requester's own, or a row that
  is not live) is refused before anyone is asked, so the operator never
  approves something that then fails. The revoke re-checks after the
  prompt, since rows can change during it.
- **Rotation asks before `beginRotation`.** A second begin replaces a
  pending rotation, so a refused request must never reach it: a loop could
  otherwise void the operator's own rotation without passing a prompt.
- **One prompt at a time, no queue.** A second gated request while one is
  up is refused at once (409). After one that was not approved (canceled,
  timed out, failed, canceled from a device, or withdrawn by its asker) the
  gate refuses for 15 s (429, with `Retry-After`), so a loop cannot keep a
  dialog on screen until it is approved out of habit; giving up and asking
  again is that loop, so a withdrawal counts. Both are global, but only the
  shell can reach the gate (an agent is refused before it), so only another
  shell's request can make the operator's `brane meld` wait; the Meld
  sheet still works regardless. The 409 names the prompt that is up and who asked, since its
  dialog may read exactly like the one the operator expected.
- **No dialog outlives its request.** A gated request waits 45 s; if its
  client goes away first (Ctrl-C), the helper is killed (`runPlan`'s
  `signal`), which takes the dialog down with it: seen live on macOS
  (2026-10-05), logged as `aborted`, and followed by the cooldown like any
  prompt not approved.
- **Every device hears of it, and can cancel; nothing can approve.** The
  control socket carries `{ type: "presence", pending }` when a prompt
  opens (`pending` names the act, the prompt, who asked, and when it
  expires) and `pending: null` when it closes; a socket that connects
  mid-prompt is told at once. `POST /api/presence/cancel?id=` closes it,
  and only a device token may call it: anything on this machine that could
  cancel could cancel every prompt as it appeared and, with the cooldown,
  keep `brane token rotate` from ever completing. The asker withdraws by
  disconnecting. A remote approve would be a device minting a token, which
  the Meld sheet already does in the open.
- **Every attempt is a log line**: `[presence] <act> for <who>: approved`,
  `canceled`, `remote-cancel`, `timeout`, `aborted`, `unavailable`, or
  refused as busy, cooling down, or `an agent's token` — an agent's attempt
  raises no prompt but is recorded like one that did.
- **No prompt, no act.** Where the platform cannot show one (headless
  Linux, a container), the gated acts are refused with `unavailable`; a
  device token still does them. The first device of such a machine comes
  from elsewhere: `brane meld --remote` has the operator's own daemon mint
  the token, behind this machine's prompt (`meld-remote`), and sends the
  remote only its hash, which its daemon adopts at startup
  (`BRANE_DEVICE_TOKEN_SHA256`; see `protocols/fly.md`). The minting daemon
  keeps nothing: the token is for another daemon, and the response is its
  only copy. There is no switch that turns the gate off.
- **Not containment.** `meld-remote` gates the sanctioned way to reach a
  remote daemon, not the remote: a process that can run `fly secrets set`
  (or whatever `--send` runs) can hand that daemon a hash of its own
  making, no brane involved. A device token is never prompted, whoever holds it,
  so a local process that minted itself one before the gate existed skips
  it; so does one that restarts the daemon with `--token` or
  `BRANE_DEVICE_TOKEN_SHA256` set, which adopt a device token at startup. Check the Devices list for devices added by "this machine" or by an
  agent that you did not add.

## Results

`{ ok: true, method }`, or `{ ok: false, method, reason, detail }` with
`reason` one of `canceled` (the operator said no), `unavailable` (no prompt
can be shown here), `failed`, `timeout` (default 120 s), or `aborted` (the
caller's `signal` withdrew the question, and the helper was killed). It
never throws.

## Tests

`src/test/presence.test.ts` checks each backend's plan as data — command,
arguments, quoting, and how each tool's answer is read — so it runs on any
platform and never raises a prompt. The macOS cancel result it parses was
recorded from a real dialog.

## For whoever wires it in, or first runs it on Windows

- **Build `reason` on the daemon** from what is being approved, never from
  text in a request, or an agent writes the prompt's words itself ("Unlock
  brane"). The prompt naming what it approves is half of what makes it safe.
- **Windows Hello from a hidden console may open behind other windows**;
  the desktop API is `RequestVerificationForWindowAsync(hwnd)`. And a
  timeout that kills `powershell.exe` (or WSL's interop proxy) may leave the
  dialog open with nobody listening. Both are the first things to watch in
  a real Windows run.
