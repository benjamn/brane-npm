/**
 * What an agent's token may reach (src/daemon/agent-scope.ts): a
 * default-deny list of routes, and only from this machine.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  AGENT_LOOPBACK_REFUSAL,
  AGENT_REVIVE_REFUSAL,
  AGENT_ROUTES,
  AGENT_SCOPE_REFUSAL,
  AGENT_SLEEP_REFUSAL,
  agentMayUse,
  agentRefusal,
  agentReviveRefusal,
} from "../daemon/agent-scope.js";
import { markUnixConnection } from "../daemon/local-socket.js";
import { agentRequestRefusal, reviveNarrative } from "../daemon/server.js";
import { createTestDb } from "./helpers.js";

describe("agentMayUse", () => {
  it("opens reading brane and the session lifecycle agents drive", () => {
    for (const [method, path] of [
      ["GET", "/api/status"],
      ["GET", "/api/narratives"],
      ["GET", "/api/narratives/recent"],
      ["GET", "/api/narratives/claude-abcd1234"],
      ["GET", "/api/narratives/claude-abcd1234/events"],
      ["GET", "/api/narratives/claude-abcd1234/tool_uses/k1"],
      ["GET", "/api/payloads/claude-abcd1234/42_0.png"],
      ["GET", "/api/payloads/claude-abcd1234/nested/file.txt"],
      ["GET", "/api/files/find"],
      ["POST", "/api/search"],
      ["POST", "/api/spawn"],
      ["POST", "/api/revive/claude-abcd1234"],
      ["GET", "/ws/mcp"],
    ]) {
      assert.equal(agentMayUse(method, path), true, `${method} ${path}`);
    }
  });

  it("closes the app's channels, signals, the operator's housekeeping and gated acts", () => {
    for (const [method, path] of [
      ["GET", "/ws/terminal/claude-abcd1234"],
      ["GET", "/ws/control"],
      ["POST", "/api/narratives/claude-abcd1234/signal"],
      ["GET", "/api/tokens"],
      ["POST", "/api/tokens"],
      ["POST", "/api/tokens/t1/revoke"],
      ["POST", "/api/token/rotate"],
      ["POST", "/api/presence/cancel"],
      ["POST", "/api/folds"],
      ["PATCH", "/api/folds/archive"],
      ["PATCH", "/api/narratives/claude-abcd1234/archive"],
      ["POST", "/api/absorb"],
      ["GET", "/api/absorb/survey"],
      ["POST", "/api/cost/backfill"],
      ["POST", "/api/cost/reprice"],
      ["POST", "/api/run"],
      ["POST", "/api/sleep"],
    ]) {
      assert.equal(agentMayUse(method, path), false, `${method} ${path}`);
    }
  });

  it("denies a route it does not know: default-deny", () => {
    assert.equal(agentMayUse("GET", "/api/something-new"), false);
    assert.equal(agentMayUse("POST", "/api/narratives"), false, "the method is part of the route");
  });

  it("does not let a parameter match an empty or extra segment", () => {
    assert.equal(agentMayUse("GET", "/api/narratives/"), false);
    assert.equal(agentMayUse("POST", "/api/revive/"), false);
    assert.equal(agentMayUse("GET", "/api/narratives/x/events/extra"), false);
    assert.equal(agentMayUse("GET", "/api/payloads/x/"), false);
    assert.equal(agentMayUse("GET", "/api/status/"), false);
  });

  it("matches the method case-insensitively", () => {
    assert.equal(agentMayUse("get", "/api/status"), true);
  });
});

describe("agentRefusal", () => {
  const listed = { method: "GET", path: "/api/narratives" };

  it("lets an agent's token in from this machine only", () => {
    assert.equal(agentRefusal({ ...listed, loopback: true }), null);
    assert.equal(agentRefusal({ ...listed, loopback: false }), AGENT_LOOPBACK_REFUSAL);
  });

  it("refuses off this machine before looking at the route", () => {
    assert.equal(agentRefusal({ method: "GET", path: "/ws/control", loopback: false }), AGENT_LOOPBACK_REFUSAL);
  });

  it("names a utility session, not a CLI command, as the way to do a closed act", () => {
    assert.equal(agentRefusal({ method: "POST", path: "/api/absorb", loopback: true }), AGENT_SCOPE_REFUSAL);
    assert.match(AGENT_SCOPE_REFUSAL, /utility session/);
    assert.doesNotMatch(AGENT_SCOPE_REFUSAL, /brane run/);
  });

  it("tells an agent that asks for sleep that it is the operator's, and points it at /idle", () => {
    assert.equal(agentRefusal({ method: "POST", path: "/api/sleep", loopback: true }), AGENT_SLEEP_REFUSAL);
    assert.equal(agentRefusal({ method: "post", path: "/api/sleep", loopback: true }), AGENT_SLEEP_REFUSAL);
    assert.equal(agentRefusal({ method: "POST", path: "/api/sleep", loopback: false }), AGENT_LOOPBACK_REFUSAL);
    assert.match(AGENT_SLEEP_REFUSAL, /\/idle/);
  });
});

describe("agentReviveRefusal", () => {
  it("refuses a utility session, whose env carries no agent token", () => {
    assert.equal(agentReviveRefusal("utility"), AGENT_REVIVE_REFUSAL);
  });

  it("leaves reviving and prompting agents open", () => {
    for (const role of ["worker", "twin", "keeper", "absorbed", null, undefined]) {
      assert.equal(agentReviveRefusal(role), null, String(role));
    }
  });
});

describe("reviveNarrative, asked by an agent", () => {
  // Refused before anything reaches tmux, so no tmux is needed here.
  function dbWith(role: string) {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO narratives (id, brane_id, agent_type, role, status, fold_path, created_at) VALUES ('zsh-0001', 'brane-test', 'zsh', ?, 'active', '/tmp', ?)",
    ).run(role, Date.now());
    return db;
  }

  it("refuses a utility session, with or without a prompt", () => {
    assert.throws(() => reviveNarrative(dbWith("utility"), "zsh-0001", { prompt: "brane absorb", byAgent: true }), {
      message: AGENT_REVIVE_REFUSAL,
    });
    assert.throws(() => reviveNarrative(dbWith("utility"), "zsh-0001", { byAgent: true }), { message: AGENT_REVIVE_REFUSAL });
  });
});

/** A request as the daemon sees one: over `daemon.sock`, or from an address. */
function request(method: string, from: "socket" | string): IncomingMessage {
  const socket: { remoteAddress?: string } = from === "socket" ? {} : { remoteAddress: from };
  if (from === "socket") markUnixConnection(socket);
  return { method, headers: { host: "localhost" }, socket } as unknown as IncomingMessage;
}

