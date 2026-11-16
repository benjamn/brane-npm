// The shasum of the tarball `npm pack --dry-run --json` describes, read from
// that command's output on stdin. release.yml prints it before staging, so the
// operator can match it against the SHASUM npmjs.com shows for the staged
// version before approving it (docs/releasing.md, "The gates").
//
//   npm pack --dry-run --json | node scripts/pack-shasum.mjs
//
// npm has printed two shapes: an array of one entry per package (npm 10 and
// 11), and an object keyed by package name (npm 12). Both are read. Anything
// else prints nothing and exits 1, and release.yml stages anyway: npm's own
// `npm notice shasum:` line in the staging log carries the same value, and a
// convenience must never block a release.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function packShasum(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === "object"
      ? Object.values(parsed)
      : [];
  const shasum = entries[0]?.shasum;
  return typeof shasum === "string" && /^[0-9a-f]{40}$/.test(shasum) ? shasum : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const shasum = packShasum(readFileSync(0, "utf8"));
  if (!shasum) {
    console.error("pack-shasum: no shasum in the npm pack --json output");
    process.exit(1);
  }
  console.log(shasum);
}
