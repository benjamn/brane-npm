import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  narrativeMenuItems,
  revivesAsTwin,
  type NarrativeMenuOptions,
} from "../shared/narrative-menu.js";

// Every handler distinct, so a test can tell which item was wired to what — the
// failure this guards against is not a missing item but a mislabeled one.
function options(over: Partial<NarrativeMenuOptions> = {}): NarrativeMenuOptions {
  return {
    onMeld: () => {},
    onIsolate: () => {},
    onExport: () => {},
    onRecolor: () => {},
    onTwin: () => {},
    onRevive: () => {},
    onEnd: () => {},
    onArchiveToggle: () => {},
    ...over,
  };
}

const labels = (over: Partial<NarrativeMenuOptions> = {}) =>
  narrativeMenuItems(options(over)).map((i) => i.label);

describe("narrativeMenuItems — Export scope", () => {
  const exportItems = (over: Partial<NarrativeMenuOptions> = {}) =>
    narrativeMenuItems(options(over)).filter((i) => i.label.startsWith("Export"));
  const exportLabels = (over: Partial<NarrativeMenuOptions> = {}) =>
    exportItems(over).map((i) => i.label);

  it("is a single plain Export with no selection", () => {
    assert.deepEqual(exportLabels(), ["Export"]);
    assert.deepEqual(exportLabels({ selectedCount: 0 }), ["Export"]);
  });

  it("offers both sides of a selection, each naming its count", () => {
    assert.deepEqual(exportLabels({ selectedCount: 1 }), [
      "Export 1 selected",
      "Export 1 excluded",
    ]);
    assert.deepEqual(exportLabels({ selectedCount: 12 }), [
      "Export 12 selected",
      "Export 12 excluded",
    ]);
  });

  it("gives the two items distinct icons", () => {
    // They sit adjacent in the menu and differ only in a word; an operator
    // scanning icons should not have to read the label to tell them apart.
    const icons = exportItems({ selectedCount: 3 }).map((i) => i.icon);
    assert.deepEqual(icons, ["📨", "📤"]);
  });

  it("tells the press which scope was asked for", () => {
    // The screen exports the selection or its complement off this argument
    // alone — a handler that ignored it would export the same file twice.
    const scopes: string[] = [];
    for (const item of exportItems({ selectedCount: 2, onExport: (s) => scopes.push(s) })) {
      item.onPress();
    }
    assert.deepEqual(scopes, ["selected", "excluded"]);
  });

  it("asks for the whole conversation when nothing is selected", () => {
    const scopes: string[] = [];
    exportItems({ onExport: (s) => scopes.push(s) })[0].onPress();
    assert.deepEqual(scopes, ["all"]);
  });

  it("changes nothing else about the menu", () => {
    assert.deepEqual(
      labels({ status: "active", mcpConnected: true, selectedCount: 2 }).filter((l) => !l.startsWith("Export")),
      labels({ status: "active", mcpConnected: true }).filter((l) => !l.startsWith("Export")),
    );
  });
});

