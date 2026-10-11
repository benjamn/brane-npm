import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { execFileSync } from "node:child_process";

import { inspectCert, parseCertExpiry } from "../tls.js";
import { CertManager } from "../daemon/cert-manager.js";

// We generate certs live (rather than checking in fixtures) so the tests
// are time-machine-resistant: a cert valid for "60 days from now" is always
// what it says. node:crypto can't issue X.509, so we shell out to openssl.

interface GenOpts {
  host: string;
  /** notAfter expressed as ms from now (positive = future, negative = past). */
  notAfterOffsetMs: number;
  /** Optional explicit notBefore (defaults to now). Use to force an expired cert. */
  notBefore?: Date;
}

function opensslAvailable(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if the local openssl supports `-not_before`/`-not_after` on
 * `openssl req`. macOS LibreSSL and OpenSSL 3.x do; older OpenSSL 1.x does
 * not. Tests that need explicit date control skip when this is false.
 */
function opensslSupportsExplicitDates(): boolean {
  if (!HAS_OPENSSL) return false;
  try {
    const dir = mkdtempSync(join(tmpdir(), "brane-openssl-probe-"));
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", join(dir, "k"), "-out", join(dir, "c"),
      "-subj", "/CN=probe",
      "-not_before", "20200101000000Z",
      "-not_after", "20200102000000Z",
    ], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function formatAsn1Time(d: Date): string {
  // openssl wants YYYYMMDDHHMMSSZ (UTC).
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    String(d.getUTCFullYear()) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) + "Z"
  );
}

function generateSelfSignedCert(opts: GenOpts): { cert: Buffer; key: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), "brane-cert-gen-"));
  const keyPath = join(dir, "k.pem");
  const certPath = join(dir, "c.pem");
  const args = [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath,
    "-subj", `/CN=${opts.host}`,
  ];
  if (opts.notBefore) {
    // Explicit notBefore/notAfter (used for expired-cert tests). Requires
    // an openssl that supports the flags; callers gate on this.
    const notBefore = opts.notBefore;
    const notAfter = new Date(notBefore.getTime() + opts.notAfterOffsetMs);
    args.push("-not_before", formatAsn1Time(notBefore));
    args.push("-not_after", formatAsn1Time(notAfter));
  } else {
    // Days-based path — what most tests use. Round up to >= 1 day.
    const days = Math.max(1, Math.ceil(opts.notAfterOffsetMs / 86_400_000));
    args.push("-days", String(days));
  }
  try {
    execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    const e = err as { stderr?: Buffer | string; status?: number };
    const stderr = e.stderr?.toString() ?? "";
    throw new Error(
      `openssl req failed (exit ${e.status ?? "?"}): ${stderr.trim() || "(no stderr)"}\n` +
      `args: ${args.join(" ")}`,
    );
  }
  const cert = readFileSync(certPath);
  const key = readFileSync(keyPath);
  if (cert.length === 0) {
    throw new Error(`openssl produced an empty cert file at ${certPath}`);
  }
  return { cert, key };
}

function setupCertDir(initial?: { cert: Buffer; key: Buffer }): {
  certPath: string; keyPath: string; dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "brane-certmgr-"));
  const certsDir = join(dir, "certs");
  mkdirSync(certsDir, { recursive: true });
  const certPath = join(certsDir, "tls.crt");
  const keyPath = join(certsDir, "tls.key");
  if (initial) {
    writeFileSync(certPath, initial.cert);
    writeFileSync(keyPath, initial.key);
  }
  return { certPath, keyPath, dir };
}

const HAS_OPENSSL = opensslAvailable();
const HAS_OPENSSL_DATES = HAS_OPENSSL && opensslSupportsExplicitDates();

describe("parseCertExpiry / inspectCert", () => {
  it("returns null for a missing file", () => {
    assert.equal(parseCertExpiry("/tmp/definitely-not-a-cert-file-xyz"), null);
    assert.equal(inspectCert("/tmp/definitely-not-a-cert-file-xyz"), null);
  });

  it("returns null for a non-PEM file", () => {
    const dir = mkdtempSync(join(tmpdir(), "brane-bad-cert-"));
    const path = join(dir, "garbage.crt");
    writeFileSync(path, "this is not a certificate\n");
    assert.equal(parseCertExpiry(path), null);
    assert.equal(inspectCert(path), null);
  });

  it("parses a real cert's expiry and subject", { skip: !HAS_OPENSSL }, () => {
    const { cert } = generateSelfSignedCert({ host: "test.example.com", notAfterOffsetMs: 30 * 86_400_000 });
    const dir = mkdtempSync(join(tmpdir(), "brane-good-cert-"));
    const path = join(dir, "ok.crt");
    writeFileSync(path, cert);

    const inspected = inspectCert(path);
    assert.ok(inspected, "expected cert to inspect");
    assert.ok(inspected.notAfter.getTime() > Date.now(), "expected notAfter in the future");
    assert.match(inspected.subject, /CN=test\.example\.com/);
  });
});

