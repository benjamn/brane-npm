/**
 * `brane meld --remote`: a remote machine (Fly, a VPS) cannot show a
 * presence prompt, so the device token is minted on the operator's machine
 * and the remote gets only its hash (`BRANE_DEVICE_TOKEN_SHA256`), adopted as
 * its daemon starts. The remote sends back only its address (`brane meld
 * --connection`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "./helpers.js";
import { bootstrapTokens, DbTokenStore, REMOTE_MELD_LABEL, parseTokenHashes } from "../db/tokens.js";
import { TokenRing, UNUSED_TOKEN_LAPSE_MS, hashToken, mintRemoteToken } from "../daemon/token-ring.js";
import { buildMeldUrl, fillHash, meldLink, readMeldReply, refusesRemoteMeld } from "../commands/meld.js";

const T0 = Date.UTC(2026, 9, 5, 12);

function setup() {
  const db = createTestDb();
  const tokenFile = join(mkdtempSync(join(tmpdir(), "brane-remote-meld-")), ".daemon_token");
  let n = 0;
  return { db, tokenFile, mint: () => `local-${++n}` };
}

describe("the remote token's hash", () => {
  it("is the SHA-256 the daemon checks tokens by", () => {
    const { token, hash } = mintRemoteToken();
    assert.equal(hash, hashToken(token));
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.ok(token.length >= 40, "32 random bytes");
    assert.notEqual(mintRemoteToken().token, token);
  });

  it("goes into the --send command wherever it says {hash}, and nowhere else", () => {
    const h = hashToken("t");
    assert.equal(fillHash("fly secrets set BRANE_DEVICE_TOKEN_SHA256={hash} -a x", h), `fly secrets set BRANE_DEVICE_TOKEN_SHA256=${h} -a x`);
    assert.equal(fillHash("a={hash} b={hash}", h), `a=${h} b=${h}`);
    assert.throws(() => fillHash("fly secrets set BRANE_DEVICE_TOKEN_SHA256=oops", h), /\{hash\}/);
  });

  it("is read from the secret strictly, dropping anything malformed", () => {
    const h = hashToken("t");
    assert.deepEqual(parseTokenHashes(undefined), []);
    assert.deepEqual(parseTokenHashes(""), []);
    assert.deepEqual(parseTokenHashes(` ${h.toUpperCase()} , not-a-hash, ${h}`), [h]);
  });
});

describe("adopting a remote hash at startup", () => {
  it("makes the token on the operator's machine a working device token, and the hash only", () => {
    const { db, tokenFile, mint } = setup();
    const { token, hash } = mintRemoteToken();
    const boot = bootstrapTokens(db, { tokenFile, mint, configuredHashes: [hash], now: T0 });
    assert.deepEqual(boot.adopted, [REMOTE_MELD_LABEL]);
    const ring = new TokenRing(new DbTokenStore(db), () => "unused");
    const auth = ring.authenticate(token, T0 + 1);
    assert.equal(auth.ok && auth.record.kind, "device");
    assert.equal(auth.ok && auth.record.label, REMOTE_MELD_LABEL);
    assert.ok(!JSON.stringify(db.prepare("SELECT * FROM tokens").all()).includes(token));
  });

  it("adopts a hash once: the secret stays set across restarts, and a revoked one stays revoked", () => {
    const { db, tokenFile, mint } = setup();
    const { token, hash } = mintRemoteToken();
    bootstrapTokens(db, { tokenFile, mint, configuredHashes: [hash], now: T0 });
    const store = new DbTokenStore(db);
    const row = store.live("device").find((r) => r.label === REMOTE_MELD_LABEL)!;
    store.revoke([row.id], T0 + 1);
    const again = bootstrapTokens(db, { tokenFile, mint, configuredHashes: [hash], now: T0 + 2 });
    assert.deepEqual(again.adopted, []);
    const ring = new TokenRing(store, () => "unused");
    assert.equal(ring.authenticate(token, T0 + 3).ok, false);
  });

  it("lapses like any QR if nobody scans it", () => {
    const { db, tokenFile, mint } = setup();
    const { token, hash } = mintRemoteToken();
    bootstrapTokens(db, { tokenFile, mint, configuredHashes: [hash], now: T0 });
    const ring = new TokenRing(new DbTokenStore(db), () => "unused");
    assert.equal(ring.authenticate(token, T0 + UNUSED_TOKEN_LAPSE_MS + 1).ok, false);
  });
});

describe("the remote daemon's address", () => {
  const c = { daemonHost: "daemon-x.tail.ts.net:8443", scheme: "https", useLocal: false, isLoopbackFallback: false, tlsDegraded: false };

  it("is found among whatever else the --ask command printed", () => {
    const out = `Connecting to fdaa::3... complete\n${JSON.stringify({ ready: true, ...c })}\r\n`;
    assert.deepEqual(readMeldReply(out), { kind: "address", connection: c });
  });

  it("is waited for while the machine restarts, its daemon starts, or Tailscale has no name yet", () => {
    assert.equal(readMeldReply(null).kind, "wait");
    assert.deepEqual(readMeldReply('{"ready":false,"reason":"no daemon is running yet"}\n'), {
      kind: "wait",
      reason: "no daemon is running yet",
    });
    // A QR for 127.0.0.1 would be useless, and a wrong one costs a restart.
    const loopback = readMeldReply(JSON.stringify({ ready: true, ...c, daemonHost: "127.0.0.1:8443", isLoopbackFallback: true }));
    assert.deepEqual(loopback, { kind: "wait", reason: "the remote machine has no Tailscale name yet" });
  });

  it("follows the remote daemon's app host, end to end, and ignores one that is not a string", () => {
    // What `brane meld --connection` prints on a remote whose app_domain
    // names a fork's shell, read back by `--remote` and turned into the QR.
    const reply = readMeldReply(JSON.stringify({ ready: true, ...c, appHost: "https://Fork.example/" }));
    assert.equal(reply.kind, "address");
    if (reply.kind !== "address") return;
    assert.equal(reply.connection.appHost, "fork.example");
    assert.equal(new URL(meldLink(reply.connection, "tok")).host, "fork.example");
    // A remote that sends something other than a string names no shell.
    const odd = readMeldReply(JSON.stringify({ ready: true, ...c, appHost: 42 }));
    assert.equal(odd.kind === "address" && odd.connection.appHost, undefined);
  });

  it("calls an answer with no JSON line an older brane, which ran a plain meld", () => {
    assert.deepEqual(readMeldReply("\nScan this QR code to meld:\n█▀▀▀▀▀█\n"), { kind: "old" });
    assert.deepEqual(readMeldReply('{"daemonHost": 1}'), { kind: "old" });
  });

  it("makes the same URL brane meld would have, with the token minted elsewhere", () => {
    const db = createTestDb();
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('daemon_tls', 'true')").run();
    for (const local of [false, true]) {
      const full = buildMeldUrl({ db, daemon: { port: "8443", token: "tok" }, tailscaleHost: "h.ts.net", local });
      const { url: _u, ...connection } = buildMeldUrl({ db, daemon: { port: "8443", token: "" }, tailscaleHost: "h.ts.net", local });
      assert.equal(meldLink(connection, "tok"), full.url);
    }
  });
});

describe("refusesRemoteMeld", () => {
  it("refuses in an agent's session, which would read the printed token", () => {
    assert.match(refusesRemoteMeld({ BRANE_NARRATIVE_SECRET: "x" }) ?? "", /outside an agent session/);
  });

  it("runs from the operator's shell", () => {
    assert.equal(refusesRemoteMeld({}), null);
  });
});
