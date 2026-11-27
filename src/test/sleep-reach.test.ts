import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  wakeConfirmed,
  WAKE_CONFIRMED_REPROBE_MS,
  WAKE_CONFIRMED_WINDOW_MS,
  parseTailnetReport,
  pathLabel,
  tailnetHost,
  tailnetTrusted,
  tailnetVerdict,
  SLEEPING_GRACE_MS,
  SWITCHER_PROBE_ATTEMPTS,
  SWITCHER_PROBE_TIMEOUT_MS,
  WAKE_CEILING_MS,
  WAKE_REPROBE_DELAYS_MS,
  PROBE_FRESH_MS,
  PROBE_MISS_BACKOFF_MAX_MS,
  PROBE_MISS_BACKOFF_MS,
  parseMachineId,
  parseWakeAnswer,
  probeAfterMiss,
  probeDue,
  wakeReachedOther,
  wakeReprobeDelayMs,
  canSleep,
  canWake,
  daemonReach,
  parseAwaitingNids,
  parseSleepStatus,
  parseWakeRecipe,
  parseRegion,
  postureLine,
  probeHeardHost,
  reachLabel,
  daemonRegion,
  reachWords,
  sleepPhraseChangesInMs,
  daemonDetailText,
  sleepLine,
  sleepOffer,
  sleepWakeSlot,
  undeadLine,
  wakeFetchInit,
  type Reach,
  type WakeRecipe,
} from "../shared/sleep.js";
import { requiresPreflight } from "../shared/api-request.js";

const URL_RECIPE: WakeRecipe = { kind: "url", url: "https://brane-fleet.fly.dev/wake/abc" };
const NONE_RECIPE: WakeRecipe = { kind: "none", reason: "no way to wake it" };

