import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectPresencePlatform,
  linuxPlan,
  macPlan,
  presencePlan,
  windowsPlan,
  windowsScript,
  confirmPresence,
  POLKIT_ACTION,
  WINDOWS_POWERSHELL,
  WSL_POWERSHELL,
  runPlan,
  type PresencePlan,
} from "../presence.js";

// Every plan is checked as data: none of these tests runs a prompt, so the
// suite passes on any platform and never puts a dialog on anyone's screen.

describe("detectPresencePlatform", () => {
  const noProc = () => {
    throw new Error("ENOENT");
  };

  it("maps darwin and win32 directly", () => {
    assert.equal(detectPresencePlatform("darwin", noProc, {}), "macos");
    assert.equal(detectPresencePlatform("win32", noProc, {}), "windows");
  });

  it("recognises WSL by its env var or by /proc/version", () => {
    assert.equal(detectPresencePlatform("linux", noProc, { WSL_DISTRO_NAME: "Ubuntu" }), "wsl");
    assert.equal(
      detectPresencePlatform("linux", () => "Linux version 5.15.153.1-microsoft-standard-WSL2", {}),
      "wsl",
    );
  });

  it("is plain linux otherwise, and unsupported elsewhere", () => {
    assert.equal(detectPresencePlatform("linux", () => "Linux version 6.8.0-generic", {}), "linux");
    assert.equal(detectPresencePlatform("linux", noProc, {}), "linux");
    assert.equal(detectPresencePlatform("freebsd", noProc, {}), "unsupported");
  });
});