describe("agentRequestRefusal, as the HTTP handler and the upgrade ask it", () => {
  const agent = { kind: "agent" as const };

  it("lets an agent's token in over the socket and loopback, on an open route", () => {
    assert.equal(agentRequestRefusal(agent, request("GET", "socket"), "/api/narratives"), null);
    assert.equal(agentRequestRefusal(agent, request("GET", "127.0.0.1"), "/api/narratives"), null);
    assert.equal(agentRequestRefusal(agent, request("GET", "::ffff:127.0.0.1"), "/ws/mcp"), null);
  });

  it("refuses an agent's token from a tailnet address", () => {
    assert.equal(agentRequestRefusal(agent, request("GET", "100.64.1.2"), "/api/narratives"), AGENT_LOOPBACK_REFUSAL);
  });

  it("refuses an agent's token on a closed route, even from the socket", () => {
    assert.equal(agentRequestRefusal(agent, request("GET", "socket"), "/ws/terminal/claude-abcd1234"), AGENT_SCOPE_REFUSAL);
    assert.equal(agentRequestRefusal(agent, request("POST", "socket"), "/api/narratives/x/signal"), AGENT_SCOPE_REFUSAL);
  });

  it("never refuses a device or this account", () => {
    assert.equal(agentRequestRefusal({ kind: "device" }, request("GET", "100.64.1.2"), "/ws/terminal/x"), null);
    assert.equal(agentRequestRefusal({ kind: "local" }, request("POST", "socket"), "/api/absorb"), null);
  });
});