describe("the wake fetch", () => {
  it("is exactly a cors GET that follows redirects and skips the cache", () => {
    // `redirect: "follow"` is load-bearing: Chromium refuses a no-cors
    // request with `redirect: "error"` before it is sent (docs/sleep.md).
    // `cors`, so the wake door's answer (which machine took the request)
    // can be read; a GET with no headers is sent without a preflight either
    // way, so the machine starts whether or not the answer is readable.
    assert.deepEqual(wakeFetchInit(), { mode: "cors", redirect: "follow", cache: "no-store" });
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
  it("claims only what it saw: no answer, whatever kind of host it is", () => {
    assert.equal(reachLabel("awake", URL_RECIPE), null);
    assert.equal(reachLabel("asleep", URL_RECIPE), "no answer");
    assert.equal(reachLabel("unreachable", NONE_RECIPE), "no answer");
    assert.equal(reachLabel("unreachable", undefined), "no answer");
    // A Sleep the daemon accepted is not a sleep seen; a wake sent is not a
    // machine started.
    assert.equal(daemonReach({ recipe: URL_RECIPE, probe: "failed", sleptAt: 0, now: SLEEPING_GRACE_MS }), "asleep");
    assert.equal(reachLabel("asleep", URL_RECIPE), "no answer");
    assert.equal(reachLabel("waking", URL_RECIPE), "wake sent");
    assert.equal(reachLabel("still-asleep", URL_RECIPE), "no answer; tap Wake again");
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

describe("the ⋯ menu's Wake/Sleep slot", () => {
  const ALL: Reach[] = ["awake", "checking", "asleep", "unreachable", "waking", "still-asleep", "sleeping"];
  const HERE = sleepOffer(false, "brane.organelle.dev");
  const HOP = sleepOffer(true, "brane.organelle.dev");
  const NOWHERE = sleepOffer(true, null);

  it("is Sleep while a wakeable host answers, Wake while it doesn't, and disabled in between", () => {
    assert.deepEqual(sleepWakeSlot("awake", URL_RECIPE, HERE), { kind: "sleep" });
    assert.deepEqual(sleepWakeSlot("asleep", URL_RECIPE, HERE), { kind: "wake" });
    assert.deepEqual(sleepWakeSlot("still-asleep", URL_RECIPE, HERE), { kind: "wake" });
    assert.deepEqual(sleepWakeSlot("checking", URL_RECIPE, HERE), { kind: "pending", label: "Checking…" });
    assert.deepEqual(sleepWakeSlot("waking", URL_RECIPE, HERE), { kind: "pending", label: "Waking…" });
    assert.deepEqual(sleepWakeSlot("sleeping", URL_RECIPE, HERE), { kind: "pending", label: "Going to sleep…" });
  });

  it("hops when the row's host serves this page, and has no Sleep with nowhere to hop to", () => {
    assert.deepEqual(sleepWakeSlot("awake", URL_RECIPE, HOP), { kind: "sleep", hop: "brane.organelle.dev" });
    assert.equal(sleepWakeSlot("awake", URL_RECIPE, NOWHERE), null);
  });

  it("offers Wake whatever the offer: the wake fetch goes to Fly Proxy, not to this page's host", () => {
    for (const offer of [HERE, HOP, NOWHERE]) {
      assert.deepEqual(sleepWakeSlot("asleep", URL_RECIPE, offer), { kind: "wake" });
    }
  });

  it("agrees with canWake, so a wake in flight is never offered again", () => {
    for (const r of ALL) {
      assert.equal(sleepWakeSlot(r, URL_RECIPE, HERE)?.kind === "wake", canWake(r, URL_RECIPE), r);
    }
  });

  it("is absent on a host the app can't wake, in every state", () => {
    for (const r of ALL) {
      for (const offer of [HERE, HOP, NOWHERE]) {
        assert.equal(sleepWakeSlot(r, NONE_RECIPE, offer), null, r);
        assert.equal(sleepWakeSlot(r, undefined, offer), null, r);
      }
    }
  });
});

describe("the sleep line", () => {
  it("names the idle rule and the sessions", () => {
    assert.equal(sleepLine({ idle_minutes: 15, last_client_disconnect: null, sessions: 2, sleeps_in_ms: null }), "sleeps after 15 min idle · 2 sessions");
    assert.equal(sleepLine({ idle_minutes: null, last_client_disconnect: null, sessions: 1, sleeps_in_ms: null }), "never sleeps on its own · 1 session");
  });

  it("parses what the status carries, and nothing from a daemon without it", () => {
    assert.equal(parseSleepStatus(undefined), null);
    assert.deepEqual(parseSleepStatus({ idle_minutes: 15, last_client_disconnect: 5, sessions: 0 }), {
      idle_minutes: 15,
      last_client_disconnect: 5,
      sessions: 0,
      sleeps_in_ms: null,
    }, "a daemon before the countdown reports none");
    assert.equal(parseSleepStatus({ idle_minutes: 15, sessions: 0, sleeps_in_ms: 420_000 })?.sleeps_in_ms, 420_000);
    assert.equal(parseSleepStatus({ idle_minutes: 15, sessions: 0, sleeps_in_ms: -1 })?.sleeps_in_ms, null);
    assert.equal(parseSleepStatus({ idle_minutes: 15, sessions: 0, sleeps_in_ms: "7m" })?.sleeps_in_ms, null);
    assert.deepEqual(parseSleepStatus({ idle_minutes: "x" }), { idle_minutes: null, last_client_disconnect: null, sessions: 0, sleeps_in_ms: null });
  });
});

describe("the budgets", () => {
  it("probes the switcher briefly, once, and re-probes a wake gently under a ceiling", () => {
    assert.ok(SWITCHER_PROBE_TIMEOUT_MS >= 3_000 && SWITCHER_PROBE_TIMEOUT_MS <= 10_000);
    assert.equal(SWITCHER_PROBE_ATTEMPTS, 1);
    // Sparing: a handful of probes under the ceiling, lengthening, where
    // one every 5 s was eighteen.
    assert.ok(WAKE_REPROBE_DELAYS_MS.length <= 8);
    assert.ok(WAKE_REPROBE_DELAYS_MS[0] >= 2_000);
    for (let i = 1; i < WAKE_REPROBE_DELAYS_MS.length; i++) {
      assert.ok(WAKE_REPROBE_DELAYS_MS[i] > WAKE_REPROBE_DELAYS_MS[i - 1], "each wait is longer than the last");
    }
    const total = WAKE_REPROBE_DELAYS_MS.reduce((a, b) => a + b, 0);
    assert.ok(total <= WAKE_CEILING_MS, "the schedule fits under the ceiling");
    assert.equal(wakeReprobeDelayMs(0), WAKE_REPROBE_DELAYS_MS[0]);
    assert.equal(wakeReprobeDelayMs(99), WAKE_REPROBE_DELAYS_MS.at(-1), "the last wait repeats");
    assert.equal(wakeReprobeDelayMs(-1), WAKE_REPROBE_DELAYS_MS[0]);
  });
});

describe("probing is sparing, and a miss is not a verdict", () => {
  it("asks a daemon never asked, reuses a fresh answer, and backs off a silent host", () => {
    const now = 1_000_000;
    assert.equal(probeDue({}, now), true);
    assert.equal(probeDue({ probedAt: now - 1_000, misses: 0 }, now), false, "a fresh answer stands");
    assert.equal(probeDue({ probedAt: now - PROBE_FRESH_MS, misses: 0 }, now), true);
    assert.equal(probeDue({ probedAt: now - PROBE_MISS_BACKOFF_MS + 1, misses: 1 }, now), false);
    assert.equal(probeDue({ probedAt: now - PROBE_MISS_BACKOFF_MS, misses: 1 }, now), true);
    assert.equal(probeDue({ probedAt: now - PROBE_MISS_BACKOFF_MS * 2 + 1, misses: 2 }, now), false, "doubling");
    assert.equal(probeDue({ probedAt: now - PROBE_MISS_BACKOFF_MAX_MS, misses: 30 }, now), true, "capped");
  });

  it("keeps a host that was answering through its first miss, and no further", () => {
    assert.equal(probeAfterMiss("ok", 1), "ok");
    assert.equal(probeAfterMiss("ok", 2), "failed");
    assert.equal(probeAfterMiss("failed", 1), "failed");
    assert.equal(probeAfterMiss("pending", 1), "failed");
    assert.equal(probeAfterMiss(undefined, 1), "failed");
  });
});

describe("the wake door's answer", () => {
  const recipe = { kind: "url", url: "https://brane-x.fly.dev/wake", machine: "8016e1b65270d8" } as const;

  it("reads a machine id and region, and nothing else", () => {
    assert.deepEqual(parseWakeAnswer({ machine: "8016e1b65270d8", region: "nrt" }, 7), { machine: "8016e1b65270d8", region: "nrt", at: 7 });
    assert.deepEqual(parseWakeAnswer({ machine: "<script>", region: "nrt" }, 7), { machine: null, region: "nrt", at: 7 });
    assert.equal(parseWakeAnswer({ machine: 3, region: "TOKYO" }, 7), null);
    assert.equal(parseWakeAnswer(null, 7), null);
    assert.equal(parseWakeAnswer("ok", 7), null);
    assert.equal(parseMachineId("8016e1b65270d8"), "8016e1b65270d8");
    assert.equal(parseMachineId("../etc"), null);
  });

  it("keeps the machine on a recipe that names one", () => {
    assert.deepEqual(parseWakeRecipe(recipe), recipe);
    assert.deepEqual(parseWakeRecipe({ kind: "url", url: recipe.url, machine: "no good" }), { kind: "url", url: recipe.url });
  });

  it("keeps the region on a recipe, and only a region code", () => {
    assert.deepEqual(parseWakeRecipe({ ...recipe, region: "nrt" }), { ...recipe, region: "nrt" });
    assert.deepEqual(parseWakeRecipe({ ...recipe, region: "Tokyo<b>" }), recipe);
    assert.equal(parseRegion("ewr"), "ewr");
    assert.equal(parseRegion("nrt "), null);
    assert.equal(parseRegion(42), null);
  });

  it("calls it another machine only when both ids are known and differ", () => {
    const other = { machine: "872290f0244978", region: "ewr", at: 1 };
    const same = { machine: "8016e1b65270d8", region: "nrt", at: 1 };
    assert.equal(wakeReachedOther(recipe, other), true);
    assert.equal(wakeReachedOther(recipe, same), false);
    assert.equal(wakeReachedOther(recipe, { machine: null, region: "ewr", at: 1 }), false);
    assert.equal(wakeReachedOther({ kind: "url", url: recipe.url }, other), false, "a recipe from before machines were named");
    assert.equal(wakeReachedOther(recipe, null), false);
  });

  it("says the machine is up once it answers, and says so at once when another machine did", () => {
    const base = { recipe, probe: "failed" as const, wakeSentAt: 1_000, now: 2_000 };
    assert.equal(daemonReach(base), "waking");
    assert.equal(daemonReach({ ...base, wakeAnswer: { machine: "8016e1b65270d8", region: "nrt", at: 1_500 } }), "connecting");
    const other = { machine: "872290f0244978", region: "ewr", at: 1_500 };
    assert.equal(daemonReach({ ...base, wakeAnswer: other }), "woke-other");
    assert.equal(reachLabel("woke-other", recipe, other), "ewr answered; not this machine");
    assert.equal(canWake("woke-other", recipe), true, "Wake is offered again");
    assert.equal(canWake("connecting", recipe), false);
    assert.equal(daemonReach({ ...base, probe: "ok", wakeAnswer: other }), "awake", "an answer from the host itself wins");
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
    const s = { idle_minutes: 15, last_client_disconnect: null, sessions: 3, sleeps_in_ms: null };
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

describe("a connected daemon's word on the tailnet", () => {
  const report = parseTailnetReport({
    available: true,
    state: "Running",
    health: [],
    peers: [
      { host: "Daemon-NRT.tail.ts.net.", online: false, last_seen: "2026-11-26T15:42:10Z", direct: false, relay: "tok" },
      { host: "daemon-ewr.tail.ts.net", online: true, last_seen: null, direct: true, relay: "nyc" },
      { host: "", online: true },
      "junk",
    ],
    client: { host: "iphone.tail.ts.net", online: true, direct: false, relay: "nyc" },
  });

  it("parses the route's answer and drops what is not a peer", () => {
    assert.ok(report);
    assert.deepEqual(report.peers.map((p) => p.host), ["daemon-nrt.tail.ts.net", "daemon-ewr.tail.ts.net"]);
    assert.equal(report.peers[0].lastSeen, "2026-11-26T15:42:10Z");
    assert.equal(report.client?.relay, "nyc");
  });

  it("anything else is not a report, and the app probes as before", () => {
    for (const bad of [null, undefined, "x", 3, {}, { error: "not found" }, { available: "yes" }]) {
      assert.equal(parseTailnetReport(bad), null);
    }
  });

  it("offline means no dial; online means one probe; anything unsure is unknown", () => {
    assert.equal(tailnetVerdict(report, "daemon-nrt.tail.ts.net:39909"), "offline");
    assert.equal(tailnetVerdict(report, "DAEMON-EWR.tail.ts.net:45029"), "online");
    assert.equal(tailnetVerdict(report, "mac-mini.tail.ts.net:1234"), "unknown", "not a peer of the daemon asked");
    assert.equal(tailnetVerdict(null, "daemon-nrt.tail.ts.net"), "unknown", "nobody to ask");
    assert.equal(
      tailnetVerdict(parseTailnetReport({ available: false, health: [], peers: [], client: null }), "daemon-nrt.tail.ts.net"),
      "unknown",
      "the daemon's own Tailscale did not answer",
    );
  });

  it("takes the daemon's word only from a Tailscale that is running and healthy", () => {
    const peers = [{ host: "daemon-nrt.tail.ts.net", online: false, last_seen: null, direct: false, relay: null }];
    const with_ = (over: Record<string, unknown>) => parseTailnetReport({ available: true, state: "Running", health: [], peers, client: null, ...over });
    assert.equal(tailnetVerdict(with_({}), "daemon-nrt.tail.ts.net"), "offline");
    for (const state of ["Stopped", "NeedsLogin", "Starting", undefined]) {
      // A stopped Tailscale still prints its last peer list.
      assert.equal(tailnetVerdict(with_({ state }), "daemon-nrt.tail.ts.net"), "unknown", `state ${state}`);
    }
    // Cut off from the coordination server, a peer's Online is only as fresh
    // as the last contact.
    assert.equal(tailnetVerdict(with_({ health: ["Unable to connect to the Tailscale coordination server"] }), "daemon-nrt.tail.ts.net"), "unknown");
    assert.equal(tailnetTrusted(with_({})), true);
    assert.equal(tailnetTrusted(with_({ state: "Stopped" })), false);
    assert.equal(tailnetTrusted(null), false);
  });

  it("compares hosts without case, port or trailing dot", () => {
    assert.equal(tailnetHost(" Foo.Tail.ts.net.:443".trim()), "foo.tail.ts.net.".slice(0, -1));
    assert.equal(tailnetHost("foo.tail.ts.net:39909"), "foo.tail.ts.net");
  });

  it("the row states what is known rather than guessing, and the same for every kind of host", () => {
    const cloud = { kind: "url", url: "https://x.example/wake" } as const;
    const mac = { kind: "none", reason: "no way to wake it" } as const;
    // A 0.3.15 or 0.3.16 daemon's recipe, as a device's registry keeps it.
    const old = { kind: "none", reason: "not a Fly machine" } as const;
    for (const [reach, recipe] of [["asleep", cloud], ["unreachable", mac], ["unreachable", old], ["unreachable", undefined]] as const) {
      assert.equal(reachLabel(reach, recipe), "no answer");
      assert.equal(reachLabel(reach, recipe, null, "unknown"), "no answer");
      assert.equal(reachLabel(reach, recipe, null, "offline"), "off the tailnet");
      assert.equal(reachLabel(reach, recipe, null, "online"), "no answer; on the tailnet");
    }
    assert.equal(reachLabel("awake", cloud, null, "offline"), null);
  });

  it("names the path between the device and its daemon", () => {
    assert.equal(pathLabel(null), null);
    assert.equal(pathLabel({ host: "p", online: true, lastSeen: null, direct: true, relay: "nyc" }), "direct");
    assert.equal(pathLabel({ host: "p", online: true, lastSeen: null, direct: false, relay: "nyc" }), "relayed via nyc");
    assert.equal(pathLabel({ host: "p", online: true, lastSeen: null, direct: false, relay: null }), "relayed");
  });

  it("the store asks before it dials, and never dials a peer the tailnet has offline", (t) => {
    let src: string;
    try { src = readFileSync(new URL("../../expo/lib/reach.ts", import.meta.url), "utf8"); } catch { t.skip("source not present"); return; }
    const body = src.slice(src.indexOf("export async function probeAllReach"), src.indexOf("function tailnetHostOf"));
    const offline = body.indexOf('verdict === "offline"');
    assert.ok(offline > 0 && body.indexOf("askTailnet(targets)") < offline);
    const branch = body.slice(offline, body.indexOf("continue;", offline));
    assert.ok(!branch.includes("probeReach("), "the offline branch makes no probe");
  });
});

describe("a wake the door confirmed is polled closely", () => {
  const recipe = { kind: "url", url: "https://x.fly.dev/wake", machine: "3d8d97710f9e48" } as const;

  it("confirmed means the same machine answered, both ids known", () => {
    assert.equal(wakeConfirmed(recipe, { machine: "3d8d97710f9e48", region: "nrt", at: 0 }), true);
    assert.equal(wakeConfirmed(recipe, { machine: "872290f0244978", region: "ewr", at: 0 }), false);
    assert.equal(wakeConfirmed(recipe, { machine: null, region: "nrt", at: 0 }), false);
    assert.equal(wakeConfirmed({ kind: "url", url: "https://x.fly.dev/wake" }, { machine: "3d8d97710f9e48", region: "nrt", at: 0 }), false);
    assert.equal(wakeConfirmed(recipe, null), false);
  });

  it("every 2 s for half a minute after the door answers, then the sparing schedule", () => {
    assert.equal(wakeReprobeDelayMs(0, 0), WAKE_CONFIRMED_REPROBE_MS);
    assert.equal(wakeReprobeDelayMs(7, WAKE_CONFIRMED_WINDOW_MS - 1), WAKE_CONFIRMED_REPROBE_MS);
    assert.equal(wakeReprobeDelayMs(3, WAKE_CONFIRMED_WINDOW_MS), WAKE_REPROBE_DELAYS_MS[3]);
    assert.equal(wakeReprobeDelayMs(0, null), WAKE_REPROBE_DELAYS_MS[0], "unconfirmed: nothing says the peer is coming");
    assert.equal(wakeReprobeDelayMs(0), WAKE_REPROBE_DELAYS_MS[0]);
    assert.ok(WAKE_CONFIRMED_WINDOW_MS / WAKE_CONFIRMED_REPROBE_MS <= 20, "a bounded burst");
  });
});

describe("daemon rows: three lines, the same on every machine row", () => {
  const fly = { kind: "url", url: "https://brane-nrt-x.fly.dev/wake", machine: "3d8d97710f9e48", region: "nrt" } as const;
  const sleep = { idle_minutes: 15, last_client_disconnect: null, sessions: 1, sleeps_in_ms: null };

  it("places a Fly machine by its region, and nothing else", () => {
    assert.equal(daemonRegion(fly), "nrt");
    assert.equal(daemonRegion({ kind: "url", url: fly.url }), null);
    assert.equal(daemonRegion({ kind: "none", reason: "no way to wake it" }), null);
    assert.equal(daemonRegion(undefined), null);
  });

  it("keeps every state's word short enough for one line, the reason going below", () => {
    const fly = { kind: "url", url: "https://x.fly.dev/wake", machine: "a1b2c3d4e5f6a7" } as const;
    const states: Reach[] = ["awake", "checking", "sleeping", "asleep", "unreachable", "waking", "connecting", "woke-other", "still-asleep"];
    for (const r of states) {
      for (const t of [undefined, "online", "offline"] as const) {
        for (const region of ["ewr", null]) {
          const w = reachWords(r, fly, { machine: "b", region, at: 0 }, t);
          // 30 monospace characters is the line at phone width, beside the
          // dot, the ⋯ and (on the current row) the cost; the word gets 16.
          assert.ok(w.word.length <= 16, `${r}/${t}: "${w.word}"`);
        }
      }
    }
    assert.deepEqual(reachWords("woke-other", fly, { machine: "b", region: "ewr", at: 0 }), { word: "ewr answered", why: "not this machine" });
    assert.deepEqual(reachWords("woke-other", fly, { machine: "b", region: null, at: 0 }), { word: "another answered", why: "not this machine" });
    assert.deepEqual(reachWords("connecting", fly), { word: "machine is up", why: "connecting…" });
  });

  it("names no hosting provider in anything a row says", () => {
    // Where a host runs is a detail of how it is woken. The words are the
    // operator's, and another provider's machine should read the same.
    const fly = { kind: "url", url: "https://x.fly.dev/wake", machine: "a1b2c3d4e5f6a7", region: "nrt" } as const;
    const recipes = [fly, { kind: "none", reason: "no way to wake it" }, { kind: "none", reason: "not a Fly machine" }, undefined] as const;
    const states: Reach[] = ["awake", "checking", "sleeping", "asleep", "unreachable", "waking", "connecting", "woke-other", "still-asleep"];
    for (const recipe of recipes) {
      for (const r of states) {
        for (const t of [undefined, "online", "offline"] as const) {
          for (const answer of [null, { machine: "b", region: "ewr", at: 0 }, { machine: "b", region: null, at: 0 }]) {
            const w = reachWords(r, recipe, answer, t);
            const said = [w.word, w.why ?? "", reachLabel(r, recipe, answer, t) ?? ""].join(" | ");
            assert.doesNotMatch(said, /\bfly\b/i, `${r}/${t}/${recipe?.kind}: ${said}`);
          }
        }
      }
    }
  });

  it("details an awake machine by its sessions, rule and path (no undead count: the glow shows them); a silent one by why, or when it was last heard", () => {
    const now = 10_000_000;
    assert.equal(daemonDetailText(true, sleep, "direct", now - 5, now), "1 session · sleeps after 15m idle · direct");
    assert.equal(daemonDetailText(true, { ...sleep, idle_minutes: null, sessions: 3 }, null, null, now), "3 sessions", "no rule is not a promise to stay up");
  });

  it("counts the idle countdown down from the daemon's answer, rounding up, and only while it runs", () => {
    const now = 10_000_000;
    const counting = { idle_minutes: 15, last_client_disconnect: 1, sessions: 0, sleeps_in_ms: 7 * 60_000 };
    assert.equal(daemonDetailText(true, counting, null, null, now, null, now), "0 sessions · sleeps in 7m");
    assert.equal(daemonDetailText(true, counting, null, null, now, null, now - 30_000), "0 sessions · sleeps in 7m", "6m30s left reads 7m: never less than there is");
    assert.equal(daemonDetailText(true, counting, null, null, now, null, now - 60_000), "0 sessions · sleeps in 6m");
    assert.equal(daemonDetailText(true, counting, null, null, now, null, now - 6 * 60_000 - 15_000), "0 sessions · sleeps in 45s", "the last minute counts in seconds");
    assert.equal(daemonDetailText(true, counting, null, null, now, null, now - 7 * 60_000 - 30_000), "0 sessions · sleep due", "just past its end: the daemon's next check is under a minute away");
    assert.equal(daemonDetailText(true, counting, null, null, now, null, now + 60_000), "0 sessions · sleeps in 7m", "a clock set back adds no time the daemon didn't report");
    assert.equal(daemonDetailText(true, { ...counting, sleeps_in_ms: 3 * 3_600_000 - 1 }, null, null, now, null, now), "0 sessions · sleeps in 3h");
    assert.equal(daemonDetailText(true, { ...counting, idle_minutes: 120, sleeps_in_ms: null }, null, null, now, null, now), "0 sessions · sleeps after 2h idle", "the rule is exact, in its largest whole unit");
    assert.equal(daemonDetailText(true, counting, null, null, now, null, now - 20 * 60_000), "0 sessions · sleeps after 15m idle", "long past its end the status says nothing about now: no time is claimed");
    assert.equal(daemonDetailText(true, counting, null, null, now, null, null), "0 sessions · sleeps after 15m idle", "without the answer's time there is nothing to count from");
    assert.equal(daemonDetailText(true, { ...counting, sleeps_in_ms: null, sessions: 2 }, null, null, now, null, now), "2 sessions · sleeps after 15m idle", "held: the rule, not a countdown");
    assert.equal(daemonDetailText(true, null, null, null, now), null);
    assert.equal(daemonDetailText(false, sleep, "direct", now - 50 * 60_000, now), "last seen 50m ago");
    assert.equal(daemonDetailText(false, null, null, undefined, now), null);
    assert.equal(daemonDetailText(false, null, null, now - 5, now, "tap Wake again"), "tap Wake again");
  });

  it("redraws exactly when the countdown's words would change, and not without one", () => {
    const at = 10_000_000;
    const counting = { idle_minutes: 15, last_client_disconnect: 1, sessions: 0, sleeps_in_ms: 7 * 60_000 + 30_000 };
    assert.equal(sleepPhraseChangesInMs(counting, at, at), 30_000, "8m until 7m");
    assert.equal(sleepPhraseChangesInMs(counting, at, at + 7 * 60_000), 1_000, "60s → 59s… once a second");
    assert.equal(sleepPhraseChangesInMs(counting, at, at + 7 * 60_000 + 30_000), 60_000, "at the end, \"sleep due\" for one check");
    assert.equal(sleepPhraseChangesInMs(counting, at, at + 9 * 60_000), null, "past that, nothing left to count");
    assert.equal(sleepPhraseChangesInMs({ ...counting, sleeps_in_ms: null }, at, at), null, "held");
    assert.equal(sleepPhraseChangesInMs(counting, null, at), null, "no answer time");
    // Walking the countdown by its own schedule visits every value once.
    const seen: string[] = [];
    for (let t = at, i = 0; i < 200; i++) {
      seen.push(daemonDetailText(true, counting, null, null, t, null, at) ?? "");
      const wait = sleepPhraseChangesInMs(counting, at, t);
      if (wait === null) break;
      t += wait;
    }
    assert.deepEqual(seen.slice(0, 3), ["0 sessions · sleeps in 8m", "0 sessions · sleeps in 7m", "0 sessions · sleeps in 6m"]);
    assert.ok(seen.includes("0 sessions · sleeps in 60s") && seen.includes("0 sessions · sleeps in 1s"));
    assert.deepEqual(seen.slice(-2), ["0 sessions · sleep due", "0 sessions · sleeps after 15m idle"]);
    assert.equal(new Set(seen).size, seen.length, "each redraw shows new words");
  });

  it("the switcher builds every machine row with the same component", (t) => {
    let src: string;
    try { src = readFileSync(new URL("../../expo/app/index.tsx", import.meta.url), "utf8"); } catch { t.skip("source not present"); return; }
    assert.match(src, /title=\{activeDaemon\.id\}\s*place=\{daemonRegion\(activeDaemon\.wake\)\}/);
    assert.match(src, /title=\{d\.id\}\s*place=\{daemonRegion\(d\.wake\)\}/);
    assert.doesNotMatch(src, />All branes</);
  });
});
