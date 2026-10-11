// Restore the execute bit on every `bin` target after tsc writes dist/.
//
// `npm link` and `npm install` set +x on bin targets once, at link time.
// tsc overwriting a file in place preserves that mode, but clean-dist.mjs
// now sweeps dist/ before every build, so tsc creates dist/cli.js fresh at
// 0644 and the linked `brane` command silently disappears from the shell:
// zsh and `which` skip non-executable files during PATH lookup, while
// `node dist/cli.js` keeps working because node never checks the bit.
//
// Published tarballs are unaffected (npm sets the mode at install time); this
// is for the linked dev checkout. On Windows chmod is a no-op, which is fine.
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const { bin } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const targets = typeof bin === "string" ? [bin] : Object.values(bin ?? {});

for (const target of targets) {
  const path = fileURLToPath(new URL(target, root));
  if (!existsSync(path)) {
    console.warn(`chmod-bin: ${target} not found; did tsc run?`);
    continue;
  }
  chmodSync(path, statSync(path).mode | 0o111);
}
