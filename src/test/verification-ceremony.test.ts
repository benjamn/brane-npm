/**
 * The ceremonies behind the gate (src/daemon/verification-ceremony.ts) and
 * the switch-on retirement (src/daemon/verification-switch.ts), against a
 * real token and credential store and a software authenticator: approvals
 * bound to the token that asked, single-use challenges with a prefetch in
 * flight, enrollment behind the presence check unless hardware vouches for
 * itself.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers.js";
import { DbTokenStore, mintAgentToken, recordLauncher } from "../db/tokens.js";
import { DbCredentialStore } from "../db/credentials.js";
import { hashToken } from "../daemon/token-ring.js";
import {
  APPROVAL_TTL_MS,
  Ceremonies,
  MAX_FAILURES,
  type CeremonyDeps,
  type RelyingParty,
} from "../daemon/verification-ceremony.js";
import { settleSwitch } from "../daemon/verification-switch.js";
import { FRESH_WINDOW_MS } from "../daemon/verification-gate.js";
import { trustStore } from "../webauthn/verify.js";
import { SoftAuthenticator, FLAG_UP } from "./soft-authenticator.js";
import { TEST_AAGUID, TEST_INT_PEM, TEST_LEAF_KEY_PEM, TEST_LEAF_PEM, TEST_ROOT_PEM } from "./fixtures/webauthn-certs.js";
import type { RouteAnswer } from "../daemon/gated-routes.js";

const RP: RelyingParty = { rpId: "mac.tail0000.ts.net", origin: "https://mac.tail0000.ts.net:47443", origins: ["https://mac.tail0000.ts.net:47443"] };
// After the test PKI was issued (2026-10-17T20:23Z).
const T0 = Date.UTC(2027, 0, 1);

type Body = Record<string, any>;

function setup(over: Partial<CeremonyDeps> = {}) {
  const db = createTestDb();
  const tokens = new DbTokenStore(db);
  const credentials = new DbCredentialStore(db);
  const phone = tokens.insert(hashToken("phone"), "device", "phone", T0, { used: true });
  const laptop = tokens.insert(hashToken("laptop"), "device", "laptop", T0, { used: true });
  const clock = { now: T0 };
  const presence: string[] = [];
  const verified: Array<[string, number]> = [];
  let presenceAnswer: RouteAnswer<{ error: string; presence: string }> | null = null;
  const deps: CeremonyDeps = {
    credentials,
    verifyToken: (id, opts) => tokens.verify(id, opts),
    isLiveDevice: (id) => tokens.get(id)?.kind === "device",
    windowMs: () => 10 * 60_000,
    rp: () => RP,
    trust: trustStore([TEST_ROOT_PEM], [TEST_INT_PEM]),
    userHandle: () => Buffer.alloc(32, 7),
    confirmPresence: async (by) => {
      presence.push(by);
      return presenceAnswer;
    },
    describeToken: (id) => tokens.get(id)?.label ?? null,
    onVerified: (id, until) => verified.push([id, until]),
    now: () => clock.now,
    ...over,
  };
  const ceremonies = new Ceremonies(deps);
  return {
    db,
    tokens,
    credentials,
    phone,
    laptop,
    clock,
    presence,
    verified,
    ceremonies,
    declinePresence: () => {
      presenceAnswer = { status: 403, body: { error: "declined", presence: "canceled" } };
    },
  };
}

function approvalOf(answer: RouteAnswer): string {
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return (answer.body as Body).approval;
}

function challengeOf(answer: RouteAnswer): string {
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return (answer.body as Body).publicKey.challenge;
}

/** Enroll `key` through the whole ceremony, presence approved. */
async function enroll(s: ReturnType<typeof setup>, key: SoftAuthenticator, tokenId = s.phone.id): Promise<RouteAnswer> {
  const approval = approvalOf(s.ceremonies.begin(tokenId, "enroll"));
  const challenge = challengeOf(s.ceremonies.challenge(approval, "enroll"));
  return s.ceremonies.finishEnroll({ approval, credential: key.create(challenge) });
}