// Every route the daemon serves, read from its `// Route:` and `// WS:`
// comments, must be decided here: open to agents (and listed in
// AGENT_ROUTES) or closed. A new route then fails this test until someone
// writes down which it is, and a renamed one shows up as a stale entry.
// Reads source, which an installed package does not ship (`brane doctor`).
const serverSource = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "daemon", "server.ts");

const CLOSED_TO_AGENTS = new Set([
  // The operator's tailnet (which machines are up, which path a device is
  // on) is for the operator's app; an agent has no use for it.
  "GET /api/tailnet",
  // Approving protocols is the operator's (docs/protocols.md#approval); an
  // agent sees what is pending on /home and /fold.
  "GET /api/protocols/pending",
  "POST /api/protocols/approve",
  "POST /api/protocols/revoke",
  "GET /api/absorb/survey",
  "POST /api/absorb",
  "PATCH /api/branes/archive",
  "POST /api/cost/backfill",
  "POST /api/cost/reprice",
  "POST /api/folds",
  "PATCH /api/folds/archive",
  "PATCH /api/narratives/:/archive",
  "POST /api/narratives/:/signal",
  "POST /api/presence/cancel",
  "POST /api/verify/end",
  "POST /api/verify/begin",
  "POST /api/credentials/begin",
  "GET /api/credentials",
  "POST /api/credentials/:/revoke",
  "POST /api/run",
  "POST /api/sleep",
  "POST /api/token/forget",
  "POST /api/token/rotate",
  "GET /api/tokens",
  "POST /api/tokens",
  "POST /api/tokens/remote",
  "POST /api/tokens/:/revoke",
  "GET /ws/control",
  "GET /ws/terminal/:",
  // Before authentication, with its own check (agent token, loopback only).
  "POST /api/hooks/tool-use",
  // Before authentication too: the ceremony page's routes, which take an
  // approval only `begin` hands out, and `begin` is closed to agents.
  "POST /api/verify/challenge",
  "POST /api/verify/webauthn",
  "POST /api/credentials/challenge",
  "POST /api/credentials",
]);

/** `METHOD /path` with every parameter (`:id`, `*`) spelled `:`. */
function normalize(route: string): string {
  const [method, path] = route.split(" ");
  return `${method} ${path.split("/").map((s) => (s.startsWith(":") || s === "*" ? ":" : s)).join("/")}`;
}

describe("every daemon route is open or closed to agents, on purpose", { skip: existsSync(serverSource) ? false : "src not shipped" }, () => {
  const served = new Set<string>();
  for (const m of readFileSync(serverSource, "utf8").matchAll(/\/\/ (Route|WS): (?:([A-Z]+) )?(\/[^\s?]+)/g)) {
    served.add(normalize(`${m[2] ?? "GET"} ${m[3]}`));
  }
  const open = new Set(AGENT_ROUTES.map(normalize));

  it("finds the route table", () => {
    assert.ok(served.size > 30, `only ${served.size} routes found`);
  });

  it("decides each one", () => {
    const undecided = [...served].filter((r) => !open.has(r) && !CLOSED_TO_AGENTS.has(r));
    assert.deepEqual(undecided, [], "add each to AGENT_ROUTES or to CLOSED_TO_AGENTS");
  });

  it("lists nothing the daemon does not serve", () => {
    assert.deepEqual([...open].filter((r) => !served.has(r)), [], "stale AGENT_ROUTES entries");
    assert.deepEqual([...CLOSED_TO_AGENTS].filter((r) => !served.has(r)), [], "stale CLOSED_TO_AGENTS entries");
  });

  it("asks on both ways in: the HTTP handler and the WebSocket upgrade", () => {
    const calls = readFileSync(serverSource, "utf8").match(/refuseAgent\(auth\.record, req, path\)/g) ?? [];
    assert.equal(calls.length, 2);
  });

  it("never lists a route as both", () => {
    assert.deepEqual([...open].filter((r) => CLOSED_TO_AGENTS.has(r)), []);
  });
});
