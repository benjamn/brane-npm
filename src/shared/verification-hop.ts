/**
 * The app's side of the verification gate, as pure decisions
 * (docs/passkeys.md, "The hop" and "What the browser side must do"): what a
 * refusal looks like, where the hop goes when no window can be opened,
 * whether going to the background should end the window, and whether a
 * status says this device is verified. Shared so the suite pins them; the
 * store that acts on them is `expo/lib/verification.ts`.
 */

export type VerificationKind = "required" | "fresh";

/** The gate's refusal, from a response's status and parsed body, or null.
 *  Only a `403` with a `verification` field is one: the presence gate's
 *  `403 { presence }` and an agent-scope refusal are not, and `401` is a
 *  dead token, never this. */
export function verificationRefusal(status: number, body: unknown): VerificationKind | null {
  if (status !== 403 || !body || typeof body !== "object") return null;
  const v = (body as { verification?: unknown }).verification;
  return v === "required" || v === "fresh" ? v : null;
}

/** The ceremony page's URL for a hop in this same tab, when no window could
 *  be opened: the page offers the way back as a link. Only an http(s) page
 *  is a way back. The return rides in the fragment beside the approval, so
 *  no server sees either. */
export function sameTabHopUrl(pageUrl: string, returnHref: string): string {
  if (!/^https?:\/\//.test(returnHref)) return pageUrl;
  const sep = pageUrl.includes("#") ? "&" : "#";
  return `${pageUrl}${sep}${new URLSearchParams({ return: returnHref }).toString()}`;
}

/** Whether going to the background should end this device's window
 *  (`POST /api/verify/end`). Not while the gate is off (there is nothing to
 *  end), not when the window is already over, and **never mid-hop**: the hop
 *  itself sends the app to the background, and a phone may hold the request
 *  back until the app resumes, by which time it would cancel the proof just
 *  given. */
export function shouldEndOnHide(s: { mode: string | null; verifiedUntil: number | null; hopping: boolean; now: number }): boolean {
  if (s.hopping) return false;
  if (s.mode === null || s.mode === "off") return false;
  return s.verifiedUntil !== null && s.verifiedUntil > s.now;
}

export interface StatusVerification {
  mode: string;
  window_minutes?: number;
  fresh?: string[];
  /** The asking device's own window, when it is a device. */
  verified_until?: number | null;
  /** The host a credential must be enrolled for (null without TLS), the
   *  hosts live credentials were enrolled for instead (a rename orphans
   *  them), and how many can verify here (null while the host is unknown).
   *  Absent on a daemon from before phase 4. */
  rp_id?: string | null;
  rp_mismatch?: string[];
  usable_credentials?: number | null;
}

/** Why the lock sheet has nothing to offer, or null when a proof is
 *  possible. With the gate on and no live credential enrolled for the host
 *  the daemon serves (every one orphaned by a rename, or the last revoked),
 *  Verify would open a page no credential can answer; and enrolling is an
 *  act, so no device can add one. The way out is the shell. */
export function noCredentialCanVerify(v: StatusVerification | undefined): string | null {
  if (!v || v.mode === "off" || typeof v.usable_credentials !== "number" || v.usable_credentials > 0) return null;
  const renamed = v.rp_mismatch?.length
    ? `Your passkeys were enrolled for ${v.rp_mismatch.join(", ")}, and this daemon now serves ${v.rp_id ?? "another host"}, so none of them can verify here.`
    : "No passkey or security key is enrolled for this daemon, so nothing can verify here.";
  return `${renamed} From the daemon's machine, run \`brane config verification off\`, then add one from Devices before switching it back on.`;
}

/** How a list names what verified a device: the credential's label in
 *  quotes, as a device's own label is shown. A label says where the passkey
 *  was enrolled ("Passkey from Chrome on macOS"), so unquoted, under a row
 *  titled "Chrome on iPhone", it read as a claim about where the proof came
 *  from. The daemon's "(revoked)" mark stays outside the quotes; an id with
 *  no label to show (`oidc:<sub>`, or a row id the daemon no longer knows)
 *  is not a name and is left bare. */
export function proofName(v: { by: string; by_id: string }): string {
  if (v.by === v.by_id) return v.by;
  const revoked = " (revoked)";
  return v.by.endsWith(revoked) ? `"${v.by.slice(0, -revoked.length)}"${revoked}` : `"${v.by}"`;
}

/** Whether a `GET /api/status` body says this device may act now. A daemon
 *  from before the gate, or with it off, always says yes. */
export function verifiedPerStatus(status: unknown, now: number): boolean {
  const v = (status as { verification?: StatusVerification } | null)?.verification;
  if (!v || v.mode === "off") return true;
  return typeof v.verified_until === "number" && v.verified_until > now;
}