describe("begin", () => {
  it("hands a device an approval bound to its own token, and a URL on the daemon's origin", () => {
    const s = setup();
    const answer = s.ceremonies.begin(s.phone.id, "verify");
    const body = answer.body as Body;
    assert.equal(answer.status, 200);
    assert.equal(body.expires_at, T0 + APPROVAL_TTL_MS);
    const url = new URL(body.url);
    assert.equal(url.origin, RP.origin);
    assert.equal(url.pathname, "/verify");
    assert.equal(url.search, "", "the approval rides in the fragment, which no server sees");
    const frag = new URLSearchParams(url.hash.slice(1));
    assert.equal(frag.get("approval"), body.approval);
    assert.equal(frag.get("purpose"), "verify");
  });

  it("refuses anything but a live device token, and a daemon without TLS", () => {
    const s = setup();
    const agent = s.tokens.insert(hashToken("agent"), "agent", "claude-x", T0, { used: true });
    assert.equal(s.ceremonies.begin(agent.id, "verify").status, 403);
    s.tokens.revoke([s.phone.id], T0);
    assert.equal(s.ceremonies.begin(s.phone.id, "verify").status, 403);
    const noTls = setup({ rp: () => null });
    assert.equal(noTls.ceremonies.begin(noTls.phone.id, "verify").status, 409);
  });
});

