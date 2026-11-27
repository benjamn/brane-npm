import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeTailnetHost, parseTailnet, tailnetAnswer, TAILNET_HOSTS_MAX } from "../tailscale.js";
import { classifyRoute } from "../daemon/verification-gate.js";
import { routeMatcher, AGENT_ROUTES } from "../daemon/agent-scope.js";

// Shaped like `tailscale status --json` on 2026-11-26: a slept Fly machine
// (it ran `tailscale down`), a phone on a direct path, a peer never spoken to.
const STATUS = JSON.stringify({
  BackendState: "Running",
  Health: ["Some peers are advertising routes but --accept-routes is false"],
  Self: { DNSName: "rocinante.tail.ts.net.", TailscaleIPs: ["100.64.0.1"] },
  Peer: {
    "nodekey:a": {
      DNSName: "Daemon-Brane-NRT.tail.ts.net.", HostName: "daemon-brane-nrt", TailscaleIPs: ["100.111.36.44", "fd7a::1"],
      Online: false, LastSeen: "2026-11-26T15:40:00.1Z", CurAddr: "", Relay: "tok",
      LastHandshake: "2026-11-26T10:39:12.876799-05:00",
    },
    "nodekey:b": {
      DNSName: "iphone.tail.ts.net.", TailscaleIPs: ["100.89.190.4"],
      Online: true, LastSeen: "2026-11-26T15:00:00Z", CurAddr: "192.168.8.118:41641", Relay: "nyc",
      LastHandshake: "2026-11-26T15:43:51Z",
    },
    "nodekey:c": { DNSName: "ams.tail.ts.net.", TailscaleIPs: ["100.65.74.117"], Online: false, LastSeen: "0001-01-01T00:00:00Z", CurAddr: "", Relay: "ams", LastHandshake: "0001-01-01T00:00:00Z" },
    "nodekey:d": { HostName: "no-dns-name" },
    "nodekey:e": "garbage",
  },
});

describe("parseTailnet", () => {
  const view = parseTailnet(STATUS);

  it("reads control's online flag, the path and the handshake per peer", () => {
    assert.equal(view.available, true);
    assert.equal(view.state, "Running");
    assert.deepEqual(view.health, ["Some peers are advertising routes but --accept-routes is false"]);
    assert.deepEqual(view.peers.map((p) => p.host), ["daemon-brane-nrt.tail.ts.net", "iphone.tail.ts.net", "ams.tail.ts.net"]);
    const [nrt, phone, ams] = view.peers;
    assert.deepEqual(nrt, {
      host: "daemon-brane-nrt.tail.ts.net", ips: ["100.111.36.44", "fd7a::1"], online: false,
      last_seen: "2026-11-26T15:40:00.100Z", direct: false, relay: "tok", last_handshake: "2026-11-26T15:39:12.876Z",
    });
    assert.equal(phone.online, true);
    assert.equal(phone.direct, true);
    assert.equal(phone.last_seen, null, "last_seen is for a peer that is offline");
    assert.equal(ams.last_seen, null, "Go's zero time is never");
    assert.equal(ams.last_handshake, null);
  });

  it("anything that is not a status is 'not available', never a throw", () => {
    for (const bad of ["", "not json", "null", "[]", "42", '{"Peer": 7}']) {
      const v = parseTailnet(bad);
      assert.deepEqual(v.peers, []);
    }
    assert.equal(parseTailnet("not json").available, false);
  });
});

describe("tailnetAnswer", () => {
  const view = parseTailnet(STATUS);

  it("answers only for the hosts asked, compared without case, port or trailing dot", () => {
    const a = tailnetAnswer(view, ["DAEMON-brane-nrt.tail.ts.net:39909", "unknown.tail.ts.net", ""], null);
    assert.deepEqual(a.peers.map((p) => p.host), ["daemon-brane-nrt.tail.ts.net"]);
    assert.equal(a.client, null);
    assert.equal(normalizeTailnetHost(" Foo.ts.net.:443 ".trim()), "foo.ts.net.".replace(/\.$/, ""));
  });

  it("asking for nothing lists nothing: the route does not enumerate the tailnet", () => {
    assert.deepEqual(tailnetAnswer(view, [], null).peers, []);
    assert.deepEqual(tailnetAnswer(view, [""], null).peers, []);
  });

  it("names the peer the request came from, IPv4-mapped or not", () => {
    assert.equal(tailnetAnswer(view, [], "100.89.190.4").client?.host, "iphone.tail.ts.net");
    assert.equal(tailnetAnswer(view, [], "::ffff:100.89.190.4").client?.host, "iphone.tail.ts.net");
    assert.equal(tailnetAnswer(view, [], "127.0.0.1").client, null, "loopback behind userspace tailscaled is nobody");
    assert.equal(tailnetAnswer(view, [], undefined).client, null);
  });

  it("caps how many hosts one request may ask about", () => {
    const many = Array.from({ length: TAILNET_HOSTS_MAX + 5 }, () => "x.ts.net").concat("iphone.tail.ts.net");
    assert.deepEqual(tailnetAnswer(view, many, null).peers, []);
  });

  it("with no Tailscale, says so and nothing else", () => {
    const a = tailnetAnswer(parseTailnet("nope"), ["iphone.tail.ts.net"], "100.89.190.4");
    assert.deepEqual(a, { available: false, state: null, health: [], peers: [], client: null });
  });
});

describe("GET /api/tailnet", () => {
  it("is a free read for a device and closed to agents", () => {
    assert.deepEqual(classifyRoute("GET", "/api/tailnet"), { kind: "free" });
    assert.equal(routeMatcher(AGENT_ROUTES)("GET", "/api/tailnet"), false);
  });
});
