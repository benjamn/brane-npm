import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestDb } from "./helpers.js";
import {
  ensureClaudeHookConfig,
  ensureGooseHookConfig,
  ensureClineHookConfig,
  ensureHookConfig,
} from "../commands/spawn.js";
import { reviveNarrative } from "../daemon/server.js";

const HOOK_PATH = "/api/hooks/tool-use";

function seedDaemon(db: ReturnType<typeof createTestDb>, port: string, httpPort?: string): void {
  const rows: Array<[string, string]> = [
    ["daemon_port", port],
    ["daemon_token", "tok"],
    // Our own pid is alive, so getDaemonInfo's liveness check passes.
    ["daemon_pid", String(process.pid)],
  ];
  // The http-fallback row only routes hooks when TLS is live (the row
  // survives shutdown as a hint, so presence alone must not be trusted).
  rows.push(["daemon_tls", httpPort ? "true" : "false"]);
  if (httpPort) rows.push(["daemon_http_port", httpPort]);
  for (const [key, value] of rows) {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }
}

type HookEntry = { matcher?: string; hooks?: Array<{ url?: string }> };

function readSettings(fold: string): {
  hooks?: { PreToolUse?: HookEntry[]; PostToolUse?: HookEntry[] };
  [key: string]: unknown;
} {
  return JSON.parse(readFileSync(join(fold, ".claude", "settings.local.json"), "utf-8"));
}

describe("ensureClaudeHookConfig", () => {
  it("writes a PostToolUse entry pointed at the daemon, capturing every tool", () => {
    const db = createTestDb();
    seedDaemon(db, "4321");
    const fold = mkdtempSync(join(tmpdir(), "brane-hook-"));

    ensureClaudeHookConfig(db, fold);
    const entry = readSettings(fold).hooks!.PostToolUse![0];
    assert.equal(entry.hooks![0].url, `http://127.0.0.1:4321${HOOK_PATH}`);

    // Nothing is excluded at the hook: what the client shows is a render
    // decision, and a call the hook never saw can't be recovered later.
    const matcher = new RegExp(entry.matcher!);
    assert.ok(matcher.test("Bash"), "ordinary tools must match");
    assert.ok(matcher.test("mcp__brane__whoami"), "other brane tools are captured, filtered at render");
    assert.ok(matcher.test("mcp__brane__listen"), "listen is captured — idle time is worth showing");
    assert.ok(matcher.test("mcp__brane__narrate"), "narrate is captured — foreign narration is invisible otherwise");
  });

  // Both ends of every call: PostToolUse can only report a call once it's
  // over, so the chat stays silent while a long tool runs.
  it("registers the same entry on PreToolUse so a call is visible as it starts", () => {
    const db = createTestDb();
    seedDaemon(db, "4321");
    const fold = mkdtempSync(join(tmpdir(), "brane-hook-"));

    ensureClaudeHookConfig(db, fold);
    const settings = readSettings(fold);
    assert.deepEqual(settings.hooks!.PreToolUse![0], settings.hooks!.PostToolUse![0]);
  });

  it("prefers the HTTP fallback port when TLS is active", () => {
    const db = createTestDb();
    seedDaemon(db, "4321", "8888");
    const fold = mkdtempSync(join(tmpdir(), "brane-hook-"));
    ensureClaudeHookConfig(db, fold);
    const entry = readSettings(fold).hooks!.PostToolUse![0];
    assert.equal(entry.hooks![0].url, `http://127.0.0.1:8888${HOOK_PATH}`);
  });

  it("ignores a surviving daemon_http_port row when TLS is off", () => {
    const db = createTestDb();
    seedDaemon(db, "4321");
    // The row outlives shutdown as a stability hint for the next TLS run —
    // its presence alone must not route hooks to a port nothing listens on.
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('daemon_http_port', '9999')").run();
    const fold = mkdtempSync(join(tmpdir(), "brane-hook-"));
    ensureClaudeHookConfig(db, fold);
    const entry = readSettings(fold).hooks!.PostToolUse![0];
    assert.equal(entry.hooks![0].url, `http://127.0.0.1:4321${HOOK_PATH}`);
  });

  it("is idempotent and heals port drift in place", () => {
    const db = createTestDb();
    seedDaemon(db, "4321");
    const fold = mkdtempSync(join(tmpdir(), "brane-hook-"));

    ensureClaudeHookConfig(db, fold);
    ensureClaudeHookConfig(db, fold);
    assert.equal(readSettings(fold).hooks!.PostToolUse!.length, 1);
    assert.equal(readSettings(fold).hooks!.PreToolUse!.length, 1);

    seedDaemon(db, "5555");
    ensureClaudeHookConfig(db, fold);
    for (const event of ["PreToolUse", "PostToolUse"] as const) {
      const entries = readSettings(fold).hooks![event]!;
      assert.equal(entries.length, 1, `${event}: stale entry is replaced, not duplicated`);
      assert.equal(entries[0].hooks![0].url, `http://127.0.0.1:5555${HOOK_PATH}`);
    }
  });

  it("merges around the user's own settings and hooks instead of clobbering them", () => {
    const db = createTestDb();
    seedDaemon(db, "4321");
    const fold = mkdtempSync(join(tmpdir(), "brane-hook-"));
    mkdirSync(join(fold, ".claude"), { recursive: true });
    writeFileSync(
      join(fold, ".claude", "settings.local.json"),
      JSON.stringify({
        permissions: { allow: ["Bash(ls:*)"] },
        hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "echo hi" }] }] },
      }),
    );

    ensureClaudeHookConfig(db, fold);
    const settings = readSettings(fold);
    assert.deepEqual(settings.permissions, { allow: ["Bash(ls:*)"] });
    assert.equal(settings.hooks!.PostToolUse!.length, 2);
    assert.equal(settings.hooks!.PostToolUse![0].matcher, "Edit");
  });

  it("degrades silently when no daemon is running", () => {
    const db = createTestDb();
    const fold = mkdtempSync(join(tmpdir(), "brane-hook-"));
    ensureClaudeHookConfig(db, fold);
    assert.ok(!existsSync(join(fold, ".claude", "settings.local.json")));
  });
});