describe("verify", () => {
  it("verifies the approval's token for the window, fresh for a minute, and tells its sockets", async () => {
    const s = setup();
    const key = new SoftAuthenticator(RP.rpId, RP.origin);
    assert.equal((await enroll(s, key)).status, 200);
    const approval = approvalOf(s.ceremonies.begin(s.phone.id, "verify"));
    const options = s.ceremonies.challenge(approval, "verify").body as Body;
    assert.equal(options.enrolled, 1);
    const [kind] = options.publicKey.kinds;
    assert.deepEqual(kind.allowCredentials.map((c: Body) => c.id), [key.id.toString("base64url")]);
    assert.deepEqual(kind.allowCredentials[0].transports, ["usb"], "an unknown transport is never handed back");
    const answer = s.ceremonies.finishVerify({ approval, credential: key.get(options.publicKey.challenge) });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(s.tokens.verification(s.phone.id, T0), { verifiedUntil: T0 + 10 * 60_000, freshUntil: T0 + FRESH_WINDOW_MS });
    assert.deepEqual(s.verified, [[s.phone.id, T0 + 10 * 60_000]]);
    assert.deepEqual(s.tokens.verification(s.laptop.id, T0), { verifiedUntil: null, freshUntil: null });
  });

  it("verifies only the token that asked, whatever the body names (claude-vxnhxcg9:25 #3)", async () => {
    const s = setup();
    const key = new SoftAuthenticator(RP.rpId, RP.origin);
    await enroll(s, key);
    const approval = approvalOf(s.ceremonies.begin(s.phone.id, "verify"));
    const challenge = challengeOf(s.ceremonies.challenge(approval, "verify"));
    const answer = s.ceremonies.finishVerify({ approval, tokenId: s.laptop.id, token: s.laptop.id, credential: key.get(challenge) });
    assert.equal(answer.status, 200);
    assert.notEqual(s.tokens.verification(s.phone.id, T0).verifiedUntil, null);
    assert.equal(s.tokens.verification(s.laptop.id, T0).verifiedUntil, null);
  });

  it("is single-use: the approval and the challenge are spent by a passing answer", async () => {
    const s = setup();
    const key = new SoftAuthenticator(RP.rpId, RP.origin);
    await enroll(s, key);
    const approval = approvalOf(s.ceremonies.begin(s.phone.id, "verify"));
    const challenge = challengeOf(s.ceremonies.challenge(approval, "verify"));
    const credential = key.get(challenge);
    assert.equal(s.ceremonies.finishVerify({ approval, credential }).status, 200);
    assert.equal(s.ceremonies.finishVerify({ approval, credential }).status, 410);
    // Replayed under a fresh approval, the old challenge is nobody's.
    const again = approvalOf(s.ceremonies.begin(s.phone.id, "verify"));
    challengeOf(s.ceremonies.challenge(again, "verify"));
    assert.equal((s.ceremonies.finishVerify({ approval: again, credential }).body as Body).reason, "challenge");
  });

  it("spends a challenge on a failed answer too", async () => {
    const s = setup();
    const key = new SoftAuthenticator(RP.rpId, RP.origin);
    await enroll(s, key);
    const approval = approvalOf(s.ceremonies.begin(s.phone.id, "verify"));
    const challenge = challengeOf(s.ceremonies.challenge(approval, "verify"));
    assert.equal((s.ceremonies.finishVerify({ approval, credential: key.get(challenge, FLAG_UP) }).body as Body).reason, "user-verification");
    assert.equal((s.ceremonies.finishVerify({ approval, credential: key.get(challenge) }).body as Body).reason, "challenge");
  });

  it("accepts the answer to a challenge the page has already prefetched past (claude-pbg4whll:31)", async () => {
    const s = setup();
    const key = new SoftAuthenticator(RP.rpId, RP.origin);
    await enroll(s, key);
    const approval = approvalOf(s.ceremonies.begin(s.phone.id, "verify"));
    const first = challengeOf(s.ceremonies.challenge(approval, "verify"));
    challengeOf(s.ceremonies.challenge(approval, "verify"));
    assert.equal(s.ceremonies.finishVerify({ approval, credential: key.get(first) }).status, 200);
  });

  it("refuses an approval for the other purpose, an expired one, and one whose device was signed out", async () => {
    const s = setup();
    const key = new SoftAuthenticator(RP.rpId, RP.origin);
    await enroll(s, key);
    const enrollApproval = approvalOf(s.ceremonies.begin(s.phone.id, "enroll"));
    assert.equal(s.ceremonies.challenge(enrollApproval, "verify").status, 410);
    const approval = approvalOf(s.ceremonies.begin(s.phone.id, "verify"));
    const challenge = challengeOf(s.ceremonies.challenge(approval, "verify"));
    s.clock.now = T0 + APPROVAL_TTL_MS;
    assert.equal(s.ceremonies.finishVerify({ approval, credential: key.get(challenge) }).status, 410);
    s.clock.now = T0;
    const late = approvalOf(s.ceremonies.begin(s.phone.id, "verify"));
    const c2 = challengeOf(s.ceremonies.challenge(late, "verify"));
    s.tokens.revoke([s.phone.id], T0);
    assert.equal(s.ceremonies.finishVerify({ approval: late, credential: key.get(c2) }).status, 410);
  });

  it("refuses a credential that is not enrolled, and burns the approval after repeated bad answers", async () => {
    const s = setup();
    await enroll(s, new SoftAuthenticator(RP.rpId, RP.origin));
    const stranger = new SoftAuthenticator(RP.rpId, RP.origin);
    const approval = approvalOf(s.ceremonies.begin(s.phone.id, "verify"));
    for (let i = 0; i < MAX_FAILURES; i++) {
      const challenge = challengeOf(s.ceremonies.challenge(approval, "verify"));
      const answer = s.ceremonies.finishVerify({ approval, credential: stranger.get(challenge) });
      assert.equal((answer.body as Body).reason, "credential");
    }
    assert.equal(s.ceremonies.challenge(approval, "verify").status, 410);
  });

  it("refuses touch alone from an unattested passkey", async () => {
    const s = setup();
    const key = new SoftAuthenticator(RP.rpId, RP.origin);
    await enroll(s, key);
    const approval = approvalOf(s.ceremonies.begin(s.phone.id, "verify"));
    const challenge = challengeOf(s.ceremonies.challenge(approval, "verify"));
    assert.equal((s.ceremonies.finishVerify({ approval, credential: key.get(challenge, FLAG_UP) }).body as Body).reason, "user-verification");
  });

  // The ask must match the check, per kind (claude-oci3rpdp:16,
  // claude-933bjhez:4): "preferred" let a passkey provider answer with touch
  // alone, which the verifier refuses, and still collects a key's PIN.
  it("offers a kind per credential kind enrolled, each asking what the verifier checks", async () => {
    const s = setup();
    const passkey = new SoftAuthenticator(RP.rpId, RP.origin);
    await enroll(s, passkey);
    const ask = () => {
      const approval = approvalOf(s.ceremonies.begin(s.phone.id, "verify"));
      return { approval, options: (s.ceremonies.challenge(approval, "verify").body as Body).publicKey };
    };
    const only = ask().options.kinds;
    assert.deepEqual(only.map((k: Body) => [k.kind, k.userVerification]), [["passkey", "required"]]);

    const yubikey = new SoftAuthenticator(RP.rpId, RP.origin, { x5c: [TEST_LEAF_PEM], keyPem: TEST_LEAF_KEY_PEM, aaguid: TEST_AAGUID });
    await enroll(s, yubikey);
    const { approval, options } = ask();
    assert.deepEqual(options.kinds.map((k: Body) => [k.kind, k.userVerification]), [["passkey", "required"], ["security-key", "discouraged"]]);
    const ids = (kind: string) => options.kinds.find((k: Body) => k.kind === kind).allowCredentials.map((c: Body) => c.id);
    assert.deepEqual(ids("passkey"), [passkey.id.toString("base64url")]);
    assert.deepEqual(ids("security-key"), [yubikey.id.toString("base64url")]);
    const answer = s.ceremonies.finishVerify({ approval, credential: yubikey.get(options.challenge, FLAG_UP) });
    assert.equal(answer.status, 200, "an attested key's touch alone verifies: " + JSON.stringify(answer.body));
  });

  it("names the credential whose answer it refused", async () => {
    const log: string[] = [];
    const s = setup({ log: (line) => log.push(line) });
    const passkey = new SoftAuthenticator(RP.rpId, RP.origin);
    await enroll(s, passkey);
    const approval = approvalOf(s.ceremonies.begin(s.phone.id, "verify"));
    const challenge = challengeOf(s.ceremonies.challenge(approval, "verify"));
    assert.equal((s.ceremonies.finishVerify({ approval, credential: passkey.get(challenge, FLAG_UP) }).body as Body).reason, "user-verification");
    const [c] = s.credentials.list();
    assert.ok(log.some((l) => l.includes("refused") && l.includes(`with ${c.id} (${c.label})`)), log.join("\n"));
  });
});

