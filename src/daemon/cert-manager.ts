// CertManager — keeps the daemon's TLS cert alive without operator action.
//
// The big picture: if Tailscale is running, the daemon should always be
// serving on HTTPS with a valid cert. The operator should never have to run
// `brane certify` to keep things working. This module owns that promise.
//
// Responsibilities:
//   - On startup, ensure a valid cert exists at the canonical path,
//     provisioning one if needed (first-run or expired).
//   - Periodically re-check the cert and renew when it enters the renewal
//     window (last ~30 days of a 90-day Let's Encrypt issuance).
//   - Watch the cert file for external changes (e.g. operator ran
//     `brane certify` by hand) and hot-reload without restart.
//   - Surface state so the daemon can expose it on /api/status, broadcast
//     it to the web UI, and print it in `brane daemon status`.
//
// What this module deliberately does NOT do:
//   - Bind HTTPS servers (that stays in daemon/server.ts).
//   - Broadcast over WebSockets directly (caller registers a state-change
//     callback that does the broadcasting).
//   - Persist state (transient, rederivable from the cert file on disk).

import { readFileSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import {
  provisionTlsCert,
  inspectCert,
  type ProvisionFailureReason,
} from "../tls.js";
import { getTailscaleHost } from "../tailscale.js";

/** Renew when fewer than this many days remain on the cert. */
const RENEW_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

/** Periodic check cadence. Renewal itself is gated by the threshold. */
const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** Backoff schedule after a renewal failure. Capped at the last entry. */
const BACKOFF_SCHEDULE_MS = [
  1 * 60 * 60 * 1000, //  1h
  2 * 60 * 60 * 1000, //  2h
  4 * 60 * 60 * 1000, //  4h
  8 * 60 * 60 * 1000, //  8h
  24 * 60 * 60 * 1000, // 24h
];

/** fs.watch debounce: coalesce the multiple events a single rename emits. */
const WATCH_DEBOUNCE_MS = 200;

export type CertState =
  // No Tailscale on this host — we're not even trying. HTTP-only is fine.
  | "disabled"
  // Cert is on disk, valid, and outside the renewal window. Steady state.
  | "valid"
  // Renewal subprocess in flight.
  | "renewing"
  // The most recent renewal attempt failed; backoff is scheduled.
  // The cert may still be valid (renewal was preemptive) — check expiresAt.
  | "failed";

export interface CertStatus {
  state: CertState;
  /** When the current cert expires (null if no cert is loaded). */
  expiresAt: Date | null;
  /** Reason code from the last failed renewal, if any. */
  lastErrorReason: ProvisionFailureReason | null;
  /** Human-readable message from the last failed renewal, if any. */
  lastErrorMessage: string | null;
  /** When the next renewal attempt is scheduled (null if none). */
  nextAttemptAt: Date | null;
  /** Tailscale host the cert is for. */
  host: string | null;
}

export interface CertManagerOptions {
  certPath: string;
  keyPath: string;
  /**
   * Called when the cert file on disk has been replaced (by us or by the
   * operator). The bound HTTPS servers should call `setSecureContext` here.
   * Receives the freshly-read cert and key bytes.
   */
  onReload: (cert: Buffer, key: Buffer) => void;
  /** Called whenever the public status object changes. */
  onStateChange?: (status: CertStatus) => void;
  /** Called for noteworthy events (renew success/failure) the daemon should log. */
  log?: (level: "info" | "warn" | "error", msg: string) => void;
  /** Override Tailscale host detection (mostly for tests). */
  resolveHost?: () => string | undefined;
  /** Override poll cadence (mostly for tests). */
  pollIntervalMs?: number;
}

/**
 * Owns the daemon's TLS cert lifecycle. The daemon creates one instance,
 * calls `ensureCert()` before deciding whether to bind HTTPS, registers
 * `setSecureContext` via `onReload`, and calls `start()` once the servers
 * are listening to begin the renewal/watch loop. `stop()` on shutdown.
 */
export class CertManager {
  private readonly opts: Required<Omit<CertManagerOptions, "onStateChange" | "log" | "resolveHost">> & {
    onStateChange?: (status: CertStatus) => void;
    log: (level: "info" | "warn" | "error", msg: string) => void;
    resolveHost: () => string | undefined;
  };
  // ^ archiveDir was removed: brane has no use for prior cert pairs (no
  // pinning clients, no offline trust state), and unbounded archival would
  // grow ~4 entries/year forever.

  private status: CertStatus = {
    state: "disabled",
    expiresAt: null,
    lastErrorReason: null,
    lastErrorMessage: null,
    nextAttemptAt: null,
    host: null,
  };

  private pollTimer: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private watchDebounce: NodeJS.Timeout | null = null;
  private renewInflight: Promise<void> | null = null;
  private consecutiveFailures = 0;
  private stopped = false;

  constructor(opts: CertManagerOptions) {
    this.opts = {
      certPath: opts.certPath,
      keyPath: opts.keyPath,
      onReload: opts.onReload,
      onStateChange: opts.onStateChange,
      log: opts.log ?? (() => {}),
      resolveHost: opts.resolveHost ?? getTailscaleHost,
      pollIntervalMs: opts.pollIntervalMs ?? POLL_INTERVAL_MS,
    };
  }

  /**
   * Synchronously look at what's on disk and (if needed/possible) provision
   * a cert before the daemon binds. Returns true iff the daemon has a valid
   * cert it can use to bind HTTPS. Safe to call from daemon startup — does
   * not start the renewal loop (call `start()` after binding for that).
   */
  async ensureCert(): Promise<boolean> {
    const host = this.opts.resolveHost();
    this.status.host = host ?? null;

    const existing = inspectCert(this.opts.certPath);
    const now = Date.now();
    // Mirror tick()'s check: a cert whose CN doesn't match the current
    // Tailscale host is unusable for HTTPS even if the dates are fine
    // (tailnet rename, node rename). Without this, ensureCert would say
    // "valid", startServer would bind HTTPS, and every client would see a
    // TLS error until the hourly tick noticed and re-provisioned.
    const subjectMismatch =
      existing && host && !subjectIs(existing.subject, host);

    // Case A: valid cert exists for the right host. Use it; renewal loop
    // will handle expiry later.
    if (existing && existing.notAfter.getTime() > now && !subjectMismatch) {
      this.status.expiresAt = existing.notAfter;
      this.status.state = "valid";
      this.emitStateChange();
      return true;
    }

    // Case B: cert is missing/expired/wrong-subject and no Tailscale.
    // Nothing we can do — daemon will serve HTTP only.
    if (!host) {
      this.status.state = "disabled";
      this.status.expiresAt = existing?.notAfter ?? null;
      this.emitStateChange();
      return false;
    }

    // Case C: cert is missing/expired/wrong-subject and Tailscale is
    // available. Try to provision a fresh one.
    this.opts.log(
      "info",
      subjectMismatch && existing
        ? `TLS cert subject ${existing.subject} does not match ${host} — provisioning fresh cert`
        : existing
          ? `TLS cert expired ${existing.notAfter.toISOString()} — provisioning fresh cert for ${host}`
          : `No TLS cert found — provisioning for ${host}`,
    );
    const ok = await this.tryProvision(host);
    return ok;
  }

  /**
   * Begin the renewal poll + fs.watch loop. Idempotent.
   *
   * The expected ordering at daemon startup is:
   *   1. await mgr.ensureCert()      (provision if missing)
   *   2. bind HTTPS server with the cert
   *   3. mgr.start()                 (renewal + watch)
   *   4. mgr.stop() during shutdown
   */
  start(): void {
    if (this.pollTimer || this.stopped) return;

    this.pollTimer = setInterval(() => {
      void this.tick();
    }, this.opts.pollIntervalMs);
    // Don't keep the event loop alive on the renewal timer alone.
    this.pollTimer.unref?.();

    this.attachWatcher();
  }

  /** Shut down the renewal loop and fs.watch. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
      this.watchDebounce = null;
    }
    if (this.watcher) {
      try { this.watcher.close(); } catch {}
      this.watcher = null;
    }
  }

  /** Current public status. Caller may serialize this to JSON. */
  getStatus(): CertStatus {
    return { ...this.status };
  }

  /**
   * Force a renewal check now (skips backoff). Returns true if a renewal
   * was attempted and succeeded. Useful for testing and for an eventual
   * `brane certify` that just nudges the daemon instead of running the
   * provisioning itself.
   */
  async renewNow(): Promise<boolean> {
    const host = this.opts.resolveHost();
    if (!host) return false;
    return this.tryProvision(host);
  }

  // ----- internals -----

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.renewInflight) return;

    const host = this.opts.resolveHost();
    if (!host) {
      // Tailscale went away mid-life. Don't fail loudly — the daemon may
      // still be useful over HTTP. Update host but keep current state.
      if (this.status.host !== null) {
        this.status.host = null;
        this.emitStateChange();
      }
      return;
    }
    if (this.status.host !== host) {
      // Host changed (tailnet rename, etc.) — force a renewal.
      this.status.host = host;
      this.opts.log("info", `Tailscale host changed to ${host} — renewing cert`);
      await this.tryProvision(host);
      return;
    }

    // Respect backoff: if a previous attempt failed and the cooldown
    // hasn't passed, do nothing this tick.
    if (this.status.nextAttemptAt && this.status.nextAttemptAt.getTime() > Date.now()) {
      return;
    }

    const current = inspectCert(this.opts.certPath);
    const now = Date.now();
    const expiresAt = current?.notAfter ?? null;

    const expiresSoon =
      !current || current.notAfter.getTime() - now < RENEW_THRESHOLD_MS;
    const subjectMismatch =
      current && this.status.host && !subjectIs(current.subject, this.status.host);

    if (!expiresSoon && !subjectMismatch) {
      // Steady state — nothing to do. Make sure status reflects reality.
      if (this.status.state !== "valid" || this.status.expiresAt?.getTime() !== expiresAt?.getTime()) {
        this.status.state = "valid";
        this.status.expiresAt = expiresAt;
        this.status.lastErrorReason = null;
        this.status.lastErrorMessage = null;
        this.status.nextAttemptAt = null;
        this.emitStateChange();
      }
      return;
    }

    await this.tryProvision(host);
  }

  private async tryProvision(host: string): Promise<boolean> {
    if (this.renewInflight) {
      await this.renewInflight;
      return this.status.state === "valid";
    }

    this.status.state = "renewing";
    this.emitStateChange();

    let resolveInflight!: () => void;
    this.renewInflight = new Promise<void>((r) => { resolveInflight = r; });

    try {
      this.opts.log("info", `Provisioning TLS certificate for ${host}...`);
      const result = await provisionTlsCert({
        host,
        certPath: this.opts.certPath,
        keyPath: this.opts.keyPath,
      });

      if (result.ok) {
        this.consecutiveFailures = 0;
        this.status.state = "valid";
        this.status.expiresAt = result.notAfter;
        this.status.lastErrorReason = null;
        this.status.lastErrorMessage = null;
        this.status.nextAttemptAt = null;
        this.opts.log("info", `  Certificate written to ${result.certPath}`);
        this.opts.log("info", `  Key written to ${result.keyPath}`);
        this.opts.log("info", `  Expires: ${result.notAfter.toISOString()}`);
        this.reloadFromDisk();
        this.emitStateChange();
        return true;
      }

      // Failure path: record state, schedule next attempt.
      this.consecutiveFailures++;
      const backoffMs = BACKOFF_SCHEDULE_MS[
        Math.min(this.consecutiveFailures - 1, BACKOFF_SCHEDULE_MS.length - 1)
      ];
      this.status.state = "failed";
      this.status.lastErrorReason = result.reason;
      this.status.lastErrorMessage = result.message;
      this.status.nextAttemptAt = new Date(Date.now() + backoffMs);
      // Don't clobber expiresAt — the old cert may still be live & valid.
      const existing = inspectCert(this.opts.certPath);
      this.status.expiresAt = existing?.notAfter ?? null;

      this.opts.log(
        "warn",
        `TLS provisioning failed (${result.reason}): ${result.message}. Next attempt at ${this.status.nextAttemptAt.toISOString()}`,
      );
      if (result.stderr) {
        for (const line of result.stderr.split(/\r?\n/).filter(Boolean)) {
          this.opts.log("warn", `  ${line}`);
        }
      }
      if (result.reason === "https_not_enabled") {
        this.opts.log(
          "warn",
          "Enable HTTPS for your tailnet at https://login.tailscale.com/admin/dns",
        );
      }
      this.emitStateChange();
      return false;
    } finally {
      resolveInflight();
      this.renewInflight = null;
    }
  }

  private attachWatcher(): void {
    if (this.watcher) return;
    // Watch the directory rather than the file — atomic rename removes the
    // original inode, which detaches a file-level watcher on most platforms.
    try {
      this.watcher = watch(dirname(this.opts.certPath), (_event, filename) => {
        if (filename !== "tls.crt" && filename !== "tls.key") return;
        if (this.watchDebounce) clearTimeout(this.watchDebounce);
        const t = setTimeout(() => {
          this.watchDebounce = null;
          this.handleExternalChange();
        }, WATCH_DEBOUNCE_MS);
        // Don't keep the event loop alive on a pending debounce.
        // Without this, node:test's worker process on Linux never exits
        // after the tests pass: the fs.watch callback fires once during
        // mgr.stop()'s teardown, creates a new setTimeout, and the
        // process hangs waiting for it.
        t.unref?.();
        this.watchDebounce = t;
      });
      // Same reason — the inotify handle on Linux keeps the event loop
      // alive even after we've called .close() (close drains async).
      // Unref so the test process can exit cleanly.
      this.watcher.unref?.();
    } catch (err) {
      this.opts.log("warn", `Failed to attach cert watcher: ${(err as Error).message}`);
    }
  }

  private handleExternalChange(): void {
    if (this.stopped) return;
    const inspected = inspectCert(this.opts.certPath);
    if (!inspected) return;
    const sameExpiry =
      this.status.expiresAt &&
      inspected.notAfter.getTime() === this.status.expiresAt.getTime();
    if (sameExpiry) return; // no actual change

    this.status.state = "valid";
    this.status.expiresAt = inspected.notAfter;
    this.status.lastErrorReason = null;
    this.status.lastErrorMessage = null;
    this.status.nextAttemptAt = null;
    this.consecutiveFailures = 0;
    this.opts.log(
      "info",
      `TLS cert reloaded from disk (expires ${inspected.notAfter.toISOString()})`,
    );
    this.reloadFromDisk();
    this.emitStateChange();
  }

  private reloadFromDisk(): void {
    try {
      const cert = readFileSync(this.opts.certPath);
      const key = readFileSync(this.opts.keyPath);
      this.opts.onReload(cert, key);
    } catch (err) {
      this.opts.log("error", `Failed to hot-reload cert: ${(err as Error).message}`);
    }
  }

  private emitStateChange(): void {
    this.opts.onStateChange?.(this.getStatus());
  }
}

function subjectIs(subject: string, host: string): boolean {
  const cnLine = subject.split(/\r?\n/).find((l) => l.startsWith("CN="));
  if (!cnLine) return false;
  return cnLine.slice(3).trim().toLowerCase() === host.toLowerCase();
}
