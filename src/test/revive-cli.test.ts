import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildReviveBody, formatReviveResult } from "../commands/revive.js";
import { daemonRequest, type DaemonEndpoint } from "../daemon/client.js";

describe("buildReviveBody", () => {
  it("sends nothing at all when no flags are given", () => {
    // The daemon's defaults (LIVE-loop prompt, same agent) must stay in
    // charge of everything the operator didn't ask about.
    assert.deepEqual(buildReviveBody({}), {});
  });

  it("maps --no-prompt onto the API's snake_case no_prompt", () => {
    assert.deepEqual(buildReviveBody({ "no-prompt": true }), { no_prompt: true });
  });

  it("omits no_prompt when the flag is absent rather than sending false", () => {
    assert.deepEqual(buildReviveBody({ prompt: "carry on" }), { prompt: "carry on" });
  });

  it("passes --agent through for the agent-switch path", () => {
    assert.deepEqual(buildReviveBody({ agent: "goose", prompt: "hi" }), {
      agent: "goose",
      prompt: "hi",
    });
  });
});

describe("formatReviveResult", () => {
  it("names the revived session and its agent", () => {
    assert.equal(
      formatReviveResult("claude-abc12345", {
        status: "revived",
        nid: "claude-abc12345",
        agent: "claude",
      }),
      "Revived claude-abc12345 (claude)",
    );
  });

  it("reports an already-running session without claiming to have restarted it", () => {
    assert.equal(
      formatReviveResult("claude-abc12345", {
        status: "already_running",
        nid: "claude-abc12345",
        agent: "claude",
      }),
      "Session claude-abc12345 is already running.",
    );
  });

  it("names the twin, not the narrative it continues from", () => {
    // The distinction the old in-process CLI could not make: an absorbed or
    // agent-switched revive spawns a *new* narrative, and printing the
    // requested id would point the operator at the wrong pane.
    assert.equal(
      formatReviveResult("chatgpt-0f9e8d7c", {
        status: "continued",
        nid: "goose-11223344",
        agent: "goose",
      }),
      "Continued chatgpt-0f9e8d7c as goose-11223344 (goose)",
    );
  });

  it("degrades quietly when an older daemon doesn't report the agent", () => {
    assert.equal(
      formatReviveResult("claude-abc12345", { status: "revived", nid: "claude-abc12345" }),
      "Revived claude-abc12345",
    );
  });
});

describe("revive over daemonRequest", () => {
  let server: ReturnType<typeof createServer>;
  let endpoint: DaemonEndpoint;
  const seen: Array<{ method: string; url: string; body: string }> = [];

  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", body });
        if (req.url?.startsWith("/api/revive/claude-abc12345")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "revived", nid: "claude-abc12345", agent: "claude" }));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown narrative: nope" }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    endpoint = { baseUrl: `http://127.0.0.1:${port}`, token: "tok", port: String(port) };
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("POSTs the nid in the path and the flags in the body", async () => {
    const result = await daemonRequest<{ status: string; nid: string; agent: string }>(
      endpoint,
      `/api/revive/${encodeURIComponent("claude-abc12345")}`,
      { method: "POST", body: buildReviveBody({ prompt: "resume the audit" }) },
    );
    assert.equal(result.status, "revived");
    assert.equal(result.agent, "claude");
    const req = seen.find((r) => r.url === "/api/revive/claude-abc12345");
    assert.equal(req?.method, "POST");
    assert.deepEqual(JSON.parse(req?.body ?? "{}"), { prompt: "resume the audit" });
  });

  it("surfaces the daemon's unknown-narrative error verbatim", async () => {
    await assert.rejects(
      () =>
        daemonRequest(endpoint, "/api/revive/nope", { method: "POST", body: {} }),
      /^Error: Unknown narrative: nope$/,
    );
  });
});
