/**
 * The verification gate (src/daemon/verification-gate.ts): default deny over
 * a named free list, who is never gated, the window and the fresh class, the
 * refusal's shape, the config's validation, and the token store's state.
 * Phase 2 of docs/passkeys.md: the gate is dormant (`verification off`), so
 * these drive it with the config a later phase will let the operator set.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createTestDb } from "./helpers.js";
import { DbTokenStore } from "../db/tokens.js";
import { hashToken } from "../daemon/token-ring.js";
import { CONFIG_DEFAULTS, configSetRefusal, describeCredentials } from "../commands/config.js";
import { DbCredentialStore } from "../db/credentials.js";
import {
  ACT_NAMES,
  APP_ANSWERS_REFUSALS,
  ACT_ROUTES,
  DEFAULT_FRESH_ACTS,
  DEFAULT_VERIFICATION_CONFIG,
  FREE_CONTROL_MESSAGES,
  FREE_ROUTES,
  FREE_TERMINAL_MESSAGES,
  FRESH_WINDOW_MS,
  MAX_WINDOW_MINUTES,
  consumption,
  REFUSAL_FRESH,
  REFUSAL_REQUIRED,
  VerificationGate,
  actRefusal,
  classifyRoute,
  configValueRefusal,
  readVerificationConfig,
  routeRefusal,
  verificationStatus,
  verifyFrame,
  type VerificationConfig,
} from "../daemon/verification-gate.js";

const T0 = Date.UTC(2026, 9, 16, 12);
const ON: VerificationConfig = { mode: "passkey", windowMs: 10 * 60_000, fresh: new Set(DEFAULT_FRESH_ACTS) };
const NEVER = { verifiedUntil: null, freshUntil: null };

/** One attested security key, as the ceremony would have stored it. */
function enrollOne(db: ReturnType<typeof createTestDb>): void {
  new DbCredentialStore(db).insert(
    {
      credentialId: Buffer.from("cred"),
      rpId: "mac.tail0000.ts.net",
      publicKey: Buffer.from("key"),
      alg: -7,
      transports: ["usb", "nfc"],
      aaguid: "6d44ba9b-f6ec-2e49-b930-0c8fe920cb73",
      signCount: 1,
      backupEligible: false,
      backedUp: false,
      attested: true,
      attestationFmt: "packed",
      attestationRoot: "CN=Yubico U2F Root CA Serial 457200631",
      label: "Security key from Safari on iPhone",
      enrolledBy: "attestation: CN=Yubico U2F Root CA Serial 457200631",
      enrolledVia: "tok-phone",
    },
    T0,
  );
}

