import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  withSessionAffinity,
  shellAffinityEnv,
  isFireworksBaseUrl,
  claudeSessionAffinityPath,
  ensureClaudeSessionAffinity,
  ensureSessionAffinityConfig,
} from "../session-affinity.js";

const FIREWORKS = "https://api.fireworks.ai/inference";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function affinityFileHeaders(path: string): string | undefined {
  const config = readJson(path);
  return (config.env as Record<string, string> | undefined)?.ANTHROPIC_CUSTOM_HEADERS;
}

/** Run a tmux-style env prefix through POSIX sh, the way tmux runs the
 *  session command, and report what the child sees. */
function headersUnderShell(prefix: string, inherited: string | undefined): string {
  const env = { ...process.env };
  if (inherited === undefined) delete env.ANTHROPIC_CUSTOM_HEADERS;
  else env.ANTHROPIC_CUSTOM_HEADERS = inherited;
  const out = spawnSync("/bin/sh", ["-c", `${prefix} node -e 'process.stdout.write(process.env.ANTHROPIC_CUSTOM_HEADERS)'`], {
    env,
    encoding: "utf-8",
  });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
}

/** Pin every env var the implementation consults, so a host that exports
 *  CLAUDE_CONFIG_DIR, ANTHROPIC_BASE_URL, or ANTHROPIC_CUSTOM_HEADERS can't
 *  leak into the assertions. */
