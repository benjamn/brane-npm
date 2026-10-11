/**
 * Confirm that the operator is at this machine, using the OS's own
 * owner-authentication prompt — never one of ours.
 *
 * This is the human-presence check passkey enrollment rests on: a software
 * authenticator can mint a passkey whose "user verified" flag is set with no
 * human anywhere, and without attestation the daemon cannot tell it from
 * Face ID. What an agent running as the operator cannot do is answer a
 * system dialog that wants a fingerprint or the login password, so the first
 * enrollment (and recovery) is confirmed here instead.
 *
 * Each platform runs a tool the OS already ships, so there is no native
 * dependency:
 *
 * | platform      | tool                                 | asks for                      |
 * |---------------|--------------------------------------|-------------------------------|
 * | macOS         | `osascript` → LocalAuthentication    | Touch ID, Watch, or password  |
 * | Windows / WSL | `powershell.exe` → Windows Hello     | face, fingerprint, or PIN     |
 * | Linux desktop | `pkcheck` → polkit (`auth_self`)     | the user's own password       |
 *
 * Headless Linux has no dialog to show and reports `unavailable`; a hardware
 * key is the answer there, not a password typed into a terminal an agent can
 * also read.
 *
 * Every command is a fixed absolute path into a system directory, never a
 * bare name looked up on the daemon's inherited PATH (or a path built from
 * its environment), where a careless agent's PATH tweak could put a fake
 * `osascript` that prints `{"ok":true}`. That is hygiene, not a defence: a
 * hostile process running as the operator can already edit `dist/` or the
 * database, which brane accepts as out of scope.
 *
 * Each backend is a pure `PresencePlan` (command, arguments, how to read the
 * answer) so the suite checks every platform's plan on any platform without
 * putting a dialog on anyone's screen. Only the macOS plan has been run
 * against a real prompt.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

export type PresenceMethod = "macos-local-auth" | "windows-hello" | "polkit";

export type PresenceResult =
  | { ok: true; method: PresenceMethod }
  | {
      ok: false;
      method: PresenceMethod | null;
      /** `canceled`: the operator said no. `unavailable`: there is no prompt
       *  to show here. `aborted`: the caller withdrew the question (its
       *  `signal`), and the prompt was closed. */
      reason: "canceled" | "unavailable" | "failed" | "timeout" | "aborted";
      detail?: string;
    };

export type PresencePlatform = "macos" | "windows" | "wsl" | "linux" | "unsupported";

export interface PresencePlan {
  method: PresenceMethod;
  command: string;
  args: string[];
  /** Read the finished process. `code` is null when it died on a signal. */
  interpret(stdout: string, stderr: string, code: number | null): PresenceResult;
}

/** The polkit action the Linux backend checks; its policy is in docs/presence.md. */
export const POLKIT_ACTION = "dev.brane.confirm-presence";

export function detectPresencePlatform(
  platform: NodeJS.Platform = process.platform,
  procVersion: () => string = () => readFileSync("/proc/version", "utf8"),
  env: NodeJS.ProcessEnv = process.env,
): PresencePlatform {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (platform !== "linux") return "unsupported";
  if (env.WSL_DISTRO_NAME) return "wsl";
  try {
    if (/microsoft/i.test(procVersion())) return "wsl";
  } catch {
    // no /proc: not WSL
  }
  return "linux";
}

// ── macOS ──────────────────────────────────────────────────────────────

/**
 * JavaScript for Automation, run by `osascript -l JavaScript`. Policy 2 is
 * `LAPolicyDeviceOwnerAuthentication`: biometrics, a paired Watch, or the
 * login password — the dialog has no approve button of its own, so a
 * synthetic click can cancel it but never pass it. The reply arrives on a
 * callback, so the script spins the run loop until it does.
 */
