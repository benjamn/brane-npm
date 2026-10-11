import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { getAgentAdapter } from "../agents.js";

describe("claudeAdapter.resumeArgs", () => {
  // Regression: previously, resumeArgs fell back to discoverSessionId(foldPath),
  // which scans the fold-wide project dir and returns the most-recently-modified
  // .jsonl. Two narratives sharing a fold could revive each other's sessions.
  it("returns [] when sessionId is missing (does not fall back to fold-wide discovery)", () => {
    const adapter = getAgentAdapter("claude");
    assert.deepEqual(adapter.resumeArgs({ foldPath: "/Users/nobody/nonexistent" }), []);
    assert.deepEqual(
      adapter.resumeArgs({ sessionId: undefined, foldPath: "/Users/nobody/nonexistent" }),
      [],
    );
  });

  it("returns [] when sessionId points at a non-existent .jsonl", () => {
    const adapter = getAgentAdapter("claude");
    const args = adapter.resumeArgs({
      sessionId: "00000000-0000-0000-0000-000000000000",
      foldPath: "/Users/nobody/nonexistent",
    });
    assert.deepEqual(args, []);
  });

  // Regression: a plain `--resume` rotates to a fresh session id that the
  // daemon never learns, stranding agent_session_id on the dead predecessor
  // (frozen cost readings; next revive resumes the pre-revive fork point).
  // With a daemon-minted newSessionId, every launch shape must pin it.
  it("pins newSessionId on a fresh start (no resumable session)", () => {
    const adapter = getAgentAdapter("claude");
    assert.deepEqual(
      adapter.resumeArgs({ foldPath: "/Users/nobody/nonexistent", newSessionId: "new-id" }),
      ["--session-id", "new-id"],
    );
    assert.deepEqual(
      adapter.resumeArgs({
        sessionId: "00000000-0000-0000-0000-000000000000",
        foldPath: "/Users/nobody/nonexistent",
        newSessionId: "new-id",
      }),
      ["--session-id", "new-id"],
    );
  });

  it("resumes fork-style with a pinned id whenever newSessionId is supplied", (t) => {
    const adapter = getAgentAdapter("claude");
    const foldPath = mkdtempSync(join(tmpdir(), "brane-agents-test-"));
    const cwdEncoded = foldPath.replace(/\//g, "-");
    const projectDir = join(homedir(), ".claude", "projects", cwdEncoded);
    mkdirSync(projectDir, { recursive: true });
    const sessionId = "11111111-1111-1111-1111-111111111111";
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), "");
    t.after(() => rmSync(projectDir, { recursive: true, force: true }));

    // Pinned resume always forks, live or dead — rotation happens either way,
    // and forking is the shape that lets the daemon own the successor's id.
    assert.deepEqual(
      adapter.resumeArgs({ sessionId, foldPath, newSessionId: "new-id" }),
      ["--resume", sessionId, "--fork-session", "--session-id", "new-id"],
    );
    assert.deepEqual(
      adapter.resumeArgs({ sessionId, foldPath, forkSession: true, newSessionId: "new-id" }),
      ["--resume", sessionId, "--fork-session", "--session-id", "new-id"],
    );
    // Un-pinned shapes are unchanged (no daemon-minted id supplied).
    assert.deepEqual(
      adapter.resumeArgs({ sessionId, foldPath, forkSession: true }),
      ["--resume", sessionId, "--fork-session"],
    );
    assert.deepEqual(adapter.resumeArgs({ sessionId, foldPath }), ["--resume", sessionId]);
  });
});
