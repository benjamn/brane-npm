import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentArgs,
  codexLaunchArgs,
  codexReviveArgs,
  codexHelpHasNoDaemon,
  codexSupportsNoDaemon,
  kickoffPrompt,
  LIVE_LOOP_PROMPT,
} from "../commands/spawn.js";

// From `codex --help` on Codex CLI 0.163.0 (claude-q3m74dgm:36), the release
// that dropped `--full-auto` and runs MCP servers in a shared daemon.
const HELP_0_163 = `Usage: codex [OPTIONS] [PROMPT]
       codex [OPTIONS] <COMMAND> [ARGS]

Options:
  -c, --config <key=value>       Override a configuration value … parsed as TOML
  -s, --sandbox <SANDBOX_MODE>   [possible values: read-only, workspace-write, danger-full-access]
      --approve-for-me           Route approval requests through automatic review using the workspace-write sandbox
      --dangerously-bypass-approvals-and-sandbox
  -a, --ask-for-approval <APPROVAL_POLICY>   on-request | never
      --no-alt-screen            Disable alternate screen mode
      --no-daemon                Run without the shared background server, even if it is already running
`;

// An older codex: `--full-auto` still there, no shared daemon to opt out of.
const HELP_OLDER = `Usage: codex [OPTIONS] [PROMPT]

Options:
  -a, --ask-for-approval <APPROVAL_POLICY>
  -s, --sandbox <SANDBOX_MODE>
      --full-auto   Convenience alias for low-friction sandboxed automatic execution (-a on-request, --sandbox workspace-write)
      --no-alt-screen
`;

/** Every flag that occurs more than once: clap rejects a repeated flag. */
function repeatedFlags(argv: string[]): string[] {
  const seen = new Set<string>();
  const repeated: string[] = [];
  for (const a of argv) {
    if (!a.startsWith("-") || a === "-c") continue;
    const flag = a.split("=")[0];
    if (seen.has(flag)) repeated.push(flag);
    seen.add(flag);
  }
  return repeated;
}

describe("codexLaunchArgs", () => {
  // Codex 0.163 exits 2 on `--full-auto` before it logs a line, so every
  // fresh spawn died and the narrative held only its started event.
  it("never passes --full-auto, and grants what it granted", () => {
    const args = codexLaunchArgs({ noDaemon: true });
    assert.ok(!args.includes("--full-auto"));
    assert.deepEqual(args.slice(0, 4), ["-a", "on-request", "-s", "workspace-write"]);
  });

  // Attached to codex's shared daemon, `brane mcp` got the daemon's
  // BRANE_NARRATIVE_* — an earlier session's — and a 401 (claude-q3m74dgm:8).
  it("opts out of codex's shared daemon when the binary can", () => {
    assert.ok(codexLaunchArgs({ noDaemon: true }).includes("--no-daemon"));
    assert.ok(!codexLaunchArgs({ noDaemon: false }).includes("--no-daemon"));
  });

  it("is what a spawn passes, so spawn and revive share one line", () => {
    for (const passthrough of [[], ["--no-daemon"], ["--yolo"]]) {
      assert.deepEqual(
        buildAgentArgs("codex", { noDaemon: true, passthrough }),
        codexLaunchArgs({ noDaemon: true, passthrough }),
      );
    }
  });

  // Narratives spawned with `brane spawn codex -- --no-daemon` store it in
  // launch_args, and a revive appends those after the defaults.
  it("does not repeat a flag the passthrough sets", () => {
    for (const passthrough of [
      ["--no-daemon"],
      ["--no-alt-screen"],
      ["--model", "gpt-5"],
      ["-a", "never"],
      ["--sandbox=danger-full-access"],
    ]) {
      const argv = [...codexLaunchArgs({ model: "o3", noDaemon: true, passthrough }), ...passthrough];
      assert.deepEqual(repeatedFlags(argv), [], passthrough.join(" "));
    }
  });

  // clap rejects `--dangerously-bypass-approvals-and-sandbox` alongside
  // `-a`/`-s`, and an operator who names a whole policy means that one.
  it("leaves the policy to a passthrough that names a whole one", () => {
    for (const flag of ["--dangerously-bypass-approvals-and-sandbox", "--yolo", "--approve-for-me", "--full-auto"]) {
      const args = codexLaunchArgs({ noDaemon: true, passthrough: [flag] });
      assert.ok(!args.includes("-a") && !args.includes("-s"), flag);
      assert.ok(args.includes("--no-daemon"), flag);
    }
  });

  // `brane spawn codex -- -a never` still gets the workspace-write sandbox.
  it("replaces only the half a lone -a or -s names", () => {
    for (const passthrough of [["-a", "never"], ["--ask-for-approval=never"], ["-anever"]]) {
      const args = codexLaunchArgs({ noDaemon: true, passthrough });
      assert.ok(!args.includes("-a"), passthrough.join(" "));
      assert.deepEqual(args.slice(0, 2), ["-s", "workspace-write"], passthrough.join(" "));
    }
    for (const passthrough of [["-s", "read-only"], ["--sandbox=read-only"], ["-sread-only"]]) {
      const args = codexLaunchArgs({ noDaemon: true, passthrough });
      assert.ok(!args.includes("-s"), passthrough.join(" "));
      assert.deepEqual(args.slice(0, 2), ["-a", "on-request"], passthrough.join(" "));
    }
  });

  it("carries the model unless the passthrough picks one", () => {
    assert.deepEqual(codexLaunchArgs({ model: "o3", noDaemon: false }).slice(-2), ["--model", "o3"]);
    assert.ok(!codexLaunchArgs({ model: "o3", noDaemon: false, passthrough: ["-m", "gpt-5"] }).includes("--model"));
  });
});

