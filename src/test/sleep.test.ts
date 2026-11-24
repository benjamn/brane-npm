/**
 * Sleep (src/daemon/sleep.ts, docs/sleep.md): the idle rule as pure logic,
 * the manifest and the exit record on disk, the wake recipe `GET
 * /api/status` reports, the routine's two entries, and boot revive. Every
 * shell-out is a fake here: nothing spawns tmux or tailscale, and nothing
 * opens a database.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXIT_RECORD,
  EXIT_RECORD_LAST,
  SESSIONS_CACHE_MS,
  SLEEP_MANIFEST,
  SLEEP_MANIFEST_LAST,
  Sleeper,
  bootRevive,
  bootReviveEnabled,
  idleSleepDue,
  listTmuxSessions,
  parseFlag,
  parseIdleMinutes,
  readExitRecord,
  readSleepManifest,
  retireSleepManifest,
  sleepingNarratives,
  tailscaleDownWanted,
  endsSessions,
  takeExitRecord,
  wakePrompt,
  wakeRecipe,
  writeExitRecord,
  writeSleepManifest,
  writesManifest,
  type LiveNarrative,
  type SleepReason,
} from "../daemon/sleep.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 8, 12);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brane-sleep-"));
});
afterEach(() => {
  // A temp directory this test made, under the OS's temp dir.
  rmSync(dir, { recursive: true, force: true });
});

describe("parseIdleMinutes: config, then the environment, else never", () => {
  it("reads minutes from config, falling back to the env", () => {
    assert.equal(parseIdleMinutes("30", undefined), 30);
    assert.equal(parseIdleMinutes(undefined, "15"), 15);
    assert.equal(parseIdleMinutes("", "15"), 15);
    assert.equal(parseIdleMinutes(" 45 ", "15"), 45);
  });

  it("lets a config of 0 switch off what the env switched on", () => {
    assert.equal(parseIdleMinutes("0", "15"), null);
  });

  it("treats unset, zero, negative and junk as never", () => {
    for (const [c, e] of [
      [undefined, undefined],
      ["0", undefined],
      [undefined, "0"],
      ["-5", undefined],
      ["soon", undefined],
      [undefined, "NaN"],
      ["Infinity", undefined],
    ] as const) {
      assert.equal(parseIdleMinutes(c, e), null, `${c} / ${e}`);
    }
  });

  it("reads flags", () => {
    assert.equal(parseFlag("true"), true);
    assert.equal(parseFlag("ON"), true);
    assert.equal(parseFlag("0"), false);
    assert.equal(parseFlag(undefined), null);
    assert.equal(parseFlag("maybe"), null);
  });
});

describe("idleSleepDue: no sessions, and N minutes since the last client left", () => {
  const base = { idleMinutes: 10, clients: 0, sessions: 0, lastClientDisconnect: T0, now: T0 + 10 * MIN };

  it("fires once N minutes have passed with no sessions and no clients", () => {
    assert.equal(idleSleepDue(base), true);
    assert.equal(idleSleepDue({ ...base, now: T0 + 60 * MIN }), true);
  });

  it("waits out the N minutes", () => {
    assert.equal(idleSleepDue({ ...base, now: T0 + 10 * MIN - 1 }), false);
  });

  it("never fires with N unset", () => {
    assert.equal(idleSleepDue({ ...base, idleMinutes: null, now: T0 + 1e9 }), false);
    assert.equal(idleSleepDue({ ...base, idleMinutes: 0, now: T0 + 1e9 }), false);
  });

  it("never fires while a client is connected", () => {
    assert.equal(idleSleepDue({ ...base, clients: 1, now: T0 + 1e9 }), false);
  });

  it("never fires while any session exists", () => {
    assert.equal(idleSleepDue({ ...base, sessions: 1, now: T0 + 1e9 }), false);
  });

  it("never fires when tmux could not be asked", () => {
    assert.equal(idleSleepDue({ ...base, sessions: null, now: T0 + 1e9 }), false);
  });

  it("never fires without a recorded disconnect", () => {
    assert.equal(idleSleepDue({ ...base, lastClientDisconnect: null, now: T0 + 1e9 }), false);
  });
});

describe("wakeRecipe: what GET /api/status reports as `wake`", () => {
  it("is the app's /wake URL on a Fly machine", () => {
    assert.deepEqual(wakeRecipe({ FLY_APP_NAME: "brane-ben" }), { kind: "url", url: "https://brane-ben.fly.dev/wake" });
  });

  it("is none, with a reason, anywhere else", () => {
    assert.deepEqual(wakeRecipe({}), { kind: "none", reason: "not a Fly machine" });
    assert.deepEqual(wakeRecipe({ FLY_APP_NAME: "  " }), { kind: "none", reason: "not a Fly machine" });
  });
});

describe("a restart is not a sleep", () => {
  const fly = { FLY_APP_NAME: "brane-ben" };

  it("boot revive is on for Fly, off elsewhere, and config overrides both", () => {
    assert.equal(bootReviveEnabled(fly, undefined), true);
    assert.equal(bootReviveEnabled({}, undefined), false);
    assert.equal(bootReviveEnabled({}, "true"), true);
    assert.equal(bootReviveEnabled(fly, "false"), false);
  });

  it("downs the tailnet on a signal only on Fly, whatever config says", () => {
    assert.equal(tailscaleDownWanted("signal", fly, undefined), true);
    assert.equal(tailscaleDownWanted("signal", {}, undefined), false);
    assert.equal(tailscaleDownWanted("signal", {}, "true"), false, "a Mac's restart must not leave it off its own tailnet");
    assert.equal(tailscaleDownWanted("signal", fly, "false"), false);
  });

  it("downs the tailnet on an elective sleep on Fly, or where config asks", () => {
    for (const reason of ["idle", "operator"] as SleepReason[]) {
      assert.equal(tailscaleDownWanted(reason, fly, undefined), true);
      assert.equal(tailscaleDownWanted(reason, {}, undefined), false);
      assert.equal(tailscaleDownWanted(reason, {}, "true"), true);
      assert.equal(tailscaleDownWanted(reason, fly, "off"), false);
    }
  });

  it("writes a manifest on every elective sleep, and on a signal only where it would be read and holds something", () => {
    assert.equal(writesManifest("idle", [], false), true);
    assert.equal(writesManifest("operator", ["a"], false), true);
    assert.equal(writesManifest("signal", ["a"], false), false);
    assert.equal(writesManifest("signal", [], true), false);
    assert.equal(writesManifest("signal", ["a"], true), true);
  });

  it("records agents, not utility sessions", () => {
    assert.deepEqual(
      sleepingNarratives([
        { id: "claude-1", role: "worker" },
        { id: "zsh-1", role: "utility" },
        { id: "codex-1", role: "twin" },
      ]),
      ["claude-1", "codex-1"],
    );
  });
});

describe("the manifest and the exit record on disk", () => {
  it("round-trips the manifest and moves it aside, never deleting it", () => {
    const m = { slept_at: T0, reason: "operator" as const, narratives: ["claude-1", "codex-2"], host: "brane-ben" };
    writeSleepManifest(dir, m);
    assert.deepEqual(readSleepManifest(dir), m);
    assert.equal(retireSleepManifest(dir), true);
    assert.equal(existsSync(join(dir, SLEEP_MANIFEST)), false);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, SLEEP_MANIFEST_LAST), "utf8")), m);
    assert.equal(readSleepManifest(dir), null);
    assert.equal(retireSleepManifest(dir), false);
  });

  it("reads a malformed manifest as none", () => {
    writeFileSync(join(dir, SLEEP_MANIFEST), "{not json");
    assert.equal(readSleepManifest(dir), null);
    writeFileSync(join(dir, SLEEP_MANIFEST), JSON.stringify({ slept_at: T0, reason: "nap", narratives: [] }));
    assert.equal(readSleepManifest(dir), null);
  });

  it("round-trips the exit record, and boot moves it aside so only a clean exit leaves one", () => {
    writeExitRecord(dir, { exited_at: T0, reason: "signal", clean: true, pid: 42 });
    assert.deepEqual(readExitRecord(dir), { exited_at: T0, reason: "signal", clean: true, pid: 42 });
    const logs: string[] = [];
    assert.deepEqual(takeExitRecord(dir, (m) => logs.push(m))?.pid, 42);
    assert.equal(existsSync(join(dir, EXIT_RECORD)), false);
    assert.equal(existsSync(join(dir, EXIT_RECORD_LAST)), true);
    assert.equal(takeExitRecord(dir, (m) => logs.push(m)), null);
    assert.match(logs[1], /crashed/);
  });

  it("reads a handoff's exit record (reason restart) as clean", () => {
    writeExitRecord(dir, { exited_at: T0, reason: "restart", clean: true, pid: 7 });
    assert.deepEqual(readExitRecord(dir), { exited_at: T0, reason: "restart", clean: true, pid: 7 });
  });
});

describe("listTmuxSessions", () => {
  it("lists session names", () => {
    assert.deepEqual([...(listTmuxSessions(() => "claude-1\nzsh-2\n\n") ?? [])], ["claude-1", "zsh-2"]);
  });

  it("reads no tmux server as no sessions", () => {
    const fail = (stderr: string) => () => {
      throw Object.assign(new Error("Command failed"), { stderr });
    };
    assert.deepEqual(listTmuxSessions(fail("no server running on /tmp/tmux-501/default")), new Set());
    assert.deepEqual(listTmuxSessions(fail("error connecting to /tmp/tmux-501/default (No such file or directory)")), new Set());
  });

  it("reads anything else as unknown, which never sleeps", () => {
    assert.equal(
      listTmuxSessions(() => {
        throw Object.assign(new Error("spawnSync tmux ETIMEDOUT"), { stderr: "" });
      }),
      null,
    );
  });
});

/** A Sleeper over fakes: a clock, a session list, and recorders. */
function harness(opts: { live?: LiveNarrative[] | null; idle?: number | null; bootRevive?: boolean; fly?: boolean; backstopMs?: number } = {}) {
  let now = T0;
  let live: LiveNarrative[] | null = opts.live === undefined ? [] : opts.live;
  let tmuxCalls = 0;
  const announced: Array<[string, string]> = [];
  const shutdowns: number[] = [];
  const downs: number[] = [];
  const order: string[] = [];
  const exits: string[] = [];
  const sleeper = new Sleeper({
    braneDir: dir,
    liveNarratives: () => {
      tmuxCalls++;
      return live;
    },
    idleMinutes: () => (opts.idle === undefined ? 10 : opts.idle),
    bootRevive: () => opts.bootRevive ?? false,
    tailscaleDown: (reason) => tailscaleDownWanted(reason, opts.fly ? { FLY_APP_NAME: "x" } : {}, undefined),
    announce: (nid, content) => announced.push([nid, content]),
    shutdown: () => {
      order.push("shutdown");
      shutdowns.push(now);
    },
    runTailscaleDown: async () => {
      order.push("tailscale down");
      downs.push(now);
    },
    endSessions: () => endsSessions(opts.fly ? { FLY_APP_NAME: "x" } : {}),
    runEndSessions: async () => {
      order.push("end sessions");
    },
    forceExit: () => void exits.push("forced"),
    signalBudgetMs: opts.backstopMs,
    shutdownBackstopMs: opts.backstopMs,
    now: () => now,
    host: "test-host",
    pid: 4242,
    settleMs: 0,
  });
  return {
    sleeper,
    announced,
    shutdowns,
    downs,
    order,
    exits,
    advance: (ms: number) => (now += ms),
    setLive: (l: LiveNarrative[] | null) => (live = l),
    tmuxCalls: () => tmuxCalls,
  };
}