function withCleanEnv(fn: () => void): void {
  const keys = ["CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function dirs() {
  return {
    fold: tempDir("brane-affinity-fold-"),
    home: tempDir("brane-affinity-home-"),
    braneDir: tempDir("brane-affinity-dir-"),
  };
}

describe("withSessionAffinity", () => {
  it("appends to an empty or absent blob", () => {
    assert.equal(withSessionAffinity(undefined, "claude-abc123"), "X-Session-Affinity: claude-abc123");
    assert.equal(withSessionAffinity("", "claude-abc123"), "X-Session-Affinity: claude-abc123");
  });

  it("preserves unrelated lines verbatim and in order", () => {
    const existing = "Authorization: Bearer fw-key-123\nX-Other: keepme";
    assert.equal(
      withSessionAffinity(existing, "claude-abc123"),
      "Authorization: Bearer fw-key-123\nX-Other: keepme\nX-Session-Affinity: claude-abc123",
    );
  });

  it("replaces a prior affinity line rather than accumulating", () => {
    const first = withSessionAffinity("Authorization: Bearer k", "claude-aaa111");
    const second = withSessionAffinity(first, "claude-bbb222");
    assert.equal(second, "Authorization: Bearer k\nX-Session-Affinity: claude-bbb222");
  });

  it("matches the header name case-insensitively, the way Claude Code parses", () => {
    const out = withSessionAffinity("x-session-affinity: stale\nAuthorization: Bearer k", "claude-abc123");
    assert.equal(out, "Authorization: Bearer k\nX-Session-Affinity: claude-abc123");
  });

  it("tolerates CRLF input without emitting CR", () => {
    const out = withSessionAffinity("Authorization: Bearer k\r\nX-Other: v", "claude-abc123");
    assert.equal(out, "Authorization: Bearer k\nX-Other: v\nX-Session-Affinity: claude-abc123");
  });
});

describe("isFireworksBaseUrl", () => {
  it("matches fireworks.ai hosts only", () => {
    assert.equal(isFireworksBaseUrl("https://api.fireworks.ai/inference"), true);
    assert.equal(isFireworksBaseUrl("https://fireworks.ai"), true);
    assert.equal(isFireworksBaseUrl("https://api.anthropic.com"), false);
    assert.equal(isFireworksBaseUrl("https://proxy.example.com/fireworks.ai/v1"), false);
    assert.equal(isFireworksBaseUrl("https://notfireworks.ai"), false);
    assert.equal(isFireworksBaseUrl("not a url"), false);
    assert.equal(isFireworksBaseUrl(undefined), false);
  });
});

describe("shellAffinityEnv", () => {
  it("appends to the headers the session's shell inherited", () => {
    assert.equal(
      headersUnderShell(shellAffinityEnv("claude-sh1"), "Authorization: Bearer shell-only"),
      "Authorization: Bearer shell-only\nX-Session-Affinity: claude-sh1",
    );
  });

  it("adds no leading newline when nothing was inherited", () => {
    assert.equal(headersUnderShell(shellAffinityEnv("claude-sh2"), undefined), "X-Session-Affinity: claude-sh2");
    assert.equal(headersUnderShell(shellAffinityEnv("claude-sh3"), ""), "X-Session-Affinity: claude-sh3");
  });
});

describe("ensureClaudeSessionAffinity", () => {
  it("does nothing when the session does not talk to Fireworks", () => {
    const { fold, home, braneDir } = dirs();
    writeJson(join(fold, ".claude", "settings.local.json"), {
      env: { ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer k" },
    });
    withCleanEnv(() => {
      assert.deepEqual(ensureClaudeSessionAffinity(fold, "claude-anth01", { homeDir: home, braneDir }), {
        args: [],
        env: "",
      });
      process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
      assert.deepEqual(ensureClaudeSessionAffinity(fold, "claude-anth01", { homeDir: home, braneDir }), {
        args: [],
        env: "",
      });
    });
    assert.equal(existsSync(join(braneDir, "session-affinity")), false);
  });

  it("uses the shell prefix, not a file, when no settings file defines the headers", () => {
    const { fold, home, braneDir } = dirs();
    writeJson(join(fold, ".claude", "settings.local.json"), { env: { ANTHROPIC_BASE_URL: FIREWORKS } });
    withCleanEnv(() => {
      // A daemon-side value must not be pinned: the session inherits from tmux.
      process.env.ANTHROPIC_CUSTOM_HEADERS = "X-Daemon-Only: yes";
      const launch = ensureClaudeSessionAffinity(fold, "claude-shell1", { homeDir: home, braneDir });
      assert.deepEqual(launch, { args: [], env: shellAffinityEnv("claude-shell1") });
    });
    assert.equal(existsSync(join(braneDir, "session-affinity")), false);
  });

  it("takes the Fireworks base URL from the daemon env when no settings file sets one", () => {
    const { fold, home, braneDir } = dirs();
    withCleanEnv(() => {
      process.env.ANTHROPIC_BASE_URL = FIREWORKS;
      const launch = ensureClaudeSessionAffinity(fold, "claude-envurl", { homeDir: home, braneDir });
      assert.equal(launch.env, shellAffinityEnv("claude-envurl"));
    });
  });

  it("writes a private per-narrative --settings file when a settings file defines the headers", () => {
    const { fold, home, braneDir } = dirs();
    writeJson(join(fold, ".claude", "settings.local.json"), {
      env: { ANTHROPIC_BASE_URL: FIREWORKS, ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer fw-secret" },
    });
    withCleanEnv(() => {
      const launch = ensureClaudeSessionAffinity(fold, "claude-new123", { homeDir: home, braneDir });
      const path = join(braneDir, "session-affinity", "claude-new123.json");
      assert.deepEqual(launch, { args: ["--settings", path], env: "" });
      assert.equal(affinityFileHeaders(path), "Authorization: Bearer fw-secret\nX-Session-Affinity: claude-new123");
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
    });
  });

  it("tightens a file and directory written with looser permissions", () => {
    const { fold, home, braneDir } = dirs();
    writeJson(join(fold, ".claude", "settings.local.json"), {
      env: { ANTHROPIC_BASE_URL: FIREWORKS, ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer k" },
    });
    const path = claudeSessionAffinityPath("claude-loose1", { braneDir });
    withCleanEnv(() => {
      ensureClaudeSessionAffinity(fold, "claude-loose1", { homeDir: home, braneDir });
      chmodSync(path, 0o644);
      chmodSync(dirname(path), 0o755);
      ensureClaudeSessionAffinity(fold, "claude-loose1", { homeDir: home, braneDir });
    });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  });

  it("gives concurrent same-fold narratives distinct files and leaves the fold file alone", () => {
    const { fold, home, braneDir } = dirs();
    const localPath = join(fold, ".claude", "settings.local.json");
    writeJson(localPath, {
      env: { ANTHROPIC_BASE_URL: FIREWORKS, ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer fw-secret" },
    });
    const before = readFileSync(localPath, "utf-8");
    withCleanEnv(() => {
      const a = ensureClaudeSessionAffinity(fold, "claude-aaa111", { homeDir: home, braneDir }).args[1];
      const b = ensureClaudeSessionAffinity(fold, "claude-bbb222", { homeDir: home, braneDir }).args[1];
      assert.notEqual(a, b);
      assert.equal(affinityFileHeaders(a), "Authorization: Bearer fw-secret\nX-Session-Affinity: claude-aaa111");
      assert.equal(affinityFileHeaders(b), "Authorization: Bearer fw-secret\nX-Session-Affinity: claude-bbb222");
    });
    assert.equal(readFileSync(localPath, "utf-8"), before);
  });

  it("prefers local over project over user, for both variables independently", () => {
    const { fold, home, braneDir } = dirs();
    writeJson(join(home, ".claude", "settings.json"), {
      env: { ANTHROPIC_BASE_URL: FIREWORKS, ANTHROPIC_CUSTOM_HEADERS: "X-Source: user" },
    });
    writeJson(join(fold, ".claude", "settings.json"), { env: { ANTHROPIC_CUSTOM_HEADERS: "X-Source: project" } });

    withCleanEnv(() => {
      // Base URL from user settings, headers from project: project beats user.
      let path = ensureClaudeSessionAffinity(fold, "claude-src111", { homeDir: home, braneDir }).args[1];
      assert.match(affinityFileHeaders(path)!, /^X-Source: project\n/);

      writeJson(join(fold, ".claude", "settings.local.json"), { env: { ANTHROPIC_CUSTOM_HEADERS: "X-Source: local" } });
      path = ensureClaudeSessionAffinity(fold, "claude-src111", { homeDir: home, braneDir }).args[1];
      assert.match(affinityFileHeaders(path)!, /^X-Source: local\n/);

      // A higher-precedence non-Fireworks base URL turns it off.
      writeJson(join(fold, ".claude", "settings.local.json"), {
        env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_CUSTOM_HEADERS: "X-Source: local" },
      });
      assert.deepEqual(ensureClaudeSessionAffinity(fold, "claude-src111", { homeDir: home, braneDir }).args, []);
    });
  });

  it("treats a broken candidate file as absent and never writes to it", () => {
    const { fold, home, braneDir } = dirs();
    const localPath = join(fold, ".claude", "settings.local.json");
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, "{ not json — operator will fix by hand");
    writeJson(join(fold, ".claude", "settings.json"), {
      env: { ANTHROPIC_BASE_URL: FIREWORKS, ANTHROPIC_CUSTOM_HEADERS: "X-Source: project" },
    });

    withCleanEnv(() => {
      const path = ensureClaudeSessionAffinity(fold, "claude-nope00", { homeDir: home, braneDir }).args[1];
      assert.equal(affinityFileHeaders(path), "X-Source: project\nX-Session-Affinity: claude-nope00");
    });
    assert.equal(readFileSync(localPath, "utf-8"), "{ not json — operator will fix by hand");
  });

  it("is idempotent: a second identical call does not rewrite the file", () => {
    const { fold, home, braneDir } = dirs();
    writeJson(join(fold, ".claude", "settings.local.json"), {
      env: { ANTHROPIC_BASE_URL: FIREWORKS, ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer k" },
    });
    const path = claudeSessionAffinityPath("claude-same1", { braneDir });
    withCleanEnv(() => ensureClaudeSessionAffinity(fold, "claude-same1", { homeDir: home, braneDir }));
    const before = statSync(path).mtimeMs;
    withCleanEnv(() => ensureClaudeSessionAffinity(fold, "claude-same1", { homeDir: home, braneDir }));
    assert.equal(statSync(path).mtimeMs, before);
  });
});

describe("ensureSessionAffinityConfig", () => {
  function fireworksFold() {
    const d = dirs();
    writeJson(join(d.fold, ".claude", "settings.local.json"), {
      env: { ANTHROPIC_BASE_URL: FIREWORKS, ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer k" },
    });
    return d;
  }

  it("returns claude's --settings args", () => {
    const { fold, home, braneDir } = fireworksFold();
    withCleanEnv(() => {
      const launch = ensureSessionAffinityConfig("claude", fold, "claude-entry1", { enabled: true, homeDir: home, braneDir });
      assert.deepEqual(launch, { args: ["--settings", claudeSessionAffinityPath("claude-entry1", { braneDir })], env: "" });
    });
  });

  it("does nothing when opted out", () => {
    const { fold, home, braneDir } = fireworksFold();
    withCleanEnv(() => {
      const launch = ensureSessionAffinityConfig("claude", fold, "claude-off1", { enabled: false, homeDir: home, braneDir });
      assert.deepEqual(launch, { args: [], env: "" });
    });
    assert.equal(existsSync(join(braneDir, "session-affinity")), false);
  });

  it("does nothing for other agents — crush sends its own affinity header", () => {
    const { fold, home, braneDir } = fireworksFold();
    withCleanEnv(() => {
      for (const agent of ["crush", "goose", "codex", "gemini"]) {
        assert.deepEqual(ensureSessionAffinityConfig(agent, fold, "x-other1", { enabled: true, homeDir: home, braneDir }), {
          args: [],
          env: "",
        });
      }
    });
  });

  it("degrades to no affinity, not a failed launch, when the file cannot be written", () => {
    const { fold, home } = fireworksFold();
    // A regular file where the brane dir should be makes the mkdir throw.
    const blocked = join(tempDir("brane-affinity-blocked-"), "not-a-dir");
    writeFileSync(blocked, "");
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      withCleanEnv(() => {
        const launch = ensureSessionAffinityConfig("claude", fold, "claude-err1", {
          enabled: true,
          homeDir: home,
          braneDir: blocked,
        });
        assert.deepEqual(launch, { args: [], env: "" });
      });
    } finally {
      console.error = original;
    }
    assert.equal(logged.length, 1);
  });
});