describe("enroll", () => {
  it("asks the Mac for an unattested credential, and stores it once approved", async () => {
    const s = setup();
    const answer = await enroll(s, new SoftAuthenticator(RP.rpId, RP.origin));
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(s.presence, ["phone"]);
    const [c] = s.credentials.list();
    assert.equal(c.enrolled_by, "presence at this machine");
    assert.equal(c.enrolled_via, s.phone.id);
    assert.equal(c.attested, false);
    assert.equal(c.label, "Device-bound key from phone");
  });

  it("stores nothing when the Mac declines", async () => {
    const s = setup();
    s.declinePresence();
    const answer = await enroll(s, new SoftAuthenticator(RP.rpId, RP.origin));
    assert.equal(answer.status, 403);
    assert.equal(s.credentials.count(), 0);
  });

  it("lets attested hardware vouch for itself: no prompt, the first credential included (decision 14)", async () => {
    const s = setup();
    const key = new SoftAuthenticator(RP.rpId, RP.origin, { x5c: [TEST_LEAF_PEM], keyPem: TEST_LEAF_KEY_PEM, aaguid: TEST_AAGUID });
    const answer = await enroll(s, key);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(s.presence, []);
    const [c] = s.credentials.list();
    assert.equal(c.attested, true);
    assert.match(c.enrolled_by, /^attestation: CN=Brane Test Attestation Root root/);
    assert.equal(c.label, "Security key from phone");
    assert.deepEqual(c.transports, ["usb"]);
  });

  it("never re-admits a credential, revoked or not", async () => {
    const s = setup();
    const key = new SoftAuthenticator(RP.rpId, RP.origin);
    assert.equal((await enroll(s, key)).status, 200);
    assert.equal(((await enroll(s, key)).body as Body).reason, "known");
    s.credentials.revoke(s.credentials.list()[0].id, T0);
    assert.equal(((await enroll(s, key)).body as Body).reason, "known");
  });

  it("offers the enrolled credentials to exclude, and the operator's random handle", async () => {
    const s = setup();
    const key = new SoftAuthenticator(RP.rpId, RP.origin);
    await enroll(s, key);
    const approval = approvalOf(s.ceremonies.begin(s.phone.id, "enroll"));
    const o = (s.ceremonies.challenge(approval, "enroll").body as Body).publicKey;
    assert.deepEqual(o.excludeCredentials.map((c: Body) => c.id), [key.id.toString("base64url")]);
    assert.equal(o.user.id, Buffer.alloc(32, 7).toString("base64url"));
    assert.equal(o.attestation, "direct");
    assert.deepEqual(o.rp, { id: RP.rpId, name: "brane" });
  });
});

