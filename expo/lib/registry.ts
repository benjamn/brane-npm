/**
 * Client-side daemon registry.
 *
 * Daemon list lives in localStorage (shared across tabs).
 * Active daemon selection lives in sessionStorage (per-tab), with a
 * separate localStorage "default" used to seed new tabs. The default
 * only changes on explicit user switch — opening a meld URL or adding
 * a daemon in one tab no longer clobbers other tabs' selections.
 */

export interface DaemonEntry {
  id: string;          // "user@hostname" for display
  host: string;        // "hostname:port" for connections
  token: string;
  hostname: string;
  username: string;
  brane_id: string;    // stable dedup key
  addedAt: number;
  /** The daemon rotated its token and this entry holds the old one. Kept, not
   *  removed — the golden rule, and the entry is how the banner names what you
   *  were signed out of. A fresh meld of the same brane replaces the entry
   *  wholesale (addDaemon), which clears it. */
  revoked?: boolean;
}

export const DAEMONS_KEY = "brane_daemons";
const ACTIVE_KEY = "brane_active_daemon";   // sessionStorage: per-tab
const DEFAULT_KEY = "brane_default_daemon"; // localStorage: seed for new tabs

// One-time migration: the old code stored the active daemon in
// localStorage under ACTIVE_KEY. Promote that to DEFAULT_KEY (if not
// already set) and clean up.
function migrateLegacyActive(): void {
  try {
    const legacy = localStorage.getItem(ACTIVE_KEY);
    if (legacy && !localStorage.getItem(DEFAULT_KEY)) {
      localStorage.setItem(DEFAULT_KEY, legacy);
    }
    if (legacy) {
      localStorage.removeItem(ACTIVE_KEY);
    }
  } catch {
    // ignore
  }
}

export function loadDaemons(): DaemonEntry[] {
  try {
    const raw = localStorage.getItem(DAEMONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveDaemons(daemons: DaemonEntry[]): void {
  localStorage.setItem(DAEMONS_KEY, JSON.stringify(daemons));
}

export function addDaemon(entry: DaemonEntry): DaemonEntry[] {
  const daemons = loadDaemons();
  // Dedup by brane_id — update existing entry if same daemon
  const idx = daemons.findIndex((d) => d.brane_id === entry.brane_id);
  if (idx >= 0) {
    daemons[idx] = { ...entry, addedAt: daemons[idx].addedAt };
  } else {
    daemons.push(entry);
  }
  saveDaemons(daemons);
  return daemons;
}

/** Patch one entry in place — a rotated token, a revoked flag — without
 *  touching its identity or order. */
export function updateDaemon(id: string, patch: Partial<DaemonEntry>): DaemonEntry[] {
  const daemons = loadDaemons().map((d) => (d.id === id ? { ...d, ...patch } : d));
  saveDaemons(daemons);
  return daemons;
}

export function removeDaemon(id: string): DaemonEntry[] {
  const daemons = loadDaemons().filter((d) => d.id !== id);
  saveDaemons(daemons);
  // If the removed daemon was the cross-tab default, promote the next.
  if (getDefaultDaemonId() === id) {
    setDefaultDaemonId(daemons[0]?.id ?? null);
  }
  // Clear this tab's active if it was removed.
  if (getActiveDaemonIdRaw() === id) {
    setActiveDaemonId(daemons[0]?.id ?? null);
  }
  return daemons;
}

// Per-tab active daemon, with localStorage default as fallback for fresh tabs.
export function getActiveDaemonId(): string | null {
  migrateLegacyActive();
  try {
    return sessionStorage.getItem(ACTIVE_KEY) ?? localStorage.getItem(DEFAULT_KEY);
  } catch {
    return null;
  }
}

// Raw read used by removeDaemon to decide whether to clear sessionStorage.
function getActiveDaemonIdRaw(): string | null {
  try {
    return sessionStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function setActiveDaemonId(id: string | null): void {
  try {
    if (id) {
      sessionStorage.setItem(ACTIVE_KEY, id);
    } else {
      sessionStorage.removeItem(ACTIVE_KEY);
    }
  } catch {
    // ignore
  }
}

export function getDefaultDaemonId(): string | null {
  try {
    return localStorage.getItem(DEFAULT_KEY);
  } catch {
    return null;
  }
}

export function setDefaultDaemonId(id: string | null): void {
  try {
    if (id) {
      localStorage.setItem(DEFAULT_KEY, id);
    } else {
      localStorage.removeItem(DEFAULT_KEY);
    }
  } catch {
    // ignore
  }
}
