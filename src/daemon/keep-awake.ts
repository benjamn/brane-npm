// KeepAwake — holds an idle-sleep power assertion while the daemon runs.
//
// On macOS the daemon spawns a single hidden `caffeinate -i` child whose
// lifetime mirrors the daemon's. The child holds a
// `PreventUserIdleSystemSleep` IOKit assertion, equivalent to running
// `caffeinate -i` in a terminal, but without occupying a tmux session.
// Display sleep is unaffected — the screen still dims normally.
//
// On other platforms this is a no-op. The status surface lets callers tell
// "we are deliberately not holding an assertion" (unsupported) apart from
// "we tried and failed" (unavailable).

import { spawn, type ChildProcess } from "node:child_process";

export type KeepAwakeState = "held" | "released" | "unsupported" | "unavailable";

export interface KeepAwakeStatus {
  state: KeepAwakeState;
  pid: number | null;
  last_error?: string;
}

const RESPAWN_BACKOFF_MS = 5000;

export class KeepAwake {
  private child: ChildProcess | null = null;
  private wantRunning = false;
  private respawnTimer: NodeJS.Timeout | null = null;
  private lastError: string | undefined;
  private readonly supported: boolean;

  constructor(private readonly log: (msg: string) => void = () => {}) {
    this.supported = process.platform === "darwin";
  }

  start(): void {
    if (!this.supported) return;
    if (this.wantRunning) return;
    this.wantRunning = true;
    this.spawnChild();
  }

  stop(): void {
    this.wantRunning = false;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    if (this.child && this.child.exitCode === null) {
      try { this.child.kill("SIGTERM"); } catch {}
    }
    this.child = null;
  }

  getStatus(): KeepAwakeStatus {
    if (!this.supported) return { state: "unsupported", pid: null };
    if (this.child && this.child.exitCode === null && this.child.pid) {
      return { state: "held", pid: this.child.pid };
    }
    const status: KeepAwakeStatus = { state: this.wantRunning ? "unavailable" : "released", pid: null };
    if (this.lastError) status.last_error = this.lastError;
    return status;
  }

  private spawnChild(): void {
    try {
      const child = spawn("caffeinate", ["-i"], {
        stdio: "ignore",
        detached: false,
      });
      this.child = child;
      child.once("error", (err) => {
        this.lastError = err.message;
        this.log(`caffeinate failed to spawn: ${err.message}`);
        this.child = null;
        this.scheduleRespawn();
      });
      child.once("exit", (code, signal) => {
        if (this.child === child) this.child = null;
        if (this.wantRunning) {
          this.lastError = `caffeinate exited (code=${code} signal=${signal})`;
          this.log(this.lastError);
          this.scheduleRespawn();
        }
      });
      this.lastError = undefined;
      this.log(`keep-awake: caffeinate pid=${child.pid} (PreventUserIdleSystemSleep)`);
    } catch (err) {
      this.lastError = (err as Error).message;
      this.log(`caffeinate spawn threw: ${this.lastError}`);
      this.scheduleRespawn();
    }
  }

  private scheduleRespawn(): void {
    if (!this.wantRunning) return;
    if (this.respawnTimer) return;
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      if (this.wantRunning) this.spawnChild();
    }, RESPAWN_BACKOFF_MS);
    if (typeof this.respawnTimer.unref === "function") this.respawnTimer.unref();
  }
}
