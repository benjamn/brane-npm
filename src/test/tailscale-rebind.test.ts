import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addressesToBind,
  nextProbeDelay,
  TAILSCALE_PROBE_INITIAL_MS,
  TAILSCALE_PROBE_MAX_MS,
  TAILSCALE_PROBE_STEADY_MS,
} from "../daemon/tailscale-rebind.js";
import { parseTailscaleIps } from "../tailscale.js";

describe("nextProbeDelay", () => {
  it("starts the not-found backoff at the initial delay", () => {
    assert.equal(nextProbeDelay(null, false), TAILSCALE_PROBE_INITIAL_MS);
    assert.equal(nextProbeDelay(0, false), TAILSCALE_PROBE_INITIAL_MS);
  });

  // The daemon seeds its first timer with nextProbeDelay(null, …) and keeps
  // `probeDelay` at null until the first probe runs, so the first *computed*
  // step is the initial delay again. That extra 5 s tick is deliberate — one
  // quick retry for a Tailscale that is merely still launching — and this
  // pins the sequence the daemon actually runs, not an idealized one.
  it("runs 5, 5, 10, 20, 40, 60 while nothing is found, then holds the cap", () => {
    const seen: number[] = [nextProbeDelay(null, false)];
    let d: number | null = null;
    for (let i = 0; i < 7; i++) {
      d = nextProbeDelay(d, false);
      seen.push(d);
    }
    assert.deepEqual(seen, [5_000, 5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    assert.equal(Math.max(...seen), TAILSCALE_PROBE_MAX_MS);
  });

  // A found probe resets to the steady cadence no matter how deep the
  // backoff had gone — the daemon should notice a later address change in
  // a minute, not in whatever the backoff had climbed to.
  it("returns to the steady cadence once Tailscale is seen", () => {
    assert.equal(nextProbeDelay(60_000, true), TAILSCALE_PROBE_STEADY_MS);
    assert.equal(nextProbeDelay(null, true), TAILSCALE_PROBE_STEADY_MS);
  });
});

describe("addressesToBind", () => {
  it("returns only addresses not already bound, in probe order", () => {
    const bound = ["127.0.0.1", "::1"];
    assert.deepEqual(
      addressesToBind(bound, ["100.64.167.92", "fd7a:115c:a1e0::4401:a76f"]),
      ["100.64.167.92", "fd7a:115c:a1e0::4401:a76f"],
    );
  });

  // The scenario this module exists for: the daemon came up blind, Tailscale
  // recovered, and a later probe reports the same two addresses every
  // minute. The first such probe binds them; every later one must be a no-op.
  it("is a no-op once the probed addresses are bound", () => {
    const ips = ["100.64.167.92", "fd7a:115c:a1e0::4401:a76f"];
    const bound = new Set(["127.0.0.1", "::1"]);
    for (const a of addressesToBind(bound, ips)) bound.add(a);
    assert.deepEqual(addressesToBind(bound, ips), []);
  });

  it("drops blanks and duplicates within one probe", () => {
    assert.deepEqual(addressesToBind([], ["", " 100.64.1.1 ", "100.64.1.1"]), ["100.64.1.1"]);
  });

  it("picks up an address that changed since the last probe", () => {
    const bound = ["127.0.0.1", "::1", "100.64.167.92"];
    assert.deepEqual(addressesToBind(bound, ["100.64.200.7"]), ["100.64.200.7"]);
  });
});

describe("parseTailscaleIps", () => {
  it("reads Self.TailscaleIPs", () => {
    const out = JSON.stringify({ Self: { TailscaleIPs: ["100.64.167.92", "fd7a:115c:a1e0::4401:a76f"] } });
    assert.deepEqual(parseTailscaleIps(out), ["100.64.167.92", "fd7a:115c:a1e0::4401:a76f"]);
  });

  // The three ways the CLI's answer can be wrong, each of which must read
  // as "no Tailscale" rather than throw: a hung/killed CLI leaves partial or
  // empty output; a version skew can drop the field; a corrupt value must
  // not smuggle a non-string into a bind address.
  it("is empty on non-JSON (timeout, partial output)", () => {
    assert.deepEqual(parseTailscaleIps(""), []);
    assert.deepEqual(parseTailscaleIps('{"Self":{"TailscaleIPs":["100.64.'), []);
  });

  it("is empty when Self or TailscaleIPs is absent", () => {
    assert.deepEqual(parseTailscaleIps("{}"), []);
    assert.deepEqual(parseTailscaleIps(JSON.stringify({ Self: {} })), []);
    assert.deepEqual(parseTailscaleIps(JSON.stringify({ Self: { TailscaleIPs: null } })), []);
  });

  it("keeps only string entries", () => {
    const out = JSON.stringify({ Self: { TailscaleIPs: ["100.64.1.1", 7, null, "fd7a::1"] } });
    assert.deepEqual(parseTailscaleIps(out), ["100.64.1.1", "fd7a::1"]);
  });
});