// The other harnesses execute commands rather than speaking HTTP themselves,
// so their "hook" is a script brane writes. What the script must not do is the
// interesting part — see braneHookScript.
describe("the hook script the non-Claude harnesses run", () => {
  function scriptFor(agent: string, fold: string, nid: string, port = "4321"): string {
    const db = createTestDb();
    seedDaemon(db, port);
    ensureHookConfig(db, agent, fold, nid);
    return readFileSync(
      agent === "goose"
        ? join(fold, ".agents", "plugins", "brane", "hooks", "report-tool-use.sh")
        : join("/tmp", `brane-cline-${nid}`, "hooks", "PreToolUse"),
      "utf-8",
    );
  }

  it("exits 0 whatever curl does, so recording never vetoes a tool call", () => {
    const fold = mkdtempSync(join(tmpdir(), "brane-hook-"));
    const script = scriptFor("goose", fold, "claude-nid00001");
    // In goose and crush a hook's exit code is a verdict: 2 blocks the call, and
    // crush reads 49 as halt-the-turn. curl's own failures live in that space
    // (7 refused, 28 timeout), so an escaping status would let a daemon restart
    // cancel an agent's work.
    assert.match(script, /\nexit 0\n/);
    assert.doesNotMatch(script, /\bexec curl/, "exec would hand curl's status to the harness");
  });

  it("says nothing on stdout, which cline parses as control output", () => {
    const fold = mkdtempSync(join(tmpdir(), "brane-hook-"));
    const script = scriptFor("cline", fold, "claude-nid00002");
    assert.match(script, />\/dev\/null 2>&1/);
  });

  it("reads auth from the environment, never the daemon's bearer token", () => {
    const fold = mkdtempSync(join(tmpdir(), "brane-hook-"));
    const script = scriptFor("goose", fold, "claude-nid00003");
    assert.match(script, /X-Brane-Narrative-Id: \$\{BRANE_NARRATIVE_ID\}/);
    assert.match(script, /X-Brane-Narrative-Secret: \$\{BRANE_NARRATIVE_SECRET\}/);
    assert.doesNotMatch(script, /\btok\b/, "the daemon token must never reach disk");
  });

  it("is executable, and stays executable when it is rewritten", () => {
    const fold = mkdtempSync(join(tmpdir(), "brane-hook-"));
    scriptFor("goose", fold, "claude-nid00004");
    const path = join(fold, ".agents", "plugins", "brane", "hooks", "report-tool-use.sh");
    assert.equal(statSync(path).mode & 0o111, 0o111, "a hook the harness cannot execute is no hook");

    // writeFileSync's `mode` applies only on creation, so every rewrite after
    // the first — a port drift, a change to the script — lands on an existing
    // file and silently ignores it. A script that lost its execute bit would
    // never get it back, and the harness would just stop running the hook.
    chmodSync(path, 0o644);
    const db = createTestDb();
    seedDaemon(db, "5555");
    ensureGooseHookConfig(db, fold);
    assert.equal(statSync(path).mode & 0o111, 0o111, "the rewrite restores the execute bit");

    // And the same is true when only the mode is wrong: an unchanged script
    // must still be repaired rather than short-circuited as already current.
    chmodSync(path, 0o644);
    ensureGooseHookConfig(db, fold);
    assert.equal(statSync(path).mode & 0o111, 0o111);
  });
});

