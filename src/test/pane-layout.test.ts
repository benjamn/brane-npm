import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { type Tab, CANONICAL_TABS } from "../shared/view-url.js";
import { visiblePanes, selectPane } from "../shared/pane-layout.js";

// The bug these pin is one a rendering test would not have caught, because the
// render is correct: tapping the terminal in a Chat+Terminal split really did
// select the terminal, and really did draw it full width. What broke was the
// *tap* — the pane grew under the finger between pointerdown and pointerup, so
// no click was ever dispatched and the quick key sent nothing. The invariant
// that prevents it is about the visible set, not about pixels: selecting a
// pane you can already see must not change which panes are visible.

/** Every subset of the tab set, as a Set — 8 of them. */
function pinPowerset(): Set<Tab>[] {
  const out: Set<Tab>[] = [];
  for (let mask = 0; mask < 1 << CANONICAL_TABS.length; mask++) {
    const pins = new Set<Tab>();
    CANONICAL_TABS.forEach((t, i) => { if (mask & (1 << i)) pins.add(t); });
    out.push(pins);
  }
  return out;
}

const show = (active: Tab, pins: Set<Tab>) =>
  `${active}+[${[...pins].sort().join(",")}]`;

describe("visiblePanes", () => {
  it("is the active pane plus the pinned ones, in tab-bar order", () => {
    assert.deepEqual(visiblePanes("terminal", new Set()), ["terminal"]);
    assert.deepEqual(visiblePanes("terminal", new Set<Tab>(["chat"])), ["chat", "terminal"]);
    // Pinning the active pane is not a second pane.
    assert.deepEqual(visiblePanes("chat", new Set<Tab>(["chat"])), ["chat"]);
    assert.deepEqual(
      visiblePanes("files", new Set<Tab>(["terminal", "chat"])),
      ["chat", "terminal", "files"],
    );
  });
});

describe("selectPane", () => {
  it("selecting a visible pane leaves the visible set untouched", () => {
    for (const pins of pinPowerset()) {
      for (const active of CANONICAL_TABS) {
        const before = visiblePanes(active, pins);
        for (const tapped of before) {
          const next = selectPane(active, pins, tapped);
          assert.deepEqual(
            visiblePanes(next.active, next.pinned),
            before,
            `${show(active, pins)} tapping ${tapped}`,
          );
          assert.equal(next.active, tapped, `${show(active, pins)} tapping ${tapped}`);
        }
      }
    }
  });

  it("the split that motivated this: Chat active, Terminal pinned", () => {
    // The ordinary way an operator gets a split — and the case where the naive
    // `setActiveTab` dropped Chat, because Chat was visible only by being
    // active. Both panes must survive a tap on the terminal.
    const next = selectPane("chat", new Set<Tab>(["terminal"]), "terminal");
    assert.deepEqual(visiblePanes(next.active, next.pinned), ["chat", "terminal"]);
    assert.equal(next.active, "terminal");
    // Chat stays by being pinned on the way past; the terminal keeps the pin
    // the operator gave it.
    assert.deepEqual([...next.pinned].sort(), ["chat", "terminal"]);
  });

  it("never unpins anything: a pin comes off only through its toggle", () => {
    // Tapping into a pinned pane used to unpin it, since being active shows
    // it anyway. The visible set survived that tap, but the pin did not, so
    // the next tab change dropped a pane the operator had pinned.
    for (const pins of pinPowerset()) {
      for (const active of CANONICAL_TABS) {
        for (const tapped of CANONICAL_TABS) {
          const next = selectPane(active, pins, tapped);
          for (const pin of pins) {
            assert.ok(
              next.pinned.has(pin),
              `${show(active, pins)} tapping ${tapped} unpinned ${pin}`,
            );
          }
        }
      }
    }
  });

  it("Terminal and Files pinned: tapping between them keeps both pins", () => {
    const pins = new Set<Tab>(["terminal", "files"]);
    const toFiles = selectPane("terminal", pins, "files");
    assert.deepEqual([...toFiles.pinned].sort(), ["files", "terminal"]);
    const back = selectPane(toFiles.active, toFiles.pinned, "terminal");
    assert.deepEqual([...back.pinned].sort(), ["files", "terminal"]);
    assert.deepEqual(visiblePanes(back.active, back.pinned), ["terminal", "files"]);
  });

  it("never shrinks the visible set, even when the tapped pane was hidden", () => {
    // The reveal case (`revealTerminal`): a hidden pane joins the visible set
    // rather than replacing it.
    for (const pins of pinPowerset()) {
      for (const active of CANONICAL_TABS) {
        for (const tapped of CANONICAL_TABS) {
          const before = new Set(visiblePanes(active, pins));
          const next = selectPane(active, pins, tapped);
          for (const pane of before) {
            assert.ok(
              visiblePanes(next.active, next.pinned).includes(pane),
              `${show(active, pins)} tapping ${tapped} dropped ${pane}`,
            );
          }
        }
      }
    }
  });

  it("is idempotent and does not mutate its input", () => {
    const pins = new Set<Tab>(["terminal"]);
    const once = selectPane("chat", pins, "terminal");
    assert.deepEqual([...pins], ["terminal"], "input set was mutated");
    const twice = selectPane(once.active, once.pinned, "terminal");
    assert.equal(twice.active, once.active);
    assert.deepEqual([...twice.pinned].sort(), [...once.pinned].sort());
  });
});

