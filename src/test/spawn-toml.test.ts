import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { replaceTomlTable } from "../commands/spawn.js";

const HEADER = "[mcp_servers.brane]";

const NEW_SECTION = `[mcp_servers.brane]
command = "/usr/local/bin/brane"
args = ["mcp"]
env_vars = ["BRANE_NARRATIVE_ID"]
tool_timeout_sec = 3600
`;

describe("replaceTomlTable", () => {
  // Regression: the original implementation used
  //   existing.replace(/\[mcp_servers\.brane\][^\[]*(?=\[|$)/s, braneSection)
  // The [^\[]* halts at the first '[' *anywhere* — including the one inside
  // `args = ["mcp"]`. That truncated the match mid-table and left the tail
  // (`["mcp"]\nenv_vars = [...]`) orphaned in ~/.codex/config.toml as a bogus
  // table header, corrupting the operator's global codex config.
  it("does not orphan the tail when a value contains '['", () => {
    const source = `[model]
name = "gpt-5"

${HEADER}
command = "/old/brane"
args = ["mcp"]
env_vars = ["BRANE_NARRATIVE_ID"]

[other]
x = 1
`;
    const out = replaceTomlTable(source, HEADER, NEW_SECTION);

    assert.ok(!/^\["mcp"\]/m.test(out), "orphaned array literal became a table header");
    assert.equal((out.match(/env_vars/g) ?? []).length, 1, "env_vars duplicated");
    assert.equal((out.match(/\[mcp_servers\.brane\]/g) ?? []).length, 1);
  });

  it("preserves sibling tables on both sides", () => {
    const source = `[model]
name = "gpt-5"

${HEADER}
command = "/old/brane"
args = ["mcp"]

[other]
x = 1
`;
    const out = replaceTomlTable(source, HEADER, NEW_SECTION);

    assert.match(out, /\[model\]\nname = "gpt-5"/);
    assert.match(out, /\[other\]\nx = 1/);
    assert.match(out, /tool_timeout_sec = 3600/);
    assert.ok(!out.includes("/old/brane"), "stale command survived the replace");
  });

  it("replaces a trailing table with no following header", () => {
    const source = `[model]\nname = "gpt-5"\n\n${HEADER}\ncommand = "/old/brane"\nargs = ["mcp"]\n`;
    const out = replaceTomlTable(source, HEADER, NEW_SECTION);

    assert.match(out, /\[model\]/);
    assert.match(out, /tool_timeout_sec = 3600/);
    assert.ok(!out.includes("/old/brane"));
  });

  it("appends when the table is absent", () => {
    const source = `[model]\nname = "gpt-5"\n`;
    const out = replaceTomlTable(source, HEADER, NEW_SECTION);

    assert.match(out, /\[model\]\nname = "gpt-5"/);
    assert.equal((out.match(/\[mcp_servers\.brane\]/g) ?? []).length, 1);
  });

  it("is idempotent across repeated spawns", () => {
    const source = `[model]\nname = "gpt-5"\n\n${HEADER}\ncommand = "/old"\nargs = ["mcp"]\n\n[other]\nx = 1\n`;
    const once = replaceTomlTable(source, HEADER, NEW_SECTION);
    const twice = replaceTomlTable(once, HEADER, NEW_SECTION);

    assert.equal(once, twice, "second application changed the file");
  });
});