describe("ensureGooseHookConfig", () => {
  const pluginHooks = (fold: string) => join(fold, ".agents", "plugins", "brane", "hooks");

  it("writes an Open Plugins hooks.json wired to the script beside it", () => {
    const db = createTestDb();
    seedDaemon(db, "4321");
    const fold = mkdtempSync(join(tmpdir(), "brane-hook-"));

    ensureGooseHookConfig(db, fold);
    const config = JSON.parse(readFileSync(join(pluginHooks(fold), "hooks.json"), "utf-8"));
    const rule = config.hooks.PreToolUse[0];
    assert.equal(rule.matcher, ".*");
    assert.equal(rule.hooks[0].type, "command", "goose has no HTTP hook type");
    assert.equal(rule.hooks[0].command, join(pluginHooks(fold), "report-tool-use.sh"));
    assert.ok(existsSync(rule.hooks[0].command), "the command it names must exist");
  });

  // goose reports a failed call as its own event rather than as a field on the
  // ordinary one — the plain PostToolUse never fires — so a tool that failed
  // would sit pending forever without this.
  it("registers PostToolUseFailure, or failures never complete", () => {
    const db = createTestDb();
    seedDaemon(db, "4321");
    const fold = mkdtempSync(join(tmpdir(), "brane-hook-"));

    ensureGooseHookConfig(db, fold);
    const config = JSON.parse(readFileSync(join(pluginHooks(fold), "hooks.json"), "utf-8"));
    assert.deepEqual(Object.keys(config.hooks).sort(), [
      "PostToolUse",
      "PostToolUseFailure",
      "PreToolUse",
    ]);
  });

  it("heals port drift in the script and is otherwise idempotent", () => {
    const fold = mkdtempSync(join(tmpdir(), "brane-hook-"));
    const db = createTestDb();
    seedDaemon(db, "4321");
    ensureGooseHookConfig(db, fold);
    const first = statSync(join(pluginHooks(fold), "report-tool-use.sh")).mtimeMs;
    ensureGooseHookConfig(db, fold);
    assert.equal(
      statSync(join(pluginHooks(fold), "report-tool-use.sh")).mtimeMs,
      first,
      "an unchanged script is left alone — this runs on every spawn and revive",
    );

    seedDaemon(db, "5555");
    ensureGooseHookConfig(db, fold);
    assert.match(
      readFileSync(join(pluginHooks(fold), "report-tool-use.sh"), "utf-8"),
      /127\.0\.0\.1:5555/,
    );
  });

  it("prefers the HTTP fallback port when TLS is active", () => {
    const db = createTestDb();
    seedDaemon(db, "4321", "8080");
    const fold = mkdtempSync(join(tmpdir(), "brane-hook-"));
    ensureGooseHookConfig(db, fold);
    assert.match(
      readFileSync(join(pluginHooks(fold), "report-tool-use.sh"), "utf-8"),
      new RegExp(`http://127\\.0\\.0\\.1:8080${HOOK_PATH}`),
    );
  });

  it("degrades silently when no daemon is running", () => {
    const db = createTestDb();
    const fold = mkdtempSync(join(tmpdir(), "brane-hook-"));
    ensureGooseHookConfig(db, fold);
    assert.ok(!existsSync(join(fold, ".agents")));
  });
});