describe("macPlan", () => {
  it("passes the reason as an argument, never inside the script", () => {
    const reason = `enroll "x"'); doShellScript('rm -rf ~`;
    const plan = macPlan(reason);
    assert.equal(plan.command, "/usr/bin/osascript");
    assert.deepEqual(plan.args.slice(0, 3), ["-l", "JavaScript", "-e"]);
    assert.equal(plan.args[4], reason);
    assert.ok(!plan.args[3].includes(reason));
  });

  it("asks for owner authentication (policy 2), which falls back to the password", () => {
    assert.match(macPlan("r").args[3], /evaluatePolicyLocalizedReasonReply\(2,/);
    assert.match(macPlan("r").args[3], /canEvaluatePolicyError\(2,/);
  });

  it("reads approve, cancel, unavailable and garbage", () => {
    const { interpret } = macPlan("r");
    assert.deepEqual(interpret('{"ok":true}\n', "", 0), { ok: true, method: "macos-local-auth" });
    // Recorded from a real prompt, cancelled by the operator.
    assert.deepEqual(interpret('{"ok":false,"code":-2,"error":"Authentication canceled."}', "", 0), {
      ok: false,
      method: "macos-local-auth",
      reason: "canceled",
      detail: "Authentication canceled.",
    });
    assert.equal(interpret('{"ok":false,"unavailable":true,"error":"No identities"}', "", 0).ok, false);
    assert.equal((interpret('{"ok":false,"unavailable":true}', "", 0) as { reason: string }).reason, "unavailable");
    assert.equal((interpret('{"ok":false,"code":-1}', "", 0) as { reason: string }).reason, "failed");
    // systemCancel: the system took the dialog away; the operator said nothing.
    assert.equal((interpret('{"ok":false,"code":-4}', "", 0) as { reason: string }).reason, "failed");
    assert.deepEqual(interpret("", "execution error: boom", 1), {
      ok: false,
      method: "macos-local-auth",
      reason: "failed",
      detail: "execution error: boom",
    });
  });
});

describe("windowsPlan", () => {
  it("encodes the script as UTF-16LE base64 for -EncodedCommand", () => {
    const plan = windowsPlan("approve device");
    assert.equal(plan.command, WINDOWS_POWERSHELL);
    const i = plan.args.indexOf("-EncodedCommand");
    assert.ok(i >= 0);
    const decoded = Buffer.from(plan.args[i + 1], "base64").toString("utf16le");
    assert.equal(decoded, windowsScript("approve device"));
    assert.match(decoded, /RequestVerificationAsync\('approve device'\)/);
  });

  it("runs powershell.exe by a fixed absolute path, never one from the environment", () => {
    assert.equal(windowsPlan("r", "windows").command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.equal(windowsPlan("r", "wsl").command, WSL_POWERSHELL);
    assert.equal(presencePlan("r", "wsl")?.command, WSL_POWERSHELL);
  });

  it("quotes the reason as a PowerShell literal", () => {
    assert.match(windowsScript("it's $(evil)"), /RequestVerificationAsync\('it''s \$\(evil\)'\)/);
  });

  it("reads Windows Hello's results", () => {
    const { interpret } = windowsPlan("r");
    assert.deepEqual(interpret("result:Verified\r\n", "", 0), { ok: true, method: "windows-hello" });
    assert.equal((interpret("result:Canceled", "", 0) as { reason: string }).reason, "canceled");
    assert.equal((interpret("result:RetriesExhausted", "", 0) as { reason: string }).reason, "failed");
    assert.equal((interpret("unavailable:NotConfiguredForUser", "", 0) as { reason: string }).reason, "unavailable");
    assert.equal((interpret("result:DeviceBusy", "", 0) as { reason: string }).reason, "failed");
    assert.equal((interpret("", "Add-Type : boom", 1) as { reason: string }).reason, "failed");
  });
});

describe("linuxPlan", () => {
  it("checks brane's own polkit action for this process, interactively", () => {
    const plan = linuxPlan(4242);
    assert.equal(plan.command, "/usr/bin/pkcheck");
    assert.deepEqual(plan.args, ["--action-id", POLKIT_ACTION, "--process", "4242", "--allow-user-interaction"]);
  });

  it("reads pkcheck's exit codes", () => {
    const { interpret } = linuxPlan(1);
    const reason = (r: ReturnType<typeof interpret>) => (r.ok ? "ok" : r.reason);
    assert.equal(reason(interpret("", "", 0)), "ok");
    assert.equal(reason(interpret("", "", 3)), "canceled");
    assert.equal(reason(interpret("", "Authorization requires authentication but no agent is available", 2)), "unavailable");
    // An unregistered action is matched by its message, whatever the code.
    assert.equal(reason(interpret("", `Action ${POLKIT_ACTION} is not registered`, 127)), "unavailable");
    assert.equal(reason(interpret("", `No action with action id ${POLKIT_ACTION}`, 1)), "unavailable");
    // Exit 1 includes "polkit never asked" (a daemon outside the desktop session).
    assert.equal(reason(interpret("", "Not authorized.", 1)), "failed");
    assert.equal(reason(interpret("", "", 127)), "failed");
  });
});

describe("presencePlan / confirmPresence", () => {
  it("routes WSL to Windows Hello", () => {
    assert.equal(presencePlan("r", "wsl")?.method, "windows-hello");
    assert.equal(presencePlan("r", "windows")?.method, "windows-hello");
    assert.equal(presencePlan("r", "macos")?.method, "macos-local-auth");
    assert.equal(presencePlan("r", "linux")?.method, "polkit");
    assert.equal(presencePlan("r", "unsupported"), null);
  });

  it("is unavailable, not a throw, where there is no backend", async () => {
    const r = await confirmPresence("r", { platform: "unsupported" });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "unavailable");
  });
});

describe("runPlan", () => {
  // Real child processes, none of which shows a prompt: node itself stands
  // in for the platform tool, and polkit's reading of exit codes is reused.
  const node = (script: string): PresencePlan => ({ ...linuxPlan(1), command: process.execPath, args: ["-e", script] });

  it("hands the exit code to the plan", async () => {
    assert.deepEqual(await runPlan(node("process.exit(0)"), 10_000), { ok: true, method: "polkit" });
    assert.equal(((await runPlan(node("process.exit(3)"), 10_000)) as { reason: string }).reason, "canceled");
    const r = await runPlan(node("console.error('Not authorized.'); process.exit(1)"), 10_000);
    assert.deepEqual(r, { ok: false, method: "polkit", reason: "failed", detail: "Not authorized." });
  });

  it("is unavailable when the tool is missing", async () => {
    const r = await runPlan({ ...linuxPlan(1), command: "/nonexistent/brane-presence-tool" }, 10_000);
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "unavailable");
  });

  it("times out, killing the tool", async () => {
    const r = await runPlan(node("setTimeout(() => {}, 10_000)"), 100);
    assert.equal((r as { reason: string }).reason, "timeout");
  });

  it("is aborted, killing the tool, when the caller withdraws", async () => {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 50);
    const r = await runPlan(node("setTimeout(() => {}, 10_000)"), 10_000, ac.signal);
    assert.equal((r as { reason: string }).reason, "aborted");
    assert.ok(Date.now() - started < 5_000, "the tool was killed, not waited out");
  });

  it("never starts the tool for a signal already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runPlan({ ...linuxPlan(1), command: "/nonexistent/brane-presence-tool" }, 10_000, ac.signal);
    assert.equal((r as { reason: string }).reason, "aborted");
  });

  it("calls oversized output failed, not a timeout", async () => {
    const r = await runPlan(node("process.stdout.write('x'.repeat(2 * 1024 * 1024))"), 10_000);
    assert.equal((r as { reason: string }).reason, "failed");
  });
});
