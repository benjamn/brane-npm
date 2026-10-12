import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DEFAULTS } from "../commands/config.js";

// The shared app's host is written in two places: the route the worker is
// deployed to (worker/wrangler.toml) and the default `app_domain` that
// `brane meld` points a QR at and a daemon's bundle hops out to. A fork that
// changes one and not the other melds phones to a host that serves nothing,
// so they are pinned together here.
//
// This reads *source*, which the npm tarball does not carry, so it skips when
// the source is absent rather than failing `brane doctor` on every install.

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WRANGLER = join(root, "worker", "wrangler.toml");

describe("the worker's route", () => {
  it("is CONFIG_DEFAULTS.app_domain, as a custom domain, with no workers.dev alias", (t) => {
    if (!existsSync(WRANGLER)) return t.skip("source is not present (an installed package)");
    const toml = readFileSync(WRANGLER, "utf8").replace(/#.*$/gm, "");
    const routes = [...toml.matchAll(/\{\s*pattern\s*=\s*"([^"]+)"\s*,\s*custom_domain\s*=\s*true\s*\}/g)].map((m) => m[1]);
    assert.deepEqual(routes, [CONFIG_DEFAULTS.app_domain]);
    assert.match(toml, /^workers_dev\s*=\s*false\s*$/m);
  });
});