describe("Sleeper: the backstop", () => {
  // The harness's shutdown records and returns without exiting: a shutdown
  // stuck on a connection the downed tailnet can't close.
  for (const reason of ["operator", "idle", "signal"] as const) {
    it(`forces the exit when shutdown hangs after a ${reason} sleep`, async () => {
      const h = harness({ fly: true, backstopMs: 10 });
      await h.sleeper.sleep(reason);
      assert.deepEqual(h.exits, []);
      await new Promise((r) => setTimeout(r, 40));
      assert.deepEqual(h.exits, ["forced"]);
    });
  }
});

describe("Sleeper: ending sessions before the exit", () => {
  it("on Fly, ends every session before leaving the tailnet and shutting down", async () => {
    const h = harness({ fly: true, live: [{ id: "claude-aaaaaaaa", role: "worker" }], bootRevive: true });
    await h.sleeper.sleep("operator");
    assert.deepEqual(h.order, ["end sessions", "tailscale down", "shutdown"]);
  });

  it("on a signal on Fly too: the machine is stopping either way", async () => {
    const h = harness({ fly: true, bootRevive: true });
    await h.sleeper.sleep("signal");
    assert.deepEqual(h.order, ["end sessions", "tailscale down", "shutdown"]);
  });

  it("never on a Mac, where a signal is `brane daemon stop` and sessions outlive the daemon", async () => {
    for (const reason of ["signal", "operator", "idle"] as const) {
      const h = harness({ live: [{ id: "claude-aaaaaaaa", role: "worker" }] });
      await h.sleeper.sleep(reason);
      assert.equal(h.order.includes("end sessions"), false, reason);
    }
    assert.equal(endsSessions({}), false);
    assert.equal(endsSessions({ FLY_APP_NAME: " " }), false);
    assert.equal(endsSessions({ FLY_APP_NAME: "brane-x" }), true);
  });
});

