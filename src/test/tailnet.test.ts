import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkMeldHost,
  hostnameOf,
  isFirstMeld,
  meldRefusalMessage,
  tailnetOf,
  trustDomainOf,
} from "../shared/tailnet.js";

describe("tailnetOf", () => {
  it("reads the tailnet off a MagicDNS name, port or not", () => {
    assert.equal(tailnetOf("mac.tail1234.ts.net"), "tail1234.ts.net");
    assert.equal(tailnetOf("mac.tail1234.ts.net:47443"), "tail1234.ts.net");
    assert.equal(tailnetOf("Mac.Tail1234.TS.net."), "tail1234.ts.net");
    assert.equal(tailnetOf("mac.cat-crocodile.ts.net"), "cat-crocodile.ts.net");
  });

  it("is null for anything that is not a machine under a tailnet", () => {
    assert.equal(tailnetOf("tail1234.ts.net"), null);
    assert.equal(tailnetOf("ts.net"), null);
    assert.equal(tailnetOf("100.101.102.103:58353"), null);
    assert.equal(tailnetOf("brane.organelle.dev"), null);
    assert.equal(tailnetOf("mac.tail1234.ts.net.evil.com"), null);
    assert.equal(tailnetOf("localhost:8081"), null);
  });
});

describe("trustDomainOf", () => {
  it("is the tailnet for a MagicDNS name", () => {
    assert.equal(trustDomainOf("mac.tail1234.ts.net:47443"), "tail1234.ts.net");
  });

  it("is one domain for every loopback spelling", () => {
    for (const h of ["localhost", "localhost:58353", "127.0.0.1:58353", "127.9.9.9", "[::1]:58353", "app.localhost"]) {
      assert.equal(trustDomainOf(h), "localhost", h);
    }
  });

  it("is the hostname itself for any other host", () => {
    assert.equal(trustDomainOf("100.101.102.103:58353"), "100.101.102.103");
    assert.equal(trustDomainOf("192.168.1.5:58353"), "192.168.1.5");
    assert.equal(trustDomainOf("brane.example.com"), "brane.example.com");
  });

  it("is null for what is not a host", () => {
    for (const h of ["", "  ", "https://mac.tail1234.ts.net", "mac.tail1234.ts.net/x", "user@mac.tail1234.ts.net", "a b"]) {
      assert.equal(trustDomainOf(h), null, h);
      assert.equal(hostnameOf(h), null, h);
    }
  });
});