describe("classifyRoute: default deny over a named free list", () => {
  it("frees every named read, the free upgrades, and verification's own routes", () => {
    for (const [method, path] of [
      ["GET", "/api/status"],
      ["GET", "/api/narratives/claude-abcd1234/tool_uses/k1"],
      ["GET", "/api/payloads/claude-abcd1234/nested/file.txt"],
      ["GET", "/api/tokens"],
      ["POST", "/api/search"],
      ["PATCH", "/api/folds/archive"],
      ["PATCH", "/api/narratives/claude-abcd1234/archive"],
      ["POST", "/api/verify/end"],
      ["POST", "/api/verify/begin"],
      ["POST", "/api/verify/challenge"],
      ["POST", "/api/verify/webauthn"],
      ["GET", "/api/credentials"],
      ["POST", "/api/credentials/challenge"],
      ["POST", "/api/credentials"],
      ["POST", "/api/presence/cancel"],
      ["GET", "/ws/control"],
      ["GET", "/ws/terminal/claude-abcd1234"],
    ]) {
      assert.deepEqual(classifyRoute(method, path), { kind: "free" }, `${method} ${path}`);
    }
  });

  it("names today's acts", () => {
    assert.deepEqual(classifyRoute("POST", "/api/narratives/claude-abcd1234/signal"), { kind: "act", act: "signal" });
    assert.deepEqual(classifyRoute("POST", "/api/spawn"), { kind: "act", act: "spawn" });
    assert.deepEqual(classifyRoute("POST", "/api/tokens"), { kind: "act", act: "mint" });
    assert.deepEqual(classifyRoute("POST", "/api/tokens/remote"), { kind: "act", act: "mint" });
    assert.deepEqual(classifyRoute("GET", "/ws/mcp"), { kind: "act", act: "mcp-dial" });
    assert.deepEqual(classifyRoute("POST", "/api/tokens/t1/revoke"), { kind: "act", act: "revoke" });
    assert.deepEqual(classifyRoute("POST", "/api/credentials/begin"), { kind: "act", act: "enroll" });
    assert.deepEqual(classifyRoute("POST", "/api/credentials/cred-1/revoke"), { kind: "act", act: "revoke-credential" });
  });

  it("treats anything unlisted as an unnamed act, never as free", () => {
    assert.deepEqual(classifyRoute("POST", "/api/something-new"), { kind: "act", act: null });
    assert.deepEqual(classifyRoute("GET", "/api/something-new"), { kind: "act", act: null });
    assert.deepEqual(classifyRoute("DELETE", "/api/status"), { kind: "act", act: null });
    assert.deepEqual(classifyRoute("GET", "/ws/elsewhere"), { kind: "act", act: null });
  });

  it("has no rule by method: a GET that acts is an act", () => {
    assert.equal(FREE_ROUTES.some((r) => r.endsWith(" /ws/mcp")), false);
    assert.deepEqual(classifyRoute("GET", "/ws/mcp"), { kind: "act", act: "mcp-dial" });
  });

  it("names only known acts, and the lists do not overlap", () => {
    for (const [, act] of ACT_ROUTES) assert.ok((ACT_NAMES as readonly string[]).includes(act), act);
    for (const [route] of ACT_ROUTES) assert.ok(!FREE_ROUTES.includes(route), `${route} on both lists`);
  });
});

describe("every route literal in server.ts is placed", () => {
  // A route added later must be put on one list or the other on purpose.
  // Reads the source, so it skips where the source is not shipped
  // (docs/doctor.md).
  const here = dirname(fileURLToPath(import.meta.url));
  const src = join(here, "..", "..", "src", "daemon", "server.ts");
  // The same `// Route: METHOD /path` and `// WS: /path` comments the
  // agent-scope test reads, so the method is compared too: the archive
  // routes are PATCH, and a free list that said POST would gate them.
  const normalize = (route: string) => route.replace(/:[a-z_]+/g, ":x").replace(/\*$/, ":x");
  it("names each one as free or as an act, method included", { skip: !existsSync(src) }, () => {
    const text = readFileSync(src, "utf8");
    const served = new Set<string>();
    for (const m of text.matchAll(/\/\/ (Route|WS): (?:([A-Z]+) )?(\/[^\s?]+)/g)) {
      served.add(normalize(`${m[2] ?? "GET"} ${m[3]}`));
    }
    assert.ok(served.size >= 40, `found only ${served.size} routes; the scan is broken`);
    const listed = new Set([...FREE_ROUTES, ...ACT_ROUTES.map(([r]) => r)].map(normalize));
    assert.deepEqual([...served].filter((r) => !listed.has(r)), [], "routes in server.ts on neither FREE_ROUTES nor ACT_ROUTES");
    assert.deepEqual([...listed].filter((r) => !served.has(r)), [], "stale entries");
  });
});