describe("narrativeMenuItems", () => {
  it("offers the same menu on a running narrative from either surface", () => {
    // The builder exists so the detail header and the list card can't drift.
    // This is that claim: one input, one menu, no surface-dependent branch.
    assert.deepEqual(labels({ status: "active", mcpConnected: true }), [
      "Meld",
      "Isolate",
      "Export",
      "Recolor",
      "Twin",
      "End",
    ]);
  });

  it("swaps End for Revive once the session is over", () => {
    assert.ok(labels({ status: "active", mcpConnected: true }).includes("End"));
    assert.ok(labels({ status: "ended" }).includes("Revive"));
    assert.ok(!labels({ status: "ended" }).includes("End"));
  });

  it("treats an ended row still holding an MCP bridge as running", () => {
    // A stale `ended` row that the daemon hasn't healed yet still has an agent
    // on the bridge — offering Revive there would restart a live session.
    assert.ok(labels({ status: "ended", mcpConnected: true }).includes("End"));
  });

  it("gives an external narrative no in-place lifecycle item at all", () => {
    // No tmux process to end or resume; Twin is its only lifecycle action.
    const external = labels({ role: "external", status: "ended" });
    assert.ok(!external.includes("Revive"));
    assert.ok(!external.includes("End"));
    assert.ok(external.includes("Twin"));
  });

  it("keeps Revive on an absorbed import, which reaches Twin through it", () => {
    assert.ok(labels({ role: "absorbed", status: "ended" }).includes("Revive"));
  });

  it("flips the archive item both ways", () => {
    assert.ok(labels({ status: "ended", archived: false }).includes("Archive"));
    assert.ok(labels({ status: "ended", archived: true }).includes("Unarchive"));
  });

  it("offers Archive only once the session has ended", () => {
    const running = labels({ status: "active", mcpConnected: true });
    assert.ok(!running.includes("Archive") && !running.includes("Unarchive"));
    // The same stale-row test as Revive: an ended row with an agent still on
    // the bridge is running, and isn't archivable yet.
    assert.ok(!labels({ status: "ended", mcpConnected: true }).includes("Archive"));
    assert.ok(labels({ status: "ended" }).includes("Archive"));
  });

  it("always offers Unarchive on an archived narrative", () => {
    for (const status of ["active", "ended", null]) {
      for (const mcpConnected of [true, false]) {
        assert.ok(
          labels({ archived: true, status, mcpConnected }).includes("Unarchive"),
          `status: ${status}, mcpConnected: ${mcpConnected}`,
        );
      }
    }
  });

  it("flips isolate by where the app is served from", () => {
    assert.ok(labels({ isIsolated: false }).includes("Isolate"));
    assert.ok(labels({ isIsolated: true }).includes("Unisolate"));
  });

  it("wires each item to its own handler", () => {
    const fired: string[] = [];
    const items = narrativeMenuItems(
      options({
        status: "ended",
        onMeld: () => fired.push("meld"),
        onIsolate: () => fired.push("isolate"),
        onExport: () => fired.push("export"),
        onRecolor: () => fired.push("recolor"),
        onTwin: () => fired.push("twin"),
        onRevive: () => fired.push("revive"),
        onArchiveToggle: () => fired.push("archive"),
      }),
    );
    for (const item of items) item.onPress();
    assert.deepEqual(fired, ["meld", "isolate", "export", "recolor", "twin", "revive", "archive"]);
  });

  it("gives every item an icon and a unique label", () => {
    // ContextMenu keys its buttons by label, so a duplicate would drop a row.
    const items = narrativeMenuItems(options());
    assert.ok(items.every((i) => i.icon));
    assert.equal(new Set(items.map((i) => i.label)).size, items.length);
  });
});

describe("revivesAsTwin", () => {
  it("names the roles with nothing to resume", () => {
    assert.equal(revivesAsTwin("external"), true);
    assert.equal(revivesAsTwin("absorbed"), true);
  });

  it("leaves every ordinary role to revive in place", () => {
    for (const role of ["worker", "twin", "keeper", "utility", null, undefined]) {
      assert.equal(revivesAsTwin(role), false, `role: ${role}`);
    }
  });
});

describe("narrativeMenuItems — Isolate", () => {
  it("reads Isolate on a shared app and Unisolate on a daemon's own bundle", () => {
    assert.ok(labels().includes("Isolate"));
    assert.ok(labels({ isIsolated: true }).includes("Unisolate"));
  });

  it("is left out when there is nowhere to go, and nothing else moves", () => {
    // A daemon's own bundle whose daemon reported no app host: offering the
    // item would mean a link to a host the app made up.
    const without = labels({ isIsolated: true, canIsolate: false });
    assert.ok(!without.includes("Isolate") && !without.includes("Unisolate"));
    assert.deepEqual(without, labels({ isIsolated: true }).filter((l) => l !== "Unisolate"));
  });
});