describe("codexReviveArgs", () => {
  const resumeArgs = ["resume", "01a15a84-0000-0000-0000-000000000000"];

  // The bug lived here: revive passed `resume <id>` and the passthrough,
  // nothing else, so codex attached to its shared daemon.
  it("passes a spawn's root flags, then the passthrough, then resume", () => {
    const launchArgs = ["--search"];
    const args = codexReviveArgs({ noDaemon: true, launchArgs, resumeArgs });
    assert.deepEqual(args, [...codexLaunchArgs({ noDaemon: true, passthrough: launchArgs }), ...launchArgs, ...resumeArgs]);
    assert.deepEqual(args.slice(-2), resumeArgs);
    assert.ok(args.includes("--no-daemon"));
  });

  it("opts out of the shared daemon with nothing stored", () => {
    const args = codexReviveArgs({ noDaemon: true, launchArgs: [], resumeArgs });
    assert.ok(args.indexOf("--no-daemon") < args.indexOf("resume"));
    assert.ok(!args.includes("--full-auto"));
  });

  // Narratives spawned with `-- --no-daemon` (codex-aihzm7r8) store it.
  it("does not repeat a flag stored in launch_args", () => {
    const args = codexReviveArgs({ noDaemon: true, launchArgs: ["--no-daemon"], resumeArgs });
    assert.deepEqual(repeatedFlags(args), []);
    assert.ok(args.indexOf("--no-daemon") < args.indexOf("resume"));
  });

  it("leaves out --no-daemon for a codex without it", () => {
    const args = codexReviveArgs({ noDaemon: false, launchArgs: [], resumeArgs: [] });
    assert.deepEqual(args, codexLaunchArgs({ noDaemon: false }));
  });
});

describe("codexHelpHasNoDaemon", () => {
  it("finds --no-daemon in 0.163's help, and not in an older one", () => {
    assert.equal(codexHelpHasNoDaemon(HELP_0_163), true);
    assert.equal(codexHelpHasNoDaemon(HELP_OLDER), false);
  });

  it("does not take a longer flag for it", () => {
    assert.equal(codexHelpHasNoDaemon("      --no-daemonize   something else\n"), false);
  });
});

describe("codexSupportsNoDaemon", () => {
  function fakeCodex(dir: string, help: string): string {
    const bin = join(dir, "codex");
    writeFileSync(bin, `#!/bin/sh\ncat <<'EOF'\n${help}EOF\n`);
    chmodSync(bin, 0o755);
    return bin;
  }

  it("reads the binary's own --help", () => {
    const dir = mkdtempSync(join(tmpdir(), "brane-codex-"));
    assert.equal(codexSupportsNoDaemon(fakeCodex(dir, HELP_0_163)), true);
    const older = mkdtempSync(join(tmpdir(), "brane-codex-"));
    assert.equal(codexSupportsNoDaemon(fakeCodex(older, HELP_OLDER)), false);
  });

  it("re-reads after an in-place upgrade", () => {
    const dir = mkdtempSync(join(tmpdir(), "brane-codex-"));
    const bin = fakeCodex(dir, HELP_OLDER);
    utimesSync(bin, 1_000, 1_000);
    assert.equal(codexSupportsNoDaemon(bin), false);
    fakeCodex(dir, HELP_0_163);
    utimesSync(bin, 2_000, 2_000);
    assert.equal(codexSupportsNoDaemon(bin), true);
  });

  it("is false for a codex it cannot run", () => {
    assert.equal(codexSupportsNoDaemon(join(tmpdir(), "brane-no-such-codex")), false);
  });
});

describe("kickoffPrompt", () => {
  // codex-aihzm7r8:4: brane's tools sit inside codex's functions.exec.
  it("tells codex where its brane tools are, and nobody else", () => {
    assert.match(kickoffPrompt("codex", LIVE_LOOP_PROMPT), /functions\.exec.*mcp__brane__/);
    assert.ok(kickoffPrompt("codex", LIVE_LOOP_PROMPT).startsWith(LIVE_LOOP_PROMPT));
    assert.equal(kickoffPrompt("claude", LIVE_LOOP_PROMPT), LIVE_LOOP_PROMPT);
  });
});
