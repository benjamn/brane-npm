import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";

describe("agent name validation", () => {
  // Regex from doSpawn
  const VALID_AGENT = /^[a-zA-Z0-9_-]+$/;

  it("accepts valid agent names", () => {
    for (const name of ["claude", "goose", "codex", "my-agent", "agent_v2"]) {
      assert.ok(VALID_AGENT.test(name), `${name} should be valid`);
    }
  });

  it("rejects shell metacharacters", () => {
    for (const name of [
      "agent; rm -rf /",
      "$(whoami)",
      "`id`",
      "agent | cat /etc/passwd",
      "../../../etc/passwd",
      "agent name",
      "agent\nnewline",
    ]) {
      assert.ok(!VALID_AGENT.test(name), `${name} should be rejected`);
    }
  });
});

describe("static file path traversal", () => {
  const STATIC_DIR = "/app/expo/dist";

  function isAllowed(urlPath: string): boolean {
    const filePath = resolve(STATIC_DIR, urlPath === "/" ? "index.html" : urlPath.replace(/^\//, ""));
    return filePath === STATIC_DIR || filePath.startsWith(STATIC_DIR + "/");
  }

  it("allows normal paths", () => {
    assert.ok(isAllowed("/"));
    assert.ok(isAllowed("/index.html"));
    assert.ok(isAllowed("/assets/main.js"));
  });

  it("blocks path traversal", () => {
    assert.ok(!isAllowed("/../../../etc/passwd"));
    assert.ok(!isAllowed("/.."));
  });

  it("blocks prefix collision", () => {
    // If STATIC_DIR is /app/expo/dist, a path resolving to /app/expo/distevil should be blocked
    const evil = resolve(STATIC_DIR, "../distevil/file.txt");
    assert.ok(evil.startsWith(STATIC_DIR.slice(0, -1))); // would pass naive startsWith
    assert.ok(!isAllowed("/../distevil/file.txt")); // but our check blocks it
  });
});
