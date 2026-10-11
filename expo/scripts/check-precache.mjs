// Fails if dist/sw.js still carries gen-precache.mjs's placeholders — i.e. the
// export ran but the generator did not.
//
// This exists because that failure is otherwise completely silent. `expo export`
// copies public/sw.js into dist/ verbatim, placeholders and all, and the result
// is a service worker that installs happily, caches the HTML shell and nothing
// else, and degrades offline support to "whatever you browsed before you lost
// signal" — with no build error and no failing test to say so. The generator's
// own missing-marker check cannot help here: it only runs when the generator
// runs, and the whole failure is that it didn't.
//
// Run it in CI after any build whose output is deployed, so a workflow that
// reaches for `npx expo export` directly fails loudly instead of shipping a
// worker that looks fine and isn't.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const swPath = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "sw.js");
const sw = readFileSync(swPath, "utf8");
const stale = ["__BRANE_CACHE_NAME__", "__BRANE_PRECACHE__", "__BRANE_VENDOR_CACHE__"].filter((m) => sw.includes(m));

if (stale.length) {
  console.error(
    `dist/sw.js still has unfilled ${stale.join(" and ")} — the export ran without\n` +
      `scripts/gen-precache.mjs. Build with \`npm run build:web\`, not \`expo export\`.`,
  );
  process.exit(1);
}

const urls = JSON.parse(sw.match(/const PRECACHE = (\[[\s\S]*?\]);/)[1]);
console.log(`precache ok: ${sw.match(/const CACHE_NAME = "([^"]+)"/)[1]}, ${urls.length} urls`);