describe("actRefusal: who is gated, the window, the fresh class", () => {
  it("never gates an agent or this machine's shell", () => {
    assert.equal(actRefusal("agent", "spawn", ON, NEVER, T0), null);
    assert.equal(actRefusal("local", "mint", ON, NEVER, T0), null);
  });

  it("gates nothing while verification is off", () => {
    assert.equal(actRefusal("device", "terminal", DEFAULT_VERIFICATION_CONFIG, NEVER, T0), null);
    assert.equal(actRefusal("device", "mint", DEFAULT_VERIFICATION_CONFIG, NEVER, T0), null);
  });

  it("refuses an unverified device with 403 and verification: required, never 401", () => {
    const r = actRefusal("device", "signal", ON, NEVER, T0);
    assert.deepEqual(r, REFUSAL_REQUIRED);
    assert.equal(r?.status, 403);
    assert.equal(r?.body.verification, "required");
  });

  it("lets a verified device act until the window ends, exclusive", () => {
    const state = { verifiedUntil: T0 + 1000, freshUntil: null };
    assert.equal(actRefusal("device", "terminal", ON, state, T0), null);
    assert.equal(actRefusal("device", "terminal", ON, state, T0 + 999), null);
    assert.deepEqual(actRefusal("device", "terminal", ON, state, T0 + 1000), REFUSAL_REQUIRED);
  });

  it("holds a fresh-class act to the fresh window, not the verified one", () => {
    const verifiedNotFresh = { verifiedUntil: T0 + 9 * 60_000, freshUntil: T0 - 1 };
    assert.equal(actRefusal("device", "spawn", ON, verifiedNotFresh, T0), null);
    assert.deepEqual(actRefusal("device", "mint", ON, verifiedNotFresh, T0), REFUSAL_FRESH);
    assert.deepEqual(actRefusal("device", "mcp-dial", ON, verifiedNotFresh, T0), REFUSAL_FRESH);
    assert.deepEqual(actRefusal("device", "enroll", ON, verifiedNotFresh, T0), REFUSAL_FRESH);
    const fresh = { verifiedUntil: T0 + 9 * 60_000, freshUntil: T0 + 1 };
    assert.equal(actRefusal("device", "mint", ON, fresh, T0), null);
  });

  it("lets the operator put the terminal in the fresh class", () => {
    const tight = { ...ON, fresh: new Set([...DEFAULT_FRESH_ACTS, "terminal" as const]) };
    assert.deepEqual(actRefusal("device", "terminal", tight, { verifiedUntil: T0 + 60_000, freshUntil: T0 - 1 }, T0), REFUSAL_FRESH);
  });

  it("treats an unnamed act as an ordinary act", () => {
    assert.deepEqual(actRefusal("device", null, ON, NEVER, T0), REFUSAL_REQUIRED);
    assert.equal(actRefusal("device", null, ON, { verifiedUntil: T0 + 1, freshUntil: null }, T0), null);
  });

  it("routeRefusal frees the free list and gates the rest", () => {
    assert.equal(routeRefusal("device", "GET", "/api/status", ON, NEVER, T0), null);
    assert.deepEqual(routeRefusal("device", "POST", "/api/spawn", ON, NEVER, T0), REFUSAL_REQUIRED);
    assert.deepEqual(routeRefusal("device", "GET", "/ws/mcp", ON, { verifiedUntil: T0 + 1, freshUntil: null }, T0), REFUSAL_FRESH);
  });
});

describe("sockets", () => {
  it("frees subscriptions and the mirror's housekeeping, nothing that types or speaks", () => {
    assert.deepEqual([...FREE_CONTROL_MESSAGES].sort(), ["subscribe", "subscribe_activity", "unsubscribe", "unsubscribe_activity"]);
    assert.deepEqual([...FREE_TERMINAL_MESSAGES].sort(), ["refresh", "resize", "start", "stop"]);
    for (const act of ["keys", "paste", "mouse", "clear_history"]) assert.ok(!FREE_TERMINAL_MESSAGES.has(act), act);
    assert.ok(!FREE_CONTROL_MESSAGES.has("signal"));
  });

  it("answers a dropped message with a verify frame carrying the reason", () => {
    assert.deepEqual(verifyFrame(REFUSAL_REQUIRED), { type: "verify", verification: "required", error: REFUSAL_REQUIRED.body.error });
    assert.equal(verifyFrame(REFUSAL_FRESH).verification, "fresh");
  });
});

