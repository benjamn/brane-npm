import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { listenTimeoutFor } from "../daemon/server.js";

describe("listenTimeoutFor", () => {
  // claude's stdio idle timeout is raised to 1h by the .mcp.json `timeout`
  // knob (spawn.ts, MCP_TOOL_TIMEOUT_MS), so claude can hold ~1h. 3400s sits
  // under that ceiling and under the 1h prompt-cache TTL.
  it("holds claude for ~1h (3400s)", () => {
    assert.equal(listenTimeoutFor("claude"), 3_400_000);
  });

  // Every other agent keeps the conservative 270s hold until it has been
  // observed honoring its own timeout knob — codex/copilot default to ~60s
  // and would abort a longer hold every idle cycle. A raise must be per-type,
  // never a global flip, so unknown/other types must fall through to default.
  it("keeps non-claude agents at 270s", () => {
    assert.equal(listenTimeoutFor("codex"), 270_000);
    assert.equal(listenTimeoutFor("copilot"), 270_000);
    assert.equal(listenTimeoutFor("goose"), 270_000);
    assert.equal(listenTimeoutFor("gemini"), 270_000);
    assert.equal(listenTimeoutFor("amp"), 270_000);
  });

  it("defaults to 270s for unknown or missing agent type", () => {
    assert.equal(listenTimeoutFor(undefined), 270_000);
    assert.equal(listenTimeoutFor(""), 270_000);
    assert.equal(listenTimeoutFor("some-future-agent"), 270_000);
  });

  it("chosen claude hold stays under the 1h cache TTL and the 1h client ceiling", () => {
    // If this ever fails, an idle self-wake would race the cache TTL / the
    // client's tool-call abort instead of landing safely under both.
    assert.ok(listenTimeoutFor("claude") < 3_600_000);
  });
});