describe("ensureClineHookConfig", () => {
  it("names one script per event in the config dir brane already owns", () => {
    const db = createTestDb();
    seedDaemon(db, "4321");
    const nid = `claude-t${Math.floor(Date.now() % 1e6)}`;

    ensureClineHookConfig(db, nid);
    // cline discovers hooks by filename, and its hooks dir follows --config —
    // which brane sets to this per-narrative directory. Nothing in the
    // operator's fold is touched.
    for (const event of ["PreToolUse", "PostToolUse"]) {
      assert.ok(existsSync(join("/tmp", `brane-cline-${nid}`, "hooks", event)));
    }
  });

  it("degrades silently when no daemon is running", () => {
    const db = createTestDb();
    const nid = `claude-u${Math.floor(Date.now() % 1e6)}`;
    ensureClineHookConfig(db, nid);
    assert.ok(!existsSync(join("/tmp", `brane-cline-${nid}`, "hooks")));
  });
});

describe("ensureHookConfig", () => {
  it("installs nothing for an agent with no capture path", () => {
    const db = createTestDb();
    seedDaemon(db, "4321");
    const fold = mkdtempSync(join(tmpdir(), "brane-hook-"));

    // crush has a PreToolUse hook but no PostToolUse event, and its pre payload
    // carries no call id to pair the halves with — so a hook here would strand
    // every call pending. Its completions come from its session log instead.
    for (const agent of ["crush", "codex", "gemini", "amp", "copilot"]) {
      ensureHookConfig(db, agent, fold, "claude-nid00005");
    }
    assert.ok(!existsSync(join(fold, ".claude")));
    assert.ok(!existsSync(join(fold, ".agents")));
  });

  it("never throws — capture is optional and must not fail a spawn", () => {
    const db = createTestDb();
    seedDaemon(db, "4321");
    // A fold path that cannot be written to: the spawn still has to proceed.
    assert.doesNotThrow(() => ensureHookConfig(db, "goose", "/dev/null/nope", "claude-nid00006"));
  });
});

describe("reviveNarrative", () => {
  // A daemon that comes back on another port leaves every fold's hook config
  // naming the dead one. Fresh spawns rewrote it; a same-agent revive didn't,
  // so on Fly, where every boot moved the port, revived sessions failed every
  // tool call's hook (claude-nkrks0of:23).
  it("repoints a stale hook config before it launches anything", (t) => {
    // With no `claude` reachable the revive fails at resolving the agent,
    // after the hook config and before any token or tmux session exists.
    // resolveAgentCommand's fallback is node_modules/.bin two levels above
    // the entry script; if one is there, this would launch a real agent.
    const fallback = resolve(process.argv[1], "../..", "node_modules", ".bin", "claude");
    if (existsSync(fallback)) return t.skip(`${fallback} exists`);

    const db = createTestDb();
    seedDaemon(db, "4321", "46347");
    const fold = mkdtempSync(join(tmpdir(), "brane-hook-"));
    const stale = `http://127.0.0.1:39287${HOOK_PATH}`;
    mkdirSync(join(fold, ".claude"));
    writeFileSync(
      join(fold, ".claude", "settings.local.json"),
      JSON.stringify({
        hooks: { PostToolUse: [{ matcher: ".*", hooks: [{ type: "http", url: stale }] }] },
      }),
    );
    db.prepare(
      "INSERT INTO narratives (id, brane_id, agent_type, role, status, fold_path, created_at) VALUES ('claude-rev00001', 'brane-test', 'claude', 'worker', 'ended', ?, ?)",
    ).run(fold, Date.now());

    const path = process.env.PATH;
    process.env.PATH = mkdtempSync(join(tmpdir(), "brane-empty-path-"));
    try {
      assert.throws(() => reviveNarrative(db, "claude-rev00001"), /Agent command not found: claude/);
    } finally {
      process.env.PATH = path;
    }

    const settings = readSettings(fold);
    for (const event of ["PreToolUse", "PostToolUse"] as const) {
      assert.equal(settings.hooks![event]![0].hooks![0].url, `http://127.0.0.1:46347${HOOK_PATH}`, event);
    }
  });
});