describe("CertManager.ensureCert", () => {
  it("reports disabled when there is no cert and no Tailscale", { skip: !HAS_OPENSSL }, async () => {
    const { certPath, keyPath } = setupCertDir();
    const mgr = new CertManager({
      certPath, keyPath,
      onReload: () => {},
      resolveHost: () => undefined,
    });
    const ok = await mgr.ensureCert();
    assert.equal(ok, false);
    assert.equal(mgr.getStatus().state, "disabled");
    assert.equal(mgr.getStatus().expiresAt, null);
    mgr.stop();
  });

  it("treats a valid existing cert as the steady state without invoking tailscale",
    { skip: !HAS_OPENSSL }, async () => {
      const fixture = generateSelfSignedCert({ host: "host.example.com", notAfterOffsetMs: 60 * 86_400_000 });
      const { certPath, keyPath } = setupCertDir(fixture);
      let reloadFired = false;
      const mgr = new CertManager({
        certPath, keyPath,
        onReload: () => { reloadFired = true; },
        resolveHost: () => "host.example.com",
      });
      const ok = await mgr.ensureCert();
      assert.equal(ok, true);
      assert.equal(mgr.getStatus().state, "valid");
      const status = mgr.getStatus();
      assert.ok(status.expiresAt && status.expiresAt.getTime() > Date.now());
      // ensureCert must not reload — the file on disk is already what HTTPS
      // would bind with.
      assert.equal(reloadFired, false);
      mgr.stop();
    });

  it("returns false when the cert is genuinely expired and Tailscale is gone",
    { skip: !HAS_OPENSSL_DATES }, async () => {
      // Genuinely expired: notBefore six years ago, notAfter five years ago.
      // Asserts that an expired-cert-on-disk + no-Tailscale path lands in
      // "disabled" rather than mistakenly reporting "valid".
      const sixYearsAgo = new Date(Date.now() - 6 * 365 * 86_400_000);
      const fixture = generateSelfSignedCert({
        host: "h.example.com",
        notBefore: sixYearsAgo,
        notAfterOffsetMs: 365 * 86_400_000, // one year after notBefore -> still expired
      });
      const { certPath, keyPath } = setupCertDir(fixture);

      const mgr = new CertManager({
        certPath, keyPath,
        onReload: () => {},
        resolveHost: () => undefined, // no tailscale
      });
      const ok = await mgr.ensureCert();
      assert.equal(ok, false);
      assert.equal(mgr.getStatus().state, "disabled");
      // expiresAt reflects the on-disk cert (caller may want to log it).
      const expiry = mgr.getStatus().expiresAt;
      assert.ok(expiry && expiry.getTime() < Date.now());
      mgr.stop();
    });

  it("falls through to provisioning when the existing cert's CN doesn't match the Tailscale host",
    { skip: !HAS_OPENSSL }, async () => {
      // Regression for the review item: a valid-but-wrong-subject cert
      // would be accepted as "valid" by ensureCert and the daemon would
      // bind HTTPS with the wrong cert. We can't actually shell out to
      // tailscale in a test, so instead we assert ensureCert detects the
      // mismatch and tries to provision (failing because tailscale isn't
      // really there) rather than reporting "valid".
      const fixture = generateSelfSignedCert({
        host: "old.example.com",
        notAfterOffsetMs: 60 * 86_400_000,
      });
      const { certPath, keyPath } = setupCertDir(fixture);

      let provisionAttempted = false;
      const mgr = new CertManager({
        certPath, keyPath,
        onReload: () => {},
        // Host has changed since the cert was issued.
        resolveHost: () => "new.example.com",
        // Quiet the "Provisioning..." log line during the test; also
        // gives us a way to detect that we actually entered Case C.
        log: (_level, msg) => {
          if (msg.includes("does not match")) provisionAttempted = true;
        },
      });
      const ok = await mgr.ensureCert();
      assert.equal(ok, false, "expected provisioning to fail (tailscale stub)");
      assert.equal(provisionAttempted, true, "expected the subject-mismatch log line");
      assert.notEqual(mgr.getStatus().state, "valid");
      mgr.stop();
    });
});

describe("CertManager.fs.watch hot reload", () => {
  it("calls onReload when the cert file changes underneath us",
    { skip: !HAS_OPENSSL }, async () => {
      const initial = generateSelfSignedCert({ host: "h.example.com", notAfterOffsetMs: 60 * 86_400_000 });
      const { certPath, keyPath } = setupCertDir(initial);
      let reloadCount = 0;
      const reloadedCerts: Buffer[] = [];

      const mgr = new CertManager({
        certPath, keyPath,
        onReload: (cert) => { reloadCount++; reloadedCerts.push(cert); },
        resolveHost: () => "h.example.com",
      });
      await mgr.ensureCert();
      mgr.start();
      // Give the watcher a tick to attach.
      await sleep(50);

      // Write a different cert: should trigger reload after debounce.
      const replacement = generateSelfSignedCert({ host: "h.example.com", notAfterOffsetMs: 90 * 86_400_000 });
      writeFileSync(certPath, replacement.cert);
      writeFileSync(keyPath, replacement.key);

      // Wait past the 200ms debounce.
      await sleep(400);

      assert.ok(reloadCount >= 1, `expected at least one reload, got ${reloadCount}`);
      // The reloaded cert bytes must match what we wrote (not the original).
      assert.ok(reloadedCerts[reloadedCerts.length - 1].equals(replacement.cert));
      mgr.stop();
    });

  it("does not call onReload when written bytes have the same notAfter",
    { skip: !HAS_OPENSSL }, async () => {
      const fixture = generateSelfSignedCert({ host: "h.example.com", notAfterOffsetMs: 60 * 86_400_000 });
      const { certPath, keyPath } = setupCertDir(fixture);
      let reloadCount = 0;
      const mgr = new CertManager({
        certPath, keyPath,
        onReload: () => { reloadCount++; },
        resolveHost: () => "h.example.com",
      });
      await mgr.ensureCert();
      mgr.start();
      await sleep(50);

      // Touch the file with the same bytes — fs.watch fires, but the
      // notAfter hasn't changed, so we should suppress the reload.
      writeFileSync(certPath, fixture.cert);
      await sleep(400);

      assert.equal(reloadCount, 0);
      mgr.stop();
    });
});
