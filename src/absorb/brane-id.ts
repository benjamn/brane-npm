import { createHash } from "node:crypto";

/** `brane-<provider>-<6 hex of sha256(provider:identity)>` — deterministic so
 *  a second import of the same account targets the same brane. */
export function deriveBraneId(provider: string, identityId: string): string {
  const hash = createHash("sha256")
    .update(`${provider}:${identityId}`)
    .digest("hex")
    .slice(0, 6);
  return `brane-${provider}-${hash}`;
}
