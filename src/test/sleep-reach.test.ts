import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SLEEPING_GRACE_MS,
  SWITCHER_PROBE_ATTEMPTS,
  SWITCHER_PROBE_TIMEOUT_MS,
  WAKE_CEILING_MS,
  WAKE_REPROBE_INTERVAL_MS,
  canSleep,
  canWake,
  daemonReach,
  parseAwaitingNids,
  parseSleepStatus,
  parseWakeRecipe,
  postureLine,
  probeHeardHost,
  reachLabel,
  sleepLine,
  undeadLine,
  wakeFetchInit,
  type WakeRecipe,
} from "../shared/sleep.js";
import { requiresPreflight } from "../shared/api-request.js";

const URL_RECIPE: WakeRecipe = { kind: "url", url: "https://brane-fleet.fly.dev/wake/abc" };
const NONE_RECIPE: WakeRecipe = { kind: "none", reason: "not a Fly machine" };

describe("the wake fetch", () => {
  it("is exactly an opaque no-cors GET that follows redirects and skips the cache", () => {
    // `redirect: "follow"` is load-bearing: Chromium refuses a no-cors
    // request with `redirect: "error"` before it is sent (docs/sleep.md).
    assert.deepEqual(wakeFetchInit(), { mode: "no-cors", redirect: "follow", cache: "no-store" });
  });

  it("carries no headers, no body and no method, so nothing preflights", () => {
    const init = wakeFetchInit() as Record<string, unknown>;
    assert.equal(init.headers, undefined);
    assert.equal(init.body, undefined);
    assert.equal(init.method, undefined);
    assert.equal(requiresPreflight("GET"), false);
  });

  it("is a fresh object each call", () => {
    assert.notEqual(wakeFetchInit(), wakeFetchInit());
  });
});

describe("parseWakeRecipe", () => {
  it("reads a URL recipe, http(s) only", () => {
    assert.deepEqual(parseWakeRecipe(URL_RECIPE), URL_RECIPE);
    assert.deepEqual(parseWakeRecipe({ kind: "url", url: "http://x.test/wake" }), { kind: "url", url: "http://x.test/wake" });
    assert.equal(parseWakeRecipe({ kind: "url", url: "javascript:alert(1)" }), null);
    assert.equal(parseWakeRecipe({ kind: "url", url: "not a url" }), null);
    assert.equal(parseWakeRecipe({ kind: "url" }), null);
  });

  it("reads none with its reason, and gives one when it is missing", () => {
    assert.deepEqual(parseWakeRecipe(NONE_RECIPE), NONE_RECIPE);
    assert.equal(parseWakeRecipe({ kind: "none" })?.kind, "none");
  });

  it("is null for a daemon from before the field, or anything else", () => {
    assert.equal(parseWakeRecipe(undefined), null);
    assert.equal(parseWakeRecipe(null), null);
    assert.equal(parseWakeRecipe("url"), null);
    assert.equal(parseWakeRecipe({ kind: "wol" }), null);
  });
});

describe("daemonReach", () => {
  const now = 1_000_000_000;

  it("an answer is awake, whatever the recipe", () => {
    for (const recipe of [URL_RECIPE, NONE_RECIPE, undefined]) {
      assert.equal(daemonReach({ recipe, probe: "ok", now }), "awake");
    }
  });

  it("no answer with a URL recipe is asleep; with none, or no recipe yet, unreachable", () => {
    assert.equal(daemonReach({ recipe: URL_RECIPE, probe: "failed", now }), "asleep");
    assert.equal(daemonReach({ recipe: NONE_RECIPE, probe: "failed", now }), "unreachable");
    assert.equal(daemonReach({ recipe: undefined, probe: "failed", now }), "unreachable");
  });

  it("no answer yet is checking", () => {
    assert.equal(daemonReach({ recipe: URL_RECIPE, probe: undefined, now }), "checking");
    assert.equal(daemonReach({ recipe: URL_RECIPE, probe: "pending", now }), "checking");
  });

  it("after a Wake tap: waking until the ceiling, then still asleep", () => {
    const base = { recipe: URL_RECIPE, probe: "failed" as const };
    assert.equal(daemonReach({ ...base, wakeSentAt: now, now }), "waking");
    assert.equal(daemonReach({ ...base, wakeSentAt: now, now: now + WAKE_CEILING_MS - 1 }), "waking");
    assert.equal(daemonReach({ ...base, wakeSentAt: now, now: now + WAKE_CEILING_MS }), "still-asleep");
    // An answer ends it.
    assert.equal(daemonReach({ ...base, probe: "ok", wakeSentAt: now, now: now + 1 }), "awake");
  });

  it("after a Sleep: going to sleep through the grace, an answer included, then asleep", () => {
    assert.equal(daemonReach({ recipe: URL_RECIPE, probe: "ok", sleptAt: now, now: now + 1 }), "sleeping");
    assert.equal(daemonReach({ recipe: URL_RECIPE, probe: "failed", sleptAt: now, now: now + SLEEPING_GRACE_MS }), "asleep");
    // Asleep without waiting for a probe to time out.
    assert.equal(daemonReach({ recipe: URL_RECIPE, probe: "pending", sleptAt: now, now: now + SLEEPING_GRACE_MS }), "asleep");
  });
});

