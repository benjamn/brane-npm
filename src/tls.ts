// TLS certificate management for the brane daemon.
//
// The daemon serves over HTTPS using Tailscale-issued Let's Encrypt certs.
// `provisionTlsCert` shells out to `tailscale cert` (the same command the
// `brane certify` CLI uses) and lands a fresh cert/key pair on disk.
// `parseCertExpiry` reads a cert file and returns its `notAfter` so the
// CertManager can decide when to renew.
//
// Both functions are pure plumbing — no schedule, no state, no logging.
// The renewal/scheduling/hot-reload policy lives in src/daemon/cert-manager.ts.

import { execFile, type ExecFileException } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";

export type ProvisionFailureReason =
  // `tailscale` binary not on PATH (or not executable).
  | "tailscale_missing"
  // Tailscale responded but HTTPS / MagicDNS is not enabled for the tailnet.
  // This is the one case that requires operator action in the admin console.
  | "https_not_enabled"
  // `tailscale cert` returned a hostname error — usually the supplied host
  // isn't the machine's tailnet DNS name.
  | "bad_host"
  // The subprocess hit our timeout. Network slowness or Tailscale hang.
  | "timeout"
  // The cert/key file we got back didn't parse, or its subject didn't match.
  // Means `tailscale cert` succeeded but produced something unusable.
  | "invalid_output"
  // Anything we couldn't classify. Inspect `stderr`/`message` for context.
  | "unknown";

export type ProvisionResult =
  | { ok: true; certPath: string; keyPath: string; notAfter: Date }
  | { ok: false; reason: ProvisionFailureReason; message: string; stderr?: string };

export interface ProvisionOptions {
  /** Tailscale DNS name to certify (e.g. "host.tailnet.ts.net"). */
  host: string;
  /** Final destination for the cert. Overwrites any existing file atomically. */
  certPath: string;
  /** Final destination for the key. Overwrites any existing file atomically. */
  keyPath: string;
  /** Subprocess timeout in ms (default 30000 — matches the existing CLI). */
  timeoutMs?: number;
}

/**
 * Provision a TLS cert+key pair for `host` via `tailscale cert`.
 *
 * Writes to temporary `.new` files, validates the result (parses, future
 * `notAfter`, subject CN matches `host`), then atomically renames them into
 * place. Partial failures leave the existing cert intact.
 */
export function provisionTlsCert(opts: ProvisionOptions): Promise<ProvisionResult> {
  const { host, certPath, keyPath, timeoutMs = 30000 } = opts;
  const tmpCert = certPath + ".new";
  const tmpKey = keyPath + ".new";

  return new Promise((resolve) => {
    execFile(
      "tailscale",
      ["cert", "--cert-file", tmpCert, "--key-file", tmpKey, host],
      { timeout: timeoutMs },
      (err, _stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            reason: classifyTailscaleError(err, stderr),
            message: (err as Error).message,
            stderr,
          });
          return;
        }

        // tailscale cert exited 0 — validate before swapping in.
        let parsed: X509Certificate;
        try {
          parsed = new X509Certificate(readFileSync(tmpCert));
        } catch (parseErr) {
          resolve({
            ok: false,
            reason: "invalid_output",
            message: `Provisioned cert at ${tmpCert} did not parse: ${(parseErr as Error).message}`,
          });
          return;
        }

        const notAfter = parseValidTo(parsed.validTo);
        if (!notAfter || notAfter.getTime() <= Date.now()) {
          resolve({
            ok: false,
            reason: "invalid_output",
            message: `Provisioned cert has invalid or past notAfter: ${parsed.validTo}`,
          });
          return;
        }

        // Subject should match the requested host. tailscale puts the host
        // in the CN; we accept any cert whose subject CN equals host, which
        // is what tailscale always produces.
        if (!subjectMatchesHost(parsed, host)) {
          resolve({
            ok: false,
            reason: "invalid_output",
            message: `Provisioned cert subject ${parsed.subject} does not match host ${host}`,
          });
          return;
        }

        try {
          renameSync(tmpCert, certPath);
          renameSync(tmpKey, keyPath);
        } catch (renameErr) {
          resolve({
            ok: false,
            reason: "unknown",
            message: `Failed to install provisioned cert: ${(renameErr as Error).message}`,
          });
          return;
        }

        resolve({ ok: true, certPath, keyPath, notAfter });
      },
    );
  });
}

/** Read a cert file and return its X.509 `notAfter` date. */
export function parseCertExpiry(certPath: string): Date | null {
  try {
    const cert = new X509Certificate(readFileSync(certPath));
    return parseValidTo(cert.validTo);
  } catch {
    return null;
  }
}

/** Read a cert file and return both expiry and subject in one shot. */
export function inspectCert(certPath: string): { notAfter: Date; subject: string } | null {
  try {
    const cert = new X509Certificate(readFileSync(certPath));
    const notAfter = parseValidTo(cert.validTo);
    if (!notAfter) return null;
    return { notAfter, subject: cert.subject };
  } catch {
    return null;
  }
}

/**
 * Parse the X509Certificate#validTo string into a Date.
 *
 * Node added `X509Certificate#validToDate` in v23.0.0; on Node 20 (our LTS
 * baseline) only the string form is available. The string is OpenSSL's
 * ASN1_TIME format, e.g. "Jun 21 14:41:05 2026 GMT" — a format `new Date()`
 * parses reliably across V8 versions on every platform we ship to.
 */
function parseValidTo(validTo: string): Date | null {
  if (!validTo) return null;
  const d = new Date(validTo);
  return Number.isNaN(d.getTime()) ? null : d;
}

function classifyTailscaleError(err: ExecFileException, stderr: string): ProvisionFailureReason {
  if (err.code === "ENOENT") return "tailscale_missing";
  if (err.signal === "SIGTERM" || err.killed) return "timeout";

  const haystack = (stderr ?? "").toLowerCase();
  // Tailscale messaging is stable enough to pattern-match. Examples we've
  // seen in the wild:
  //   "HTTPS must be enabled..." (admin console toggle off)
  //   "HTTPS is not enabled for this tailnet"
  //   "no such host" / "is not in your tailnet" (wrong host)
  if (haystack.includes("https") && (haystack.includes("not enabled") || haystack.includes("must be enabled"))) {
    return "https_not_enabled";
  }
  if (haystack.includes("no such host") || haystack.includes("not in your tailnet")) {
    return "bad_host";
  }
  return "unknown";
}

function subjectMatchesHost(cert: X509Certificate, host: string): boolean {
  // X509Certificate.subject is multi-line "CN=foo\nO=bar". Pull the CN.
  const cnLine = cert.subject.split(/\r?\n/).find((l) => l.startsWith("CN="));
  if (!cnLine) return false;
  return cnLine.slice(3).trim().toLowerCase() === host.toLowerCase();
}