export const MAC_SCRIPT = `
ObjC.import('LocalAuthentication');
ObjC.import('Foundation');
function run(argv) {
  const ctx = $.LAContext.alloc.init;
  const canErr = Ref();
  if (!ctx.canEvaluatePolicyError(2, canErr)) {
    return JSON.stringify({ ok: false, unavailable: true, error: ObjC.unwrap(canErr[0].localizedDescription) });
  }
  let done = false, result = null;
  ctx.evaluatePolicyLocalizedReasonReply(2, argv[0], (success, error) => {
    result = success ? { ok: true } : { ok: false, code: Number(error.code), error: ObjC.unwrap(error.localizedDescription) };
    done = true;
  });
  while (!done) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1));
  return JSON.stringify(result);
}
`;

/**
 * LAError codes that mean the operator said no. Not `systemCancel` (-4: the
 * system took the dialog away) and not `authenticationFailed` (-1: too many
 * wrong attempts) — both are `failed`, as `RetriesExhausted` is on Windows.
 */
const LA_CANCELED = new Set([-2 /* userCancel */]);

export function macPlan(reason: string): PresencePlan {
  const method = "macos-local-auth" as const;
  return {
    method,
    command: "/usr/bin/osascript",
    args: ["-l", "JavaScript", "-e", MAC_SCRIPT, reason],
    interpret(stdout, stderr, code) {
      let r: { ok?: boolean; unavailable?: boolean; code?: number; error?: string };
      try {
        r = JSON.parse(stdout.trim());
      } catch {
        return { ok: false, method, reason: "failed", detail: (stderr || stdout).trim() || `exit ${code}` };
      }
      if (r.ok === true) return { ok: true, method };
      if (r.unavailable) return { ok: false, method, reason: "unavailable", detail: r.error };
      const canceled = typeof r.code === "number" && LA_CANCELED.has(r.code);
      return { ok: false, method, reason: canceled ? "canceled" : "failed", detail: r.error };
    },
  };
}

// ── Windows and WSL ────────────────────────────────────────────────────

/** A PowerShell single-quoted literal: only `'` is special, and it doubles. */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Windows Hello through `UserConsentVerifier`, from Windows PowerShell 5.1
 * (`powershell.exe`; PowerShell 7 dropped the WinRT projection). From WSL
 * the same file is reachable through `/mnt/c`, and the prompt appears on
 * the Windows desktop, out of reach of anything inside the Linux VM.
 */
export function windowsScript(reason: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
    "$null = [Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]",
    "$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1",
    "function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $null = $t.Wait(-1); $t.Result }",
    "$avail = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])",
    "if ($avail -ne 'Available') { Write-Output \"unavailable:$avail\"; exit 0 }",
    `$r = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync(${psQuote(reason)})) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])`,
    "Write-Output \"result:$r\"",
  ].join("\n");
}

export function windowsPlan(reason: string, platform: "windows" | "wsl" = "windows"): PresencePlan {
  const method = "windows-hello" as const;
  // Hard-coded, not built from %SystemRoot%: the daemon inherits its
  // environment, so a path read from it is only as fixed as PATH is.
  const command = platform === "wsl" ? WSL_POWERSHELL : WINDOWS_POWERSHELL;
  // -EncodedCommand takes UTF-16LE base64, which sidesteps every layer of
  // quoting between here, WSL's interop, and the Windows command line.
  const encoded = Buffer.from(windowsScript(reason), "utf16le").toString("base64");
  return {
    method,
    command,
    args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    interpret(stdout, stderr, code) {
      const line = stdout.trim().split(/\r?\n/).pop() ?? "";
      if (line === "result:Verified") return { ok: true, method };
      if (line.startsWith("unavailable:")) {
        return { ok: false, method, reason: "unavailable", detail: line.slice("unavailable:".length) };
      }
      if (line === "result:Canceled") {
        return { ok: false, method, reason: "canceled", detail: line.slice("result:".length) };
      }
      if (line.startsWith("result:")) return { ok: false, method, reason: "failed", detail: line.slice("result:".length) };
      return { ok: false, method, reason: "failed", detail: (stderr || stdout).trim() || `exit ${code}` };
    },
  };
}