// The rest of the fix is a DOM rule that has no pure form: the pane-select
// listener must ignore presses that land on a control. Reading the source is
// how `api-request.test.ts` and `key-routing.test.ts` pin their invisible
// invariants, and this one is invisible in the same way — put `activateTab`
// back in the handler and every test still passes while the quick bar goes
// back to eating every other tap.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const screen = join(repoRoot, "expo", "app", "[nid].tsx");
// `expo/dist` ships in the tarball; the .tsx does not. From an install this
// skips with a reason rather than failing on ENOENT — see `brane doctor`.
const skip = !existsSync(screen) ? "expo source not shipped" : false;

describe("the pane-select listener", () => {
  it("selects through selectPane, not through activateTab", { skip }, () => {
    const src = readFileSync(screen, "utf8");
    const start = src.indexOf('document.addEventListener("pointerdown"');
    assert.notEqual(start, -1, "pointerdown pane-select listener not found");
    const handler = src.slice(src.lastIndexOf("const handler", start), start);
    assert.match(handler, /selectVisiblePane\(pane\)/);
    assert.doesNotMatch(
      handler,
      /activateTab\(/,
      "pane selection must preserve the visible set (selectPane), not just set the tab",
    );
  });

  it("listens only while its screen is the foreground route", { skip }, () => {
    // The Stack keeps screens behind the top one mounted. A hidden screen's
    // listener heard taps on the screen in front, selected a pane in its own
    // layout (pinning its Chat), and router.setParams — which writes to the
    // focused route — put that layout into the visible screen's URL.
    const src = readFileSync(screen, "utf8");
    const start = src.indexOf('document.addEventListener("pointerdown"');
    const effect = src.slice(src.lastIndexOf("useEffect(", start), start);
    assert.match(effect, /if \(!screenFocused\) return;/);
    const deps = src.slice(start, src.indexOf("]);", start));
    assert.match(deps, /\[screenFocused,/, "screenFocused must be an effect dependency");
  });

  it("ignores presses that land on a control", { skip }, () => {
    const src = readFileSync(screen, "utf8");
    const start = src.indexOf('document.addEventListener("pointerdown"');
    const handler = src.slice(src.lastIndexOf("const handler", start), start);
    assert.match(handler, /closest\?\.\(INTERACTIVE_SELECTOR\)\) return;/);
    // The bail must come before the pane is read, or it bails after the work.
    assert.ok(
      handler.indexOf("INTERACTIVE_SELECTOR") < handler.indexOf('closest?.("[data-pane]")'),
      "the control bail must precede the pane lookup",
    );
    // Text fields are not controls for this purpose: clicking into the
    // composer is a request to type there, and the tab should follow.
    const selector = src.match(/const INTERACTIVE_SELECTOR =\s*([^;]+);/);
    assert.ok(selector, "INTERACTIVE_SELECTOR not found");
    assert.doesNotMatch(selector[1], /input|textarea/);
  });
});