describe("Sleeper: the idle rule's clock", () => {
  it("counts a host nobody connected to from its start", async () => {
    const h = harness();
    h.advance(10 * MIN - 1);
    assert.equal(h.sleeper.tick(), false);
    h.advance(1);
    assert.equal(h.sleeper.tick(), true);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.shutdowns.length, 1);
    const manifest = readSleepManifest(dir);
    assert.deepEqual(manifest && { reason: manifest.reason, narratives: manifest.narratives }, { reason: "idle", narratives: [] });
  });

  it("a client clears the clock, and its leaving restarts it", () => {
    const h = harness();
    h.sleeper.clientsChanged(1);
    h.advance(60 * MIN);
    assert.equal(h.sleeper.tick(), false);
    assert.equal(h.sleeper.status().last_client_disconnect, null);
    h.sleeper.clientsChanged(0);
    assert.equal(h.sleeper.status().last_client_disconnect, T0 + 60 * MIN);
    h.advance(9 * MIN);
    assert.equal(h.sleeper.tick(), false);
    h.advance(1 * MIN);
    assert.equal(h.sleeper.tick(), true);
  });

  it("asks tmux at fire time, and a session keeps the host awake", () => {
    const h = harness({ live: [{ id: "zsh-1", role: "utility" }] });
    h.advance(5 * MIN);
    assert.equal(h.sleeper.tick(), false);
    assert.equal(h.tmuxCalls(), 0, "not due yet: tmux is not asked");
    h.advance(60 * MIN);
    assert.equal(h.sleeper.tick(), false);
    assert.equal(h.tmuxCalls(), 1);
    h.setLive(null);
    assert.equal(h.sleeper.tick(), false, "unknown never sleeps");
    h.setLive([]);
    assert.equal(h.sleeper.tick(), true);
  });

  it("never fires with idle_minutes unset", () => {
    const h = harness({ idle: null });
    h.advance(1e9);
    assert.equal(h.sleeper.tick(), false);
    assert.equal(h.sleeper.status().idle_minutes, null);
  });

  it("reports status in its exact shape, with the session count cached briefly", () => {
    const h = harness({ live: [{ id: "claude-1", role: "worker" }] });
    assert.deepEqual(h.sleeper.status(), { idle_minutes: 10, last_client_disconnect: T0, sessions: 1 });
    h.setLive([]);
    assert.equal(h.sleeper.status().sessions, 1, "cached");
    h.advance(SESSIONS_CACHE_MS);
    assert.equal(h.sleeper.status().sessions, 0);
    h.setLive(null);
    h.advance(SESSIONS_CACHE_MS);
    assert.equal(h.sleeper.status().sessions, 0, "unknown keeps the last count");
  });
});