describe("what the row says and offers", () => {
  it("says asleep and unreachable in those words, with the reason", () => {
    assert.equal(reachLabel("awake", URL_RECIPE), null);
    assert.equal(reachLabel("asleep", URL_RECIPE), "probably asleep");
    assert.equal(reachLabel("unreachable", NONE_RECIPE), "unreachable: not a Fly machine");
    assert.equal(reachLabel("unreachable", undefined), "unreachable");
    assert.equal(reachLabel("waking", URL_RECIPE), "waking…");
    assert.equal(reachLabel("still-asleep", URL_RECIPE), "still asleep; tap Wake again");
  });

  it("offers Wake only with a URL, and not while one is being waited on", () => {
    assert.equal(canWake("asleep", URL_RECIPE), true);
    assert.equal(canWake("still-asleep", URL_RECIPE), true);
    assert.equal(canWake("waking", URL_RECIPE), false);
    assert.equal(canWake("sleeping", URL_RECIPE), false);
    assert.equal(canWake("awake", URL_RECIPE), false);
    assert.equal(canWake("unreachable", NONE_RECIPE), false);
    assert.equal(canWake("asleep", undefined), false);
  });

  it("offers Sleep only on a host the app can wake again", () => {
    assert.equal(canSleep(URL_RECIPE), true);
    assert.equal(canSleep(NONE_RECIPE), false);
    assert.equal(canSleep(undefined), false);
  });
});

describe("the sleep line", () => {
  it("names the idle rule and the sessions", () => {
    assert.equal(sleepLine({ idle_minutes: 15, last_client_disconnect: null, sessions: 2 }), "sleeps after 15 min idle · 2 sessions");
    assert.equal(sleepLine({ idle_minutes: null, last_client_disconnect: null, sessions: 1 }), "never sleeps on its own · 1 session");
  });

  it("parses what the status carries, and nothing from a daemon without it", () => {
    assert.equal(parseSleepStatus(undefined), null);
    assert.deepEqual(parseSleepStatus({ idle_minutes: 15, last_client_disconnect: 5, sessions: 0 }), {
      idle_minutes: 15,
      last_client_disconnect: 5,
      sessions: 0,
    });
    assert.deepEqual(parseSleepStatus({ idle_minutes: "x" }), { idle_minutes: null, last_client_disconnect: null, sessions: 0 });
  });
});

describe("the budgets", () => {
  it("probes the switcher briefly, once, and re-probes a wake gently under a ceiling", () => {
    assert.ok(SWITCHER_PROBE_TIMEOUT_MS >= 3_000 && SWITCHER_PROBE_TIMEOUT_MS <= 10_000);
    assert.equal(SWITCHER_PROBE_ATTEMPTS, 1);
    assert.ok(WAKE_REPROBE_INTERVAL_MS >= 2_000);
    assert.ok(WAKE_CEILING_MS > WAKE_REPROBE_INTERVAL_MS * 4);
  });
});

// The wake URL is touched by the Wake tap and nothing else: every request
// that reaches Fly Proxy starts a machine. So the app has one `fetch` with
// the wake options, and it lives in `wakeDaemon`. Reads source, so it skips
// on an installed package.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const reachPath = join(repoRoot, "expo", "lib", "reach.ts");

describe("the app sends a wake only from the Wake tap", () => {
  it("has exactly one wake fetch, inside wakeDaemon, outside any loop or timer", (t) => {
    if (!existsSync(reachPath)) return t.skip("source is not present (an installed package)");
    const src = readFileSync(reachPath, "utf8");
    const calls = [...src.matchAll(/wakeFetchInit\(\)/g)];
    assert.equal(calls.length, 1, "one wake fetch");
    const at = calls[0].index!;
    const fnStart = src.lastIndexOf("export function wakeDaemon", at);
    const nextFn = src.indexOf("\nfunction ", fnStart);
    assert.ok(fnStart >= 0 && at < nextFn, "the wake fetch is in wakeDaemon");
    const body = src.slice(fnStart, at);
    assert.ok(!/setTimeout|setInterval|for \(|while \(/.test(body), "no timer or loop sends it");
    const reprobe = src.slice(src.indexOf("function scheduleReprobe"));
    assert.ok(!/wakeDaemon\(|fetch\(/.test(reprobe.slice(0, reprobe.indexOf("\n}\n"))), "the re-probe loop never wakes");
  });
});

describe("the undead count", () => {
  it("reads the status's list, and none from a daemon without it or with junk", () => {
    assert.deepEqual(parseAwaitingNids(["claude-a", "claude-b"]), ["claude-a", "claude-b"]);
    assert.deepEqual(parseAwaitingNids(["claude-a", 3, null, ""]), ["claude-a"]);
    assert.deepEqual(parseAwaitingNids(undefined), []);
    assert.deepEqual(parseAwaitingNids("claude-a"), []);
  });

  it("joins the sleep line, and stands alone without a posture", () => {
    const s = { idle_minutes: 15, last_client_disconnect: null, sessions: 3 };
    assert.equal(sleepLine(s, 2), "sleeps after 15 min idle · 3 sessions, 2 undead");
    assert.equal(sleepLine(s), "sleeps after 15 min idle · 3 sessions");
    assert.equal(sleepLine(s, 0), sleepLine(s));
    assert.equal(undeadLine(1), "1 undead");
    assert.equal(postureLine(s, 2), sleepLine(s, 2));
    assert.equal(postureLine(null, 2), "2 undead");
    assert.equal(postureLine(null, 0), null);
  });
});

describe("probeHeardHost: any answer means the host is up", () => {
  it("reads an HTTP status on the probe's error as an answer, and only its absence as possibly asleep", () => {
    assert.equal(probeHeardHost(Object.assign(new Error("Status 401"), { status: 401 })), true);
    assert.equal(probeHeardHost(Object.assign(new Error("Status 503"), { status: 503 })), true);
    assert.equal(probeHeardHost(new Error("timed out")), false);
    assert.equal(probeHeardHost(new TypeError("Failed to fetch")), false);
    assert.equal(probeHeardHost(undefined), false);
  });
});