describe("config", () => {
  it("defaults to off, ten minutes, and the persistence acts fresh", () => {
    assert.equal(CONFIG_DEFAULTS.verification, "off");
    assert.equal(CONFIG_DEFAULTS["verification.window"], "10");
    const db = createTestDb();
    assert.deepEqual(readVerificationConfig(db), DEFAULT_VERIFICATION_CONFIG);
    assert.deepEqual(verificationStatus(readVerificationConfig(db)), { mode: "off", window_minutes: 10, fresh: [...DEFAULT_FRESH_ACTS] });
  });

  it("refuses to leave off while no credential is enrolled, so a switch can never lock every device out", () => {
    assert.match(configValueRefusal("verification", "passkey", { credentials: 0 }) ?? "", /No credential is enrolled/);
    assert.match(configValueRefusal("verification", "oidc", { credentials: 0 }) ?? "", /No credential is enrolled/);
    assert.equal(configValueRefusal("verification", "off", { credentials: 0 }), null);
    assert.equal(configValueRefusal("verification", "passkey", { credentials: 1, appAnswersRefusals: true }), null);
    assert.match(configValueRefusal("verification", "on", { credentials: 1 }) ?? "", /one of off, passkey, oidc/);
    // The CLI's check counts the credentials in the database it is given.
    const db = createTestDb();
    assert.match(configSetRefusal("verification", "passkey", db) ?? "", /No credential/);
    enrollOne(db);
    assert.equal(configSetRefusal("verification", "passkey", db), null);
    assert.equal(configSetRefusal("app_domain", "anything"), null);
  });

  it("lets the gate on once a credential exists, now that the app can answer a refusal", () => {
    assert.equal(APP_ANSWERS_REFUSALS, true);
    assert.equal(configValueRefusal("verification", "passkey", { credentials: 1 }), null);
    // An app that could not answer would strand every device.
    assert.match(configValueRefusal("verification", "passkey", { credentials: 1, appAnswersRefusals: false }) ?? "", /cannot answer a verification refusal/);
    assert.equal(configValueRefusal("verification", "off", { credentials: 1, appAnswersRefusals: false }), null);
  });

  it("lists every credential before the switch, with how and from where it was enrolled", () => {
    const db = createTestDb();
    enrollOne(db);
    const text = describeCredentials(db).join("\n");
    assert.match(text, /1 credential\(s\) will be able to verify/);
    assert.match(text, /Security key from Safari on iPhone {2}\[attested, aaguid 6d44ba9b/);
    assert.match(text, /by attestation: CN=Yubico U2F Root CA Serial 457200631, from token tok-phone/);
  });

  it("validates the window and the fresh list", () => {
    assert.equal(configValueRefusal("verification.window", "0", { credentials: 0 }), null);
    assert.equal(configValueRefusal("verification.window", "1440", { credentials: 0 }), null);
    assert.match(configValueRefusal("verification.window", "1441", { credentials: 0 }) ?? "", /whole minutes/);
    assert.match(configValueRefusal("verification.window", "ten", { credentials: 0 }) ?? "", /whole minutes/);
    assert.match(configValueRefusal("verification.window", "2.5", { credentials: 0 }) ?? "", /whole minutes/);
    assert.equal(configValueRefusal("verification.fresh", "mint, terminal", { credentials: 0 }), null);
    assert.equal(configValueRefusal("verification.fresh", "", { credentials: 0 }), null);
    assert.match(configValueRefusal("verification.fresh", "mint,typing", { credentials: 0 }) ?? "", /unknown: typing/);
  });

  it("reads what the CLI wrote", () => {
    const db = createTestDb();
    const set = (k: string, v: string) => db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`config.${k}`, v);
    set("verification", "passkey");
    set("verification.window", "0");
    set("verification.fresh", "terminal,mint");
    const warned: string[] = [];
    assert.deepEqual(readVerificationConfig(db, (m) => warned.push(m)), { mode: "passkey", windowMs: 0, fresh: new Set(["terminal", "mint"]) });
    assert.deepEqual(warned, []);
  });

  it("fails closed on a value it cannot read: an unknown mode gates, the window clamps, unknown acts are reported", () => {
    const db = createTestDb();
    const set = (k: string, v: string) => db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`config.${k}`, v);
    const warned: string[] = [];
    set("verification", "Passkey");
    set("verification.window", "99999");
    set("verification.fresh", "mint,typing");
    assert.deepEqual(readVerificationConfig(db, (m) => warned.push(m)), { mode: "passkey", windowMs: MAX_WINDOW_MINUTES * 60_000, fresh: new Set(["mint"]) });
    assert.equal(warned.length, 3);
    assert.match(warned[0], /"Passkey".*gating as passkey/);
    assert.match(warned[1], /clamped to 1440/);
    assert.match(warned[2], /typing/);
    set("verification", "   ");
    set("verification.window", "-3");
    assert.equal(readVerificationConfig(db).mode, "off", "blank is off, not unknown");
    assert.equal(readVerificationConfig(db).windowMs, 0, "a negative window clamps to zero, the tightest");
    set("verification.window", "ten");
    assert.equal(readVerificationConfig(db).windowMs, 10 * 60_000);
  });

  it("the gate says each config complaint once", () => {
    const db = createTestDb();
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('config.verification', 'later')").run();
    const lines: string[] = [];
    const gate = new VerificationGate(db, new DbTokenStore(db), () => T0, 0, (m) => lines.push(m));
    gate.config();
    gate.config();
    assert.equal(gate.config().mode, "passkey");
    assert.equal(lines.length, 1);
  });
});