describe("Sleeper: the routine", () => {
  it("on the operator's act: tells each agent, writes both records, then shuts down", async () => {
    const h = harness({ live: [{ id: "claude-1", role: "worker" }, { id: "zsh-1", role: "utility" }] });
    assert.deepEqual(h.sleeper.plannedNarratives(), ["claude-1"]);
    const out = await h.sleeper.sleep("operator");
    assert.deepEqual(out, { reason: "operator", narratives: ["claude-1"], manifest: true, tailscaleDown: false });
    assert.deepEqual(h.announced.map(([nid]) => nid), ["claude-1"]);
    assert.match(h.announced[0][1], /going to sleep/);
    assert.deepEqual(readSleepManifest(dir), { slept_at: T0, reason: "operator", narratives: ["claude-1"], host: "test-host" });
    assert.deepEqual(readExitRecord(dir), { exited_at: T0, reason: "operator", clean: true, pid: 4242 });
    assert.equal(h.shutdowns.length, 1);
    assert.equal(h.downs.length, 0, "not on Fly");
  });

  it("runs once: a signal during a sleep changes nothing", async () => {
    const h = harness();
    const first = h.sleeper.sleep("operator");
    assert.equal(h.sleeper.sleeping, "operator");
    assert.equal(await h.sleeper.sleep("signal"), null);
    await first;
    assert.equal(h.shutdowns.length, 1);
    assert.equal(h.sleeper.tick(), false);
  });

  it("on a Mac's signal (a restart): no note, no manifest, only the exit record", async () => {
    const h = harness({ live: [{ id: "claude-1", role: "worker" }] });
    const out = await h.sleeper.sleep("signal");
    assert.deepEqual(out, { reason: "signal", narratives: ["claude-1"], manifest: false, tailscaleDown: false });
    assert.equal(h.announced.length, 0);
    assert.equal(existsSync(join(dir, SLEEP_MANIFEST)), false);
    assert.equal(readExitRecord(dir)?.reason, "signal");
    assert.equal(h.shutdowns.length, 1);
  });

  it("on Fly's signal: tells, records, and leaves the tailnet before shutting down", async () => {
    const h = harness({ live: [{ id: "claude-1", role: "worker" }], bootRevive: true, fly: true });
    const out = await h.sleeper.sleep("signal");
    assert.deepEqual(out, { reason: "signal", narratives: ["claude-1"], manifest: true, tailscaleDown: true });
    assert.equal(h.announced.length, 1);
    assert.deepEqual(readSleepManifest(dir)?.narratives, ["claude-1"]);
    assert.equal(h.downs.length, 1);
    assert.equal(h.shutdowns.length, 1);
  });
});