describe("the switch from off", () => {
  function withAgents() {
    const db = createTestDb();
    const tokens = new DbTokenStore(db);
    const phone = tokens.insert(hashToken("phone"), "device", "phone", T0, { used: true });
    const add = (nid: string, type: string) => {
      db.prepare("INSERT INTO narratives (id, brane_id, agent_type, created_at) VALUES (?, 'b', ?, ?)").run(nid, type, T0);
      mintAgentToken(db, nid, T0);
      recordLauncher(db, nid, phone.id);
      return db.prepare("SELECT id FROM tokens WHERE owner_nid = ? AND revoked_at IS NULL").get(nid) as { id: string };
    };
    return { db, tokens, external: add("external-abc", "external"), spawned: add("claude-abc", "claude") };
  }

  it("revokes the externals a device dialed while off, and nothing a spawn started (claude-vxnhxcg9:16)", () => {
    const { db, tokens, external, spawned } = withAgents();
    assert.equal(settleSwitch(db, "off", tokens, T0), null);
    const outcome = settleSwitch(db, "passkey", tokens, T0);
    assert.deepEqual(outcome, { from: "off", to: "passkey", revoked: [external.id] });
    assert.equal(tokens.get(external.id), null);
    assert.notEqual(tokens.get(spawned.id), null);
    assert.equal(settleSwitch(db, "passkey", tokens, T0), null, "once per switch");
  });

  it("remembers the last mode in the database, so a switch made while the daemon was down still counts", () => {
    const { db, tokens, external } = withAgents();
    settleSwitch(db, "off", tokens, T0);
    // A fresh store over the same database, as after a restart.
    const outcome = settleSwitch(db, "passkey", new DbTokenStore(db), T0);
    assert.deepEqual(outcome?.revoked, [external.id]);
  });

  it("records a switch back to off, or between modes, without revoking anything", () => {
    const { db, tokens, external } = withAgents();
    db.prepare("INSERT INTO meta (key, value) VALUES ('verification.seen_mode', 'passkey')").run();
    assert.deepEqual(settleSwitch(db, "oidc", tokens, T0), { from: "passkey", to: "oidc", revoked: [] });
    assert.deepEqual(settleSwitch(db, "off", tokens, T0), { from: "oidc", to: "off", revoked: [] });
    assert.notEqual(tokens.get(external.id), null);
  });
});