describe("the store and the gate together", () => {
  function deviceAndGate(clock = { t: T0 }) {
    const db = createTestDb();
    const store = new DbTokenStore(db);
    const device = store.insert(hashToken("phone"), "device", "phone", T0, { used: true });
    const agent = store.insert(hashToken("agent"), "agent", "claude-abcd1234", T0, { used: true });
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('config.verification', 'passkey')").run();
    const gate = new VerificationGate(db, store, () => clock.t, 0);
    return { db, store, device, agent, gate, clock };
  }

  it("a device starts unverified, verifies for the window, is fresh for a minute, and can end early", () => {
    const { store, device, gate, clock } = deviceAndGate();
    assert.deepEqual(store.verification(device.id, T0), NEVER);
    assert.deepEqual(gate.refuseRoute(device, "POST", "/api/spawn"), REFUSAL_REQUIRED);
    assert.equal(gate.refuseRoute(device, "GET", "/api/narratives"), null);

    assert.equal(store.verify(device.id, { now: T0, windowMs: 10 * 60_000, freshMs: FRESH_WINDOW_MS, by: "cred-1", method: "webauthn" }), true);
    assert.equal(gate.refuseRoute(device, "POST", "/api/spawn"), null);
    assert.equal(gate.refuseAct(device, "terminal"), null);
    assert.equal(gate.refuseRoute(device, "POST", "/api/tokens"), null);

    clock.t = T0 + FRESH_WINDOW_MS;
    assert.deepEqual(gate.refuseRoute(device, "POST", "/api/tokens"), REFUSAL_FRESH);
    assert.equal(gate.refuseAct(device, "signal"), null);

    clock.t = T0 + 10 * 60_000;
    assert.deepEqual(gate.refuseAct(device, "signal"), REFUSAL_REQUIRED);

    clock.t = T0 + 1000;
    assert.equal(gate.refuseAct(device, "terminal"), null);
    assert.equal(store.endVerification(device.id), true);
    assert.deepEqual(gate.refuseAct(device, "terminal"), REFUSAL_REQUIRED);
    assert.deepEqual(store.verification(device.id, clock.t), NEVER);
  });

  it("keeps who proved it for the record after the window ends, and says nothing while off or for an agent", () => {
    const { db, store, device, agent, gate, clock } = deviceAndGate();
    assert.equal(gate.proof(device), null, "never verified");
    assert.equal(store.lastProof(device.id), null);
    store.verify(device.id, { now: T0, windowMs: 10 * 60_000, freshMs: FRESH_WINDOW_MS, by: "cred-1", method: "webauthn:attested" });
    const proof = { by: "cred-1", method: "webauthn:attested", at: T0 };
    assert.deepEqual(gate.proof(device), proof);
    assert.equal(gate.proof(agent), null, "an agent is never gated, so never proved");

    // A fresh-class act spends the freshness, a window of zero the window;
    // the record of who gave the proof survives both, and an early end.
    assert.equal(gate.refuseRoute(device, "POST", "/api/tokens"), null);
    assert.deepEqual(gate.proof(device), proof);
    clock.t = T0 + 10 * 60_000;
    assert.deepEqual(gate.proof(device), proof, "after the window");
    store.endVerification(device.id);
    assert.deepEqual(gate.proof(device), proof, "after an early end");

    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('config.verification', 'off')").run();
    assert.equal(gate.proof(device), null, "with the gate off nothing was proved, whatever the row says");

    store.revoke([device.id], clock.t);
    assert.equal(store.lastProof(device.id), null, "a revoked row is no device");
  });

  it("never gates an agent token, and verify() refuses to mark one", () => {
    const { store, agent, gate } = deviceAndGate();
    assert.equal(gate.refuseRoute(agent, "POST", "/api/spawn"), null);
    assert.equal(gate.refuseAct(agent, "signal"), null);
    assert.equal(store.verify(agent.id, { now: T0, windowMs: 1000, freshMs: 1000, by: "x", method: "webauthn" }), false);
  });

  it("a revoked device is never verified, whatever its row says", () => {
    const { store, device, gate } = deviceAndGate();
    store.verify(device.id, { now: T0, windowMs: 10 * 60_000, freshMs: FRESH_WINDOW_MS, by: "cred-1", method: "webauthn" });
    store.revoke([device.id], T0);
    assert.deepEqual(store.verification(device.id, T0), NEVER);
    assert.deepEqual(gate.refuseAct(device, "terminal"), REFUSAL_REQUIRED);
  });

  it("a fresh-class act spends the proof's freshness: one proof, one mint", () => {
    const { store, device, gate } = deviceAndGate();
    const prove = () => store.verify(device.id, { now: T0, windowMs: 10 * 60_000, freshMs: FRESH_WINDOW_MS, by: "cred-1", method: "webauthn" });
    prove();
    assert.equal(gate.refuseRoute(device, "POST", "/api/tokens"), null);
    assert.deepEqual(gate.refuseRoute(device, "POST", "/api/tokens"), REFUSAL_FRESH, "the second mint needs a second proof");
    assert.deepEqual(gate.refuseRoute(device, "GET", "/ws/mcp"), REFUSAL_FRESH);
    assert.equal(gate.refuseRoute(device, "POST", "/api/spawn"), null, "an ordinary act spends nothing");
    assert.equal(gate.refuseAct(device, "terminal"), null);
    assert.equal(gate.refuseRoute(device, "POST", "/api/spawn"), null);
    prove();
    assert.equal(gate.refuseRoute(device, "GET", "/ws/mcp"), null);
    assert.deepEqual(consumption("mint", ON), "fresh");
    assert.equal(consumption("spawn", ON), null);
    assert.equal(consumption(null, ON), null);
  });

  it("a window of zero means every act prompts: the proof buys one act", () => {
    const { db, store, device, gate } = deviceAndGate();
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('config.verification.window', '0')").run();
    assert.equal(gate.config().windowMs, 0);
    assert.deepEqual(consumption("spawn", gate.config()), "all");
    store.verify(device.id, { now: T0, windowMs: 0, freshMs: FRESH_WINDOW_MS, by: "cred-1", method: "webauthn" });
    assert.deepEqual(store.verification(device.id, T0), { verifiedUntil: T0 + FRESH_WINDOW_MS, freshUntil: T0 + FRESH_WINDOW_MS });
    assert.equal(gate.refuseRoute(device, "GET", "/api/narratives"), null, "a read spends nothing");
    assert.equal(gate.refuseAct(device, "terminal"), null);
    assert.deepEqual(gate.refuseAct(device, "terminal"), REFUSAL_REQUIRED, "the next act needs the next proof");
    assert.deepEqual(store.verification(device.id, T0), NEVER);
    store.verify(device.id, { now: T0, windowMs: 0, freshMs: FRESH_WINDOW_MS, by: "cred-1", method: "webauthn" });
    assert.equal(gate.refuseRoute(device, "POST", "/api/tokens"), null);
    assert.deepEqual(gate.refuseRoute(device, "POST", "/api/spawn"), REFUSAL_REQUIRED);
  });

  it("spends the proof in the check itself, so two acts racing for one proof cannot both pass", () => {
    const { db, store, device, gate } = deviceAndGate();
    store.verify(device.id, { now: T0, windowMs: 10 * 60_000, freshMs: FRESH_WINDOW_MS, by: "cred-1", method: "webauthn" });
    // The store's one conditional write is the pass condition.
    assert.equal(store.spend(device.id, "fresh", T0), true);
    assert.equal(store.spend(device.id, "fresh", T0), false);
    store.verify(device.id, { now: T0, windowMs: 10 * 60_000, freshMs: FRESH_WINDOW_MS, by: "cred-1", method: "webauthn" });
    assert.equal(store.spend(device.id, "fresh", T0 + FRESH_WINDOW_MS), false, "a stale proof is not spent");
    assert.deepEqual(store.verification(device.id, T0), { verifiedUntil: T0 + 10 * 60_000, freshUntil: T0 + FRESH_WINDOW_MS });
    // Back to back through the gate: only the first mint passes.
    const results = [gate.refuseAct(device, "mint"), gate.refuseAct(device, "mint")];
    assert.deepEqual(results, [null, REFUSAL_FRESH]);
    // And under a window of zero, the whole proof, on its own column.
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('config.verification.window', '0')").run();
    store.verify(device.id, { now: T0, windowMs: 0, freshMs: FRESH_WINDOW_MS, by: "cred-1", method: "webauthn" });
    assert.deepEqual([gate.refuseAct(device, "terminal"), gate.refuseAct(device, "terminal")], [null, REFUSAL_REQUIRED]);
    assert.equal(store.spend(device.id, "all", T0), false);
  });

  it("a refused act spends nothing", () => {
    const { store, device, gate, clock } = deviceAndGate();
    store.verify(device.id, { now: T0, windowMs: 10 * 60_000, freshMs: FRESH_WINDOW_MS, by: "cred-1", method: "webauthn" });
    clock.t = T0 + FRESH_WINDOW_MS;
    assert.deepEqual(gate.refuseRoute(device, "POST", "/api/tokens"), REFUSAL_FRESH);
    assert.deepEqual(store.verification(device.id, clock.t), { verifiedUntil: T0 + 10 * 60_000, freshUntil: T0 + FRESH_WINDOW_MS });
  });

  it("is dormant while verification is off", () => {
    const { db, device, gate } = deviceAndGate();
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('config.verification', 'off')").run();
    assert.equal(gate.refuseRoute(device, "POST", "/api/spawn"), null);
    assert.equal(gate.refuseAct(device, "terminal"), null);
  });
});
