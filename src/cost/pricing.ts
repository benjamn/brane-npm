import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Token-based USD pricing for agents whose session logs expose token usage
// (currently Claude). Prices are $ per million tokens, keyed by a substring of
// the model id so new point-releases (`claude-opus-4-8`, `…-4-9`, …) match the
// same tier without edits. Cache multipliers follow Anthropic's schedule:
// a 5-minute cache *write* is 1.25× the input price and a 1-hour write is 2×.
// A cache *read* is 0.1× input unless the entry names its own `cacheRead`
// rate — Fable 5.1 (0.025×) and Opus 5.5 (0.05×) do. Reverse-engineered
// against /usage + ccusage and validated to the cent by the twin cost
// experiment; rates last checked against
// https://platform.claude.com/docs/en/about-claude/pricing on 2026-09-23.
export interface ModelPrice {
  /** $ per million input tokens. */
  input: number;
  /** $ per million output tokens. */
  output: number;
  /** $ per million cache-read tokens, when it isn't the standard 0.1× input. */
  cacheRead?: number;
}

export interface MessageUsage {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute ephemeral cache-creation tokens. */
  cacheWrite5m: number;
  /** 1-hour ephemeral cache-creation tokens. */
  cacheWrite1h: number;
  /** `usage.speed` as the harness recorded it; `"fast"` is fast mode. */
  speed?: string;
}

// Fast mode (Opus 5.5, Opus 5, Opus 4.8) bills every token category at 2× the
// model's standard rate, with the cache multipliers applied on top — $8/$40 on
// Opus 5.5, $10/$50 on Opus 5 and 4.8. One multiplier rather than a second
// table, because that is how the rates are defined.
const FAST_MULTIPLIER = 2;

// Insertion order is load-bearing: priceForModel returns the FIRST substring
// hit, so any key that is a substring of another must come after it. Hence
// `fable-5-1` above `fable`, `opus-5-5` above `opus`, `sonnet-5` above
// `sonnet`, and `kimi-k3-fast` above `kimi-k3` — each wrong order silently
// prices the specific model at its family's rate.
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  // Fable 5.1 / Mythos 5.1 read cache at 0.025× input; Fable 5 / Mythos 5 at
  // the standard 0.1×. Same model tier, same input and output price.
  "fable-5-1": { input: 10.0, output: 50.0, cacheRead: 0.25 },
  "mythos-5-1": { input: 10.0, output: 50.0, cacheRead: 0.25 },
  fable: { input: 10.0, output: 50.0 },
  mythos: { input: 10.0, output: 50.0 },
  // Opus 5.5 is cheaper than the rest of the Opus line, and reads cache at
  // 0.05× input.
  "opus-5-5": { input: 4.0, output: 20.0, cacheRead: 0.2 },
  opus: { input: 5.0, output: 25.0 },
  // Sonnet 5's launch price, announced as introductory, became its standard
  // price; the increase to $3/$15 scheduled for 2026-09-01 did not happen.
  "sonnet-5": { input: 2.0, output: 10.0 },
  sonnet: { input: 3.0, output: 15.0 },
  haiku: { input: 1.0, output: 5.0 },
  // Fireworks-hosted Kimi K3 (open-weight), used by the goose/cline/crush
  // harnesses. Fireworks' published serverless rates; cached input is exactly
  // 0.1× input, matching the default cache-read multiplier, and cache *writes*
  // are free — so callers pass zero write tokens.
  "kimi-k3-fast": { input: 4.5, output: 22.5 },
  "kimi-k3": { input: 3.0, output: 15.0 },
};

// The table as it stood from #385 until this revision, frozen. Ledger rows
// written under it kept one `cache_write` count rather than the 5-minute /
// 1-hour split, and this is what lets `brane cost reprice` recover that split
// from the amount it produced (see src/cost/reprice.ts). Never edit it: it
// describes rows that already exist.
export const LEGACY_PRICES_V1: ReadonlyArray<readonly [string, ModelPrice]> = [
  ["fable", { input: 10.0, output: 50.0 }],
  ["mythos", { input: 10.0, output: 50.0 }],
  ["opus", { input: 5.0, output: 25.0 }],
  ["sonnet", { input: 3.0, output: 15.0 }],
  ["haiku", { input: 1.0, output: 5.0 }],
  ["kimi-k3-fast", { input: 4.5, output: 22.5 }],
  ["kimi-k3", { input: 3.0, output: 15.0 }],
];

// Fallback when a model matches no known tier — assume the most expensive
// known tier (fable/mythos) so cost is never silently under-reported.
const DEFAULT_TIER: ModelPrice = { input: 10.0, output: 50.0 };

let _table: Array<[string, ModelPrice]> | null = null;

/** Price table = an optional operator-supplied `~/.brane/pricing.json` (same
 *  `{ substring: {input, output, cacheRead?} }` shape) ahead of the built-in
 *  defaults, so prices can be corrected without a rebuild. Override keys are
 *  matched first: appended after the defaults, as they once were, an entry
 *  for `opus-5-5` could never win against `opus`. Read once and memoized. */
function priceTable(): Array<[string, ModelPrice]> {
  if (_table) return _table;
  const overrides: Array<[string, ModelPrice]> = [];
  try {
    const raw = readFileSync(join(homedir(), ".brane", "pricing.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, Partial<ModelPrice>>;
    for (const [key, val] of Object.entries(parsed)) {
      if (val && typeof val.input === "number" && typeof val.output === "number") {
        const price: ModelPrice = { input: val.input, output: val.output };
        if (typeof val.cacheRead === "number") price.cacheRead = val.cacheRead;
        overrides.push([key.toLowerCase(), price]);
      }
    }
  } catch {
    // No override file (the common case) — defaults stand.
  }
  _table = [...overrides, ...Object.entries(DEFAULT_PRICES)];
  return _table;
}

function lookup(table: Iterable<readonly [string, ModelPrice]>, model: string): ModelPrice {
  const m = model.toLowerCase();
  for (const [substr, price] of table) {
    if (m.includes(substr)) return price;
  }
  return DEFAULT_TIER;
}

function price(p: ModelPrice, u: MessageUsage): number {
  // `tokens * 0.1 * input`, in that order, rather than `tokens * (0.1 * input)`:
  // the default multiplier keeps the float associativity amounts were always
  // computed with, so an unchanged model reprices to the identical double.
  const cacheRead = p.cacheRead !== undefined ? u.cacheRead * p.cacheRead : u.cacheRead * 0.1 * p.input;
  const base =
    (u.input * p.input +
      u.output * p.output +
      cacheRead +
      u.cacheWrite5m * 1.25 * p.input +
      u.cacheWrite1h * 2 * p.input) /
    1e6;
  return u.speed === "fast" ? base * FAST_MULTIPLIER : base;
}

/** USD cost of a single message's token usage, priced by its own model. */
export function priceMessage(model: string, u: MessageUsage): number {
  return price(lookup(priceTable(), model), u);
}

/** What `priceMessage` returned for this usage before this revision's table,
 *  with no pricing.json override and no fast mode. Only reprice uses it. */
export function priceMessageV1(model: string, u: MessageUsage): number {
  return price(lookup(LEGACY_PRICES_V1, model), { ...u, speed: undefined });
}

/** The input price the legacy table charged `model`, for split recovery. */
export function legacyInputPriceV1(model: string): number {
  return lookup(LEGACY_PRICES_V1, model).input;
}
