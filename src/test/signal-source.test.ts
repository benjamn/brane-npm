/**
 * Who a human_signal is from (src/daemon/signal-source.ts): decided by the
 * token's kind, never by a `source` the request names, and refused to an
 * agent's token.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AGENT_SIGNAL_REFUSAL, signalEventFields, signalStanding } from "../daemon/signal-source.js";

describe("signalStanding", () => {
  it("stamps a device's signal as the app's", () => {
    assert.deepEqual(signalStanding({ kind: "device" }), { source: "web" });
  });

  it("stamps this account's signal as local", () => {
    assert.deepEqual(signalStanding({ kind: "local" }), { source: "local" });
  });

  it("refuses an agent's token, pointing it at narrate", () => {
    const standing = signalStanding({ kind: "agent" });
    assert.deepEqual(standing, { refused: AGENT_SIGNAL_REFUSAL });
    assert.match(AGENT_SIGNAL_REFUSAL, /narrate/);
  });
});

describe("signalEventFields", () => {
  it("ignores a source the request names", () => {
    const fields = signalEventFields({ source: "web" }, { content: "hi", source: "claude-abcd1234", re: [3] } as never);
    assert.deepEqual(fields, { content: "hi", source: "web", re: [3] });
  });

  it("carries stored payload paths, and nothing else from the request", () => {
    const fields = signalEventFields(
      { source: "local" },
      { content: "see attached", type: "human_signal", meta: { forged: true } } as never,
      ["claude-abcd1234/1_0.png"],
    );
    assert.deepEqual(fields, { content: "see attached", source: "local", re: undefined, payloads: ["claude-abcd1234/1_0.png"] });
  });
});