describe("checkMeldHost", () => {
  const home = ["mac.tail1234.ts.net:47443", "studio.tail1234.ts.net:51000"];

  it("lets the first meld pick the domain, and says it does", () => {
    assert.deepEqual(checkMeldHost("evil.tail5678.ts.net", []), { ok: true, domain: "tail5678.ts.net", setsHome: true });
    assert.deepEqual(checkMeldHost("192.168.1.5:58353", []), { ok: true, domain: "192.168.1.5", setsHome: true });
  });

  it("admits another machine on the same tailnet", () => {
    assert.deepEqual(checkMeldHost("fly-box.tail1234.ts.net", home), { ok: true, domain: "tail1234.ts.net", setsHome: false });
  });

  it("refuses a daemon on another tailnet, which is what a Funnel host is", () => {
    assert.deepEqual(checkMeldHost("ben-macbook.tail5678.ts.net", home), {
      ok: false,
      domain: "tail5678.ts.net",
      home: ["tail1234.ts.net"],
    });
  });

  it("refuses IPs and public names beside a tailnet, and the reverse", () => {
    for (const h of ["100.101.102.103:58353", "192.168.1.5:58353", "brane.organelle.dev"]) {
      assert.equal(checkMeldHost(h, home).ok, false, h);
    }
    assert.equal(checkMeldHost("mac.tail1234.ts.net", ["100.101.102.103:58353"]).ok, false);
  });

  it("admits loopback beside a tailnet, without it deciding anything", () => {
    for (const h of ["127.0.0.1:58353", "localhost:58353", "[::1]:58353"]) {
      assert.deepEqual(checkMeldHost(h, home), { ok: true, domain: "localhost", setsHome: false }, h);
      assert.deepEqual(checkMeldHost(h, []), { ok: true, domain: "localhost", setsHome: false }, h);
    }
  });

  it("treats a browser with only loopback daemons as holding no domain, so its first tailnet is screened", () => {
    assert.deepEqual(checkMeldHost("mac.tail1234.ts.net", ["localhost:58353"]), { ok: true, domain: "tail1234.ts.net", setsHome: true });
    // …and once that tailnet is held, loopback beside it decides nothing.
    assert.deepEqual(checkMeldHost("other.tail5678.ts.net", ["localhost:58353", "mac.tail1234.ts.net"]), {
      ok: false,
      domain: "tail5678.ts.net",
      home: ["tail1234.ts.net"],
    });
  });

  it("lets a browser that already holds two domains add to either, and nothing else", () => {
    const mixed = ["mac.tail1234.ts.net", "box.tail5678.ts.net"];
    assert.equal(checkMeldHost("other.tail5678.ts.net", mixed).ok, true);
    const third = checkMeldHost("x.tail9999.ts.net", mixed);
    assert.deepEqual(third, { ok: false, domain: "tail9999.ts.net", home: ["tail1234.ts.net", "tail5678.ts.net"] });
  });

  it("refuses an unparseable candidate and ignores unparseable stored hosts", () => {
    assert.deepEqual(checkMeldHost("https://mac.tail1234.ts.net", []), { ok: false, domain: null, home: [] });
    assert.equal(checkMeldHost("mac.tail1234.ts.net", ["not a host"]).ok, true);
  });
});

describe("meldRefusalMessage", () => {
  it("names both tailnets and the ways out", () => {
    const v = checkMeldHost("evil.tail5678.ts.net:443", ["mac.tail1234.ts.net"]);
    assert.equal(v.ok, false);
    if (v.ok) return;
    const msg = meldRefusalMessage("evil.tail5678.ts.net:443", v);
    assert.match(msg, /^evil\.tail5678\.ts\.net is on tail5678\.ts\.net, but this browser's daemons are on tail1234\.ts\.net\./);
    assert.match(msg, /another browser or profile/);
  });
});

describe("isFirstMeld", () => {
  const ok = (candidate: string, hosts: string[]) => {
    const v = checkMeldHost(candidate, hosts);
    assert.equal(v.ok, true);
    return v as Extract<typeof v, { ok: true }>;
  };
  const APP = "brane.organelle.dev";

  it("warns in a browser with no daemons, loopback link included", () => {
    assert.equal(isFirstMeld([], ok("mac.tail1234.ts.net", []), "mac.tail1234.ts.net", APP), true);
    assert.equal(isFirstMeld([], ok("127.0.0.1:58353", []), "127.0.0.1:58353", APP), true);
  });

  it("warns when the meld picks the domain beside loopback daemons", () => {
    const hosts = ["localhost:58353"];
    assert.equal(isFirstMeld(hosts, ok("mac.tail1234.ts.net", hosts), "mac.tail1234.ts.net", APP), true);
  });

  it("doesn't warn once the domain is held", () => {
    const hosts = ["mac.tail1234.ts.net"];
    assert.equal(isFirstMeld(hosts, ok("box.tail1234.ts.net", hosts), "box.tail1234.ts.net", APP), false);
    assert.equal(isFirstMeld(hosts, ok("localhost:58353", hosts), "localhost:58353", APP), false);
  });

  it("never warns on the daemon's own origin, where Isolate lands", () => {
    const host = "mac.tail1234.ts.net:47443";
    assert.equal(isFirstMeld([], ok(host, []), host, "MAC.tail1234.ts.net:47443"), false);
  });
});
