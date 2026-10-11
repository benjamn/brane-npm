import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

// The price table memoizes ~/.brane/pricing.json on first use, so HOME is
// sandboxed — with an override file in it — before anything prices a message.
// node --test runs each file in its own process, so this one owns the memo.
const home = mkdtempSync(join(tmpdir(), "brane-pricing-home-"));
process.env.HOME = home;
mkdirSync(join(home, ".brane"));
writeFileSync(
  join(home, ".brane", "pricing.json"),
  JSON.stringify({
    // More specific than the built-in `opus` — and than `opus-5-5`, which
    // would win if overrides were still appended after the defaults.
    "opus-5-5-fast-test": { input: 1, output: 2 },
    "kimi-latest": { input: 3, output: 15, cacheRead: 0.25 },
  }),
);

const { priceMessage } = await import("../cost/pricing.js");
type MessageUsage = import("../cost/pricing.js").MessageUsage;

const M = 1e6;
const only = (k: keyof Omit<MessageUsage, "speed">): MessageUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  [k]: M,
});
// $ for 1 MTok in each category: input, output, cache read, 5m write, 1h write.
const rates = (model: string) =>
  (["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const).map((k) =>
    Math.round(priceMessage(model, only(k)) * 1e6) / 1e6,
  );

describe("price table (checked against the published rates, 2026-09-23)", () => {
  it("prices Fable 5.1 and Mythos 5.1 cache reads at $0.25, not 0.1× input", () => {
    assert.deepEqual(rates("claude-fable-5-1"), [10, 50, 0.25, 12.5, 20]);
    assert.deepEqual(rates("claude-mythos-5-1"), [10, 50, 0.25, 12.5, 20]);
  });

  it("keeps Fable 5 and Mythos 5 at the standard 0.1× cache read", () => {
    assert.deepEqual(rates("claude-fable-5"), [10, 50, 1, 12.5, 20]);
    assert.deepEqual(rates("claude-mythos-5"), [10, 50, 1, 12.5, 20]);
  });

  it("prices Opus 5.5 at $4/$20 with $0.20 cache reads, apart from the rest of the Opus line", () => {
    assert.deepEqual(rates("claude-opus-5-5"), [4, 20, 0.2, 5, 8]);
    for (const m of ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"]) {
      assert.deepEqual(rates(m), [5, 25, 0.5, 6.25, 10], m);
    }
  });

  it("prices Sonnet 5 at $2/$10, apart from Sonnet 4.x", () => {
    assert.deepEqual(rates("claude-sonnet-5"), [2, 10, 0.2, 2.5, 4]);
    assert.deepEqual(rates("claude-sonnet-4-6"), [3, 15, 0.3, 3.75, 6]);
  });

  it("leaves Haiku 4.5 and Kimi K3 where they were", () => {
    assert.deepEqual(rates("claude-haiku-4-5-20251001"), [1, 5, 0.1, 1.25, 2]);
    assert.deepEqual(rates("accounts/fireworks/models/kimi-k3"), [3, 15, 0.3, 3.75, 6]);
    assert.deepEqual(rates("accounts/fireworks/routers/kimi-k3-fast"), [4.5, 22.5, 0.45, 5.625, 9]);
  });

  it("doubles every category in fast mode, cache multipliers on top", () => {
    const u: MessageUsage = { input: M, output: M, cacheRead: M, cacheWrite5m: M, cacheWrite1h: M };
    const standard = priceMessage("claude-opus-5-5", u);
    assert.equal(priceMessage("claude-opus-5-5", { ...u, speed: "standard" }), standard);
    assert.equal(priceMessage("claude-opus-5-5", { ...u, speed: "fast" }), 2 * standard);
    // $8 / $40 per MTok, as published for Opus 5.5 fast mode.
    assert.equal(priceMessage("claude-opus-5-5", { ...only("input"), speed: "fast" }), 8);
    assert.equal(priceMessage("claude-opus-5-5", { ...only("output"), speed: "fast" }), 40);
  });
});

describe("pricing.json overrides", () => {
  it("match before the built-in keys, however general those are", () => {
    assert.deepEqual(rates("claude-opus-5-5-fast-test").slice(0, 2), [1, 2]);
  });

  it("can price a model the defaults don't know, including its cache-read rate", () => {
    assert.deepEqual(rates("kimi-latest"), [3, 15, 0.25, 3.75, 6]);
  });
});
