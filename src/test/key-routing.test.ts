import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Keystrokes in the web app are routed by ONE rule: the foreground route's
// green tab owns the keyboard. Two document-level keydown listeners implement
// it — the terminal's (TerminalPane.tsx) and the chat composer's funnel
// ([nid].tsx) — and Expo Router keeps every visited [nid] screen mounted under
// the top of the stack, so a listener gated only on its own screen's tab state
// hears keys typed into a DIFFERENT narrative. #342 gated the terminal on
// useIsFocused(); the chat funnel predates it and was never gated, which is
// how typing into one narrative's terminal filled another narrative's
// composer. This test reads the source because the failure is invisible on a
// single-narrative page: it only reproduces with two screens on the stack.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");
// These tests lint source the tarball doesn't ship (`expo/dist/` ships, the
// `.tsx` doesn't). From an installed package — `brane doctor` — they skip
// with a reason instead of failing on ENOENT.
const sourceMissing = !existsSync(join(repoRoot, "expo", "app", "[nid].tsx"));
const skip = sourceMissing ? "expo source not shipped" : false;

const LISTENERS = [
  { file: "expo/app/[nid].tsx", gate: "chatActiveRef.current" },
  { file: "expo/components/TerminalPane.tsx", gate: "isFocusedRef.current" },
  // The narrative list's scroll keys. It isn't a [nid] screen, but it sits
  // under every one of them on the stack, so an ungated listener would scroll
  // the hidden list while the operator pages through a chat.
  { file: "expo/app/index.tsx", gate: "listOwnsKeysRef.current" },
];

describe("document-level keydown listeners are gated on route focus", () => {
  for (const { file, gate } of LISTENERS) {
    test(file, { skip }, () => {
      const src = read(file);
      assert.match(src, /useIsFocused\(\)/, `${file} must read useIsFocused()`);
      const sites = [...src.matchAll(/document\.addEventListener\("keydown", (\w+)\)/g)];
      assert.ok(sites.length > 0, `${file} should register a keydown listener`);
      for (const m of sites) {
        const name = m[1];
        // Find the handler's body and require that it checks the route-focus
        // ref before doing anything with the key.
        const decl = src.indexOf(`const ${name} = (e: KeyboardEvent) => {`);
        assert.notEqual(decl, -1, `handler ${name} not found in ${file}`);
        const body = src.slice(decl, src.indexOf("document.addEventListener", decl));
        // `if (!gate) return;` or `if (!x || !gate) return;` — either way the
        // key is dropped before it is forwarded anywhere.
        const bail = new RegExp(`if \\(([^)]*\\|\\| )?!${gate.replace(".", "\\.")}\\) return;`);
        assert.match(body, bail, `${file}: keydown handler ${name} must bail when !${gate}`);
      }
    });
  }

  test("the chat gate carries route focus, not just the tab", { skip }, () => {
    const src = read("expo/app/[nid].tsx");
    assert.match(src, /const chatOwnsKeys = chatActive && isFocused;/);
    assert.match(src, /chatActiveRef\.current = chatOwnsKeys;/);
  });
});