describe("bootRevive", () => {
  const manifest = { slept_at: T0, reason: "signal" as const, narratives: ["claude-1", "codex-2", "claude-3"], host: "h" };

  it("revives the manifest's narratives in order with the wake prompt, and moves it aside", async () => {
    writeSleepManifest(dir, manifest);
    const calls: Array<[string, string]> = [];
    const pauses: number[] = [];
    const revived = await bootRevive({
      braneDir: dir,
      enabled: true,
      alive: (nid) => nid === "codex-2",
      revive: (nid, prompt) => {
        calls.push([nid, prompt]);
        // Moved aside before the first revive, so a revive that takes the
        // daemon down is not retried every boot.
        assert.equal(existsSync(join(dir, SLEEP_MANIFEST)), false);
      },
      now: () => T0 + 5 * MIN,
      sleep: async (ms) => {
        pauses.push(ms);
      },
      gapMs: 7,
    });
    assert.deepEqual(revived, ["claude-1", "claude-3"]);
    assert.deepEqual(calls.map(([n]) => n), ["claude-1", "claude-3"], "a still-running session is skipped");
    assert.equal(calls[0][1], wakePrompt(manifest, T0 + 5 * MIN));
    assert.match(calls[0][1], /slept at 2026-11-08T12:00:00\.000Z \(signal\) and resumed at 2026-11-08T12:05:00\.000Z/);
    assert.deepEqual(pauses, [7]);
    assert.equal(existsSync(join(dir, SLEEP_MANIFEST_LAST)), true);
  });

  it("goes on past a revive that fails", async () => {
    writeSleepManifest(dir, manifest);
    const revived = await bootRevive({
      braneDir: dir,
      enabled: true,
      alive: () => false,
      revive: (nid) => {
        if (nid === "claude-1") throw new Error("Unknown narrative: claude-1");
      },
      sleep: async () => {},
    });
    assert.deepEqual(revived, ["codex-2", "claude-3"]);
  });

  it("off, moves a manifest aside unread, so a stale one cannot fire later", async () => {
    writeSleepManifest(dir, manifest);
    let called = 0;
    const revived = await bootRevive({ braneDir: dir, enabled: false, alive: () => false, revive: () => called++ });
    assert.deepEqual(revived, []);
    assert.equal(called, 0);
    assert.equal(existsSync(join(dir, SLEEP_MANIFEST)), false);
    assert.equal(existsSync(join(dir, SLEEP_MANIFEST_LAST)), true);
  });

  it("does nothing without a manifest", async () => {
    assert.deepEqual(await bootRevive({ braneDir: dir, enabled: true, alive: () => false, revive: () => assert.fail("no revive") }), []);
  });
});