// ── Linux ──────────────────────────────────────────────────────────────

/**
 * polkit, against brane's own action. Its policy (in docs/presence.md)
 * says `auth_self` — the user proves they are themselves, not an admin —
 * with no retention, so every check asks. polkit's built-in actions mostly
 * want an administrator, which is the wrong question, hence the file.
 *
 * pkcheck exit codes (pkcheck(1)): 0 authorized; 1 not authorized, which
 * includes a daemon outside an active local session (over SSH, under a
 * service manager), where polkit never asks; 2 a challenge but no agent to
 * show it (headless); 3 dismissed, the only one that means the operator said
 * no; 127 error, which is how an unregistered action is believed to surface
 * (untested), so the message is matched before the code.
 */
export function linuxPlan(pid: number = process.pid): PresencePlan {
  const method = "polkit" as const;
  return {
    method,
    command: "/usr/bin/pkcheck",
    args: ["--action-id", POLKIT_ACTION, "--process", String(pid), "--allow-user-interaction"],
    interpret(stdout, stderr, code) {
      const detail = (stderr || stdout).trim() || undefined;
      if (code === 0) return { ok: true, method };
      if (/not registered|No action with action id/i.test(detail ?? "")) {
        return { ok: false, method, reason: "unavailable", detail: `polkit action ${POLKIT_ACTION} is not installed` };
      }
      if (code === 3) return { ok: false, method, reason: "canceled", detail };
      if (code === 2) return { ok: false, method, reason: "unavailable", detail: detail ?? "no polkit agent (headless?)" };
      return { ok: false, method, reason: "failed", detail: detail ?? `exit ${code}` };
    },
  };
}

/** Windows PowerShell 5.1 where Windows installs it. */
export const WINDOWS_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/** The same file as WSL's default automount sees it. */
export const WSL_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

// ── Dispatch ───────────────────────────────────────────────────────────

export function presencePlan(reason: string, platform: PresencePlatform = detectPresencePlatform()): PresencePlan | null {
  switch (platform) {
    case "macos":
      return macPlan(reason);
    case "windows":
    case "wsl":
      return windowsPlan(reason, platform);
    case "linux":
      return linuxPlan();
    default:
      return null;
  }
}

/**
 * Ask the operator to confirm they are here. `reason` is shown in the
 * prompt where the platform allows it (macOS, Windows); polkit shows its
 * policy's fixed message. Never throws.
 */
export function confirmPresence(
  reason: string,
  opts: { timeoutMs?: number; platform?: PresencePlatform; signal?: AbortSignal } = {},
): Promise<PresenceResult> {
  const plan = presencePlan(reason, opts.platform);
  if (!plan) return Promise.resolve({ ok: false, method: null, reason: "unavailable", detail: process.platform });
  return runPlan(plan, opts.timeoutMs ?? 120_000, opts.signal);
}

/** Run a plan's command and hand its outcome to the plan. Aborting `signal`
 *  kills the helper, which takes its dialog down with it on macOS (see
 *  docs/presence.md for Windows). Never throws. */
export function runPlan(plan: PresencePlan, timeoutMs: number, signal?: AbortSignal): Promise<PresenceResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, method: plan.method, reason: "aborted" });
      return;
    }
    execFile(plan.command, plan.args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, signal }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      if (e?.name === "AbortError") {
        resolve({ ok: false, method: plan.method, reason: "aborted" });
      } else if (e?.code === "ENOENT") {
        resolve({ ok: false, method: plan.method, reason: "unavailable", detail: `${plan.command} not found` });
      } else if (e?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        resolve({ ok: false, method: plan.method, reason: "failed", detail: "output too large" });
      } else if (e?.killed) {
        resolve({ ok: false, method: plan.method, reason: "timeout" });
      } else {
        resolve(plan.interpret(String(stdout), String(stderr), typeof e?.code === "number" ? e.code : e ? null : 0));
      }
    });
  });
}
