import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  agentTypeOf,
  formatActivitySpan,
  formatCost,
  formatCostTotals,
  formatInvocation,
  formatSystemContent,
  isSystemEvent,
  formatMinutes,
  relAhead,
  relPart,
  systemLine,
  restartedContent,
  revivedContent,
  runningContent,
  spawnedContent,
} from "../shared/narrative-format.js";

// Every case pins `now` explicitly. These functions feed four surfaces (the
// list card, the page header, the switcher, and the HTML export), so a change
// in wording here is a change in all four — which is the point of them living
// in one module, and the reason they're worth pinning.
// Local-clock fixtures, deliberately: `relPart` formats absolute dates with
// local getters (`d.getMonth()`, `d.getFullYear()`), so a `Date.UTC` fixture
// would be constructed on one clock and read on another. Noon hides that
// almost everywhere — but at UTC+13/+14 the date rolls and the assertions
// shift by a day, which is how a green CI ships a test that fails in Auckland.
const NOW = new Date(2026, 6, 28, 12, 0, 0).getTime(); // 2026-07-28T12:00 local
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relAhead", () => {
  it("counts down in relPart's units, rounding up so it never says less than is left", () => {
    assert.deepEqual(relAhead(NOW + 45 * SEC + 1, NOW)?.val, "46s");
    assert.deepEqual(relAhead(NOW + 60 * SEC, NOW)?.val, "60s");
    assert.deepEqual(relAhead(NOW + 60 * SEC + 1, NOW)?.val, "2m");
    assert.deepEqual(relAhead(NOW + 7 * MIN + 30 * SEC, NOW)?.val, "8m");
    assert.deepEqual(relAhead(NOW + 3 * HOUR, NOW)?.val, "3h");
    assert.deepEqual(relAhead(NOW + 2 * DAY, NOW)?.val, "2d");
    assert.equal(relAhead(NOW, NOW), null, "passed");
  });

  it("says when its words change next", () => {
    assert.equal(relAhead(NOW + 7 * MIN + 30 * SEC, NOW)?.changesInMs, 30 * SEC);
    assert.equal(relAhead(NOW + 30 * SEC, NOW)?.changesInMs, 1 * SEC);
    assert.equal(relAhead(NOW + 61 * SEC, NOW)?.changesInMs, 1 * SEC, "2m becomes 60s a second later");
  });

  it("switches to a date past a week, with no \"in\"", () => {
    const a = relAhead(NOW + 10 * DAY, NOW);
    assert.equal(a?.ahead, false);
    assert.match(a?.val ?? "", /^[A-Z][a-z]{2} \d+$/);
  });
});

describe("formatMinutes", () => {
  it("is exact, in the largest whole unit", () => {
    assert.equal(formatMinutes(15), "15m");
    assert.equal(formatMinutes(90), "90m");
    assert.equal(formatMinutes(120), "2h");
    assert.equal(formatMinutes(1440), "1d");
  });
});

describe("relPart", () => {
  it("floors sub-minute to seconds, never to zero", () => {
    assert.deepEqual(relPart(NOW - 30 * SEC, NOW), { val: "30s", ago: true });
    // A just-written event is "1s ago", not "0s ago".
    assert.deepEqual(relPart(NOW, NOW), { val: "1s", ago: true });
  });

  it("steps up through minutes, hours, and days", () => {
    assert.deepEqual(relPart(NOW - 5 * MIN, NOW), { val: "5m", ago: true });
    assert.deepEqual(relPart(NOW - 3 * HOUR, NOW), { val: "3h", ago: true });
    assert.deepEqual(relPart(NOW - 3 * DAY, NOW), { val: "3d", ago: true });
  });

  it("switches to an absolute date past a week, dropping the 'ago' suffix", () => {
    const p = relPart(NOW - 10 * DAY, NOW);
    assert.equal(p.ago, false);
    assert.match(p.val, /^Jul \d+$/);
  });

  it("includes the year only when it differs from the reference year", () => {
    const sameYear = relPart(new Date(2026, 0, 15, 12).getTime(), NOW);
    assert.equal(sameYear.val, "Jan 15");
    const priorYear = relPart(new Date(2025, 0, 15, 12).getTime(), NOW);
    assert.equal(priorYear.val, "Jan 15, 2025");
  });
});

describe("formatActivitySpan", () => {
  it("collapses to one value when there is no distinct last activity", () => {
    assert.equal(formatActivitySpan(NOW - 3 * HOUR, null, NOW), "3h ago");
    assert.equal(formatActivitySpan(NOW - 3 * HOUR, undefined, NOW), "3h ago");
  });

  it("treats activity within a minute of creation as no span at all", () => {
    const created = NOW - 3 * HOUR;
    assert.equal(formatActivitySpan(created, created + 30 * SEC, NOW), "3h ago");
  });

  it("shares one 'ago' when both ends are relative", () => {
    assert.equal(formatActivitySpan(NOW - 3 * DAY, NOW - 4 * HOUR, NOW), "3d to 4h ago");
  });

  it("collapses a span whose ends round to the same value", () => {
    assert.equal(formatActivitySpan(NOW - 3 * DAY, NOW - 3 * DAY - 2 * MIN, NOW), "3d ago");
  });

  it("spells out each end when one is an absolute date", () => {
    const span = formatActivitySpan(NOW - 10 * DAY, NOW - 4 * HOUR, NOW);
    assert.match(span, /^Jul \d+ to 4h ago$/);
  });

  it("is anchored to the passed instant, not wall-clock time", () => {
    // The export pins `now` to its snapshot instant; the same inputs must give
    // the same string tomorrow.
    const created = NOW - 3 * DAY;
    assert.equal(formatActivitySpan(created, null, NOW), "3d ago");
    // Four days later the same event is past the week boundary, so it becomes
    // an absolute date and loses the "ago" suffix.
    assert.equal(formatActivitySpan(created, null, NOW + 4 * DAY), "Jul 25");
  });
});

describe("formatCostTotals", () => {
  it("lists units side by side, never adding them", () => {
    assert.equal(
      formatCostTotals([{ unit: "USD", amount: 2433.74 }, { unit: "AIC", amount: 100.2 }]),
      "$2433.74 · 100.2 AIC",
    );
  });
  it("is null with nothing metered", () => {
    assert.equal(formatCostTotals([]), null);
    assert.equal(formatCostTotals(undefined), null);
  });
});

describe("formatCost", () => {
  it("renders USD to two decimals with a leading $", () => {
    assert.equal(formatCost(26.34, "USD"), "$26.34");
    assert.equal(formatCost(6.8, "USD"), "$6.80");
  });

  // Non-USD units group per the *runtime's* locale — `toLocaleString()` is
  // called without one, so a German viewer sees "1.200 AIC". That's deliberate
  // (the app renders for whoever is looking), which makes hardcoding "1,200
  // AIC" a test that fails on a German developer's laptop and passes in CI.
  // Assert the shape — grouped number, space, unit — not one locale's commas.
  it("renders any other unit as a grouped number plus the unit", () => {
    assert.equal(formatCost(1200, "AIC"), `${(1200).toLocaleString()} AIC`);
    assert.ok(/^1\D?200 AIC$/.test(formatCost(1200, "AIC")!), "thousands are grouped");
  });

  it("clamps a fractional non-USD amount to two decimals", () => {
    assert.equal(
      formatCost(1200.567, "AIC"),
      `${(1200.567).toLocaleString(undefined, { maximumFractionDigits: 2 })} AIC`,
    );
    // Whatever the separators, the fraction is two digits, not three.
    assert.match(formatCost(1200.567, "AIC")!, /^1\D?200\D57 AIC$/);
  });

  it("returns null when there is nothing to show", () => {
    assert.equal(formatCost(null, "USD"), null);
    assert.equal(formatCost(undefined, "USD"), null);
    assert.equal(formatCost(26.34, null), null);
    assert.equal(formatCost(26.34, ""), null);
  });

  it("keeps a genuine zero rather than treating it as absent", () => {
    assert.equal(formatCost(0, "USD"), "$0.00");
  });
});

describe("isSystemEvent", () => {
  it("is false for everything anyone actually said", () => {
    for (const t of ["narration", "human_signal", "agent_signal"]) {
      assert.equal(isSystemEvent(t), false, t);
    }
  });

  it("is true for the daemon's own lifecycle events", () => {
    for (const t of ["started", "restarted", "binding_rejected"]) {
      assert.equal(isSystemEvent(t), true, t);
    }
  });

  it("treats an unknown type as system — the safe default", () => {
    // A new lifecycle type should render as a system row on day one, not as
    // something an agent said.
    assert.equal(isSystemEvent("some_future_type"), true);
  });
});

describe("lifecycle lines", () => {
  // The line every narrative opens with, in the shape every writer shares:
  // verb, invocation as a code span, role as a /protocol.
  it("spawn: the operator's invocation and the role", () => {
    assert.equal(spawnedContent("claude", "worker"), "Spawned `claude` /worker");
    assert.equal(
      spawnedContent("claude", "worker", { args: ["--model", "opus-5", "--dangerously-skip-permissions"] }),
      "Spawned `claude --model opus-5 --dangerously-skip-permissions` /worker",
    );
  });

  it("twin: the predecessor stays a bare nid:seq so it linkifies", () => {
    assert.equal(
      spawnedContent("claude", "twin", { from: "claude-aaaaaaaa:42" }),
      "Spawned `claude` /twin from claude-aaaaaaaa:42",
    );
  });

  it("revive: same shape, flagged when the resume forked a live original", () => {
    assert.equal(revivedContent("claude", "worker"), "Revived `claude` /worker");
    assert.equal(
      revivedContent("claude", "keeper", ["--dangerously-skip-permissions"], true),
      "Revived `claude --dangerously-skip-permissions` /keeper (forked — original still live)",
    );
  });

  it("utility: the command is the whole line", () => {
    assert.equal(runningContent(["lazygit"]), "Running `lazygit`");
    assert.equal(restartedContent(["htop", "-d", "5"]), "Restarted `htop -d 5`");
  });

  it("quotes an argument the way a shell would want it typed", () => {
    assert.equal(formatInvocation(["codex", "-c", 'project_root_markers=[".git"]']), "`codex -c 'project_root_markers=[\".git\"]'`");
    assert.equal(formatInvocation(["sh", "-c", "echo it's"]), "`sh -c 'echo it'\\''s'`");
  });

  it("widens the code fence around a backtick instead of breaking it", () => {
    assert.equal(formatInvocation(["echo", "a`b"]), "`` echo 'a`b' ``");
  });
});

describe("formatSystemContent", () => {
  // Rows written before the invocation shape existed, brought up to it at
  // render time. Each is anchored to the whole line.
  it("rewrites a legacy spawn line: code-span the agent, slash the role", () => {
    assert.equal(formatSystemContent("Spawned claude (worker)"), "Spawned `claude` /worker");
  });

  it("accepts any role, not just the ones brane ships", () => {
    assert.equal(formatSystemContent("Spawned claude (haruspex)"), "Spawned `claude` /haruspex");
    assert.equal(formatSystemContent("Spawned claude (twin-2)"), "Spawned `claude` /twin-2");
  });

  it("rewrites the old twin back-pointer into a full spawn line, given the agent", () => {
    assert.equal(
      formatSystemContent("Twinned from claude-aaaaaaaa:42", "goose"),
      "Spawned `goose` /twin from claude-aaaaaaaa:42",
    );
    // The old line never recorded the agent; without one, the protocol alone.
    assert.equal(formatSystemContent("Twinned from claude-aaaaaaaa:42"), "/twin from claude-aaaaaaaa:42");
  });


  it("reads the agent off a spawned narrative id", () => {
    assert.equal(agentTypeOf("claude-rfhbth2v"), "claude");
    assert.equal(agentTypeOf("my-agent-0a1b2c3d"), "my-agent");
  });

  it("rewrites a legacy revive, keeping its parenthesised prose", () => {
    assert.equal(formatSystemContent("Revived claude session"), "Revived `claude`");
    assert.equal(
      formatSystemContent("Revived claude session (forked — original still live)"),
      "Revived `claude` (forked — original still live)",
    );
  });

  it("rewrites a legacy utility line", () => {
    assert.equal(formatSystemContent("Running lazygit"), "Running `lazygit`");
    assert.equal(formatSystemContent("Restarted htop -d 5"), "Restarted `htop -d 5`");
  });

  it("is idempotent: a line already in the new shape passes through", () => {
    for (const s of [
      spawnedContent("claude", "worker", { args: ["--model", "opus-5"] }),
      spawnedContent("claude", "twin", { from: "claude-aaaaaaaa:42" }),
      revivedContent("claude", "worker", [], true),
      runningContent(["lazygit"]),
    ]) {
      assert.equal(formatSystemContent(s, "goose"), s);
    }
  });

  it("only rewrites a whole line — prose that starts with a verb is left alone", () => {
    const s = "Spawned claude (worker) after a restart";
    assert.equal(formatSystemContent(s), s);
  });

  it("passes through content with no legacy shape", () => {
    assert.equal(formatSystemContent("Connected external MCP client"), "Connected external MCP client");
  });

  it("tolerates trailing whitespace", () => {
    assert.equal(formatSystemContent("Spawned claude (worker)  "), "Spawned `claude` /worker");
  });
});

describe("systemLine", () => {
  // The fold is a column on the narrative row and whether to show it is the
  // event type — neither is read out of the text.
  it("appends the row's fold to a started line as a brane://fold link", () => {
    assert.equal(
      systemLine({ type: "started", content: "Spawned `claude` /worker" }, { fold: "~/dev/brane" }),
      "Spawned `claude` /worker in [~/dev/brane](brane://fold/~/dev/brane)",
    );
    assert.equal(
      systemLine({ type: "started", content: "Running `lazygit`" }, { fold: "~/dev/brane" }),
      "Running `lazygit` in [~/dev/brane](brane://fold/~/dev/brane)",
    );
  });

  it("leaves a restarted line and a narrative without a fold alone", () => {
    assert.equal(
      systemLine({ type: "restarted", content: "Revived `claude` /worker" }, { fold: "~/dev/brane" }),
      "Revived `claude` /worker",
    );
    assert.equal(systemLine({ type: "started", content: "Connected external MCP client" }, {}), "Connected external MCP client");
  });

  it("normalizes a legacy line first, then appends the fold", () => {
    assert.equal(
      systemLine({ type: "started", content: "Twinned from claude-aaaaaaaa:42" }, { agent: "claude", fold: "~/dev/brane" }),
      "Spawned `claude` /twin from claude-aaaaaaaa:42 in [~/dev/brane](brane://fold/~/dev/brane)",
    );
  });

  it("drops a fold the interim writers baked in, by equality with the row's own", () => {
    assert.equal(
      systemLine({ type: "started", content: "Spawned `claude` /worker in ~/dev/brane" }, { fold: "~/dev/brane" }),
      "Spawned `claude` /worker in [~/dev/brane](brane://fold/~/dev/brane)",
    );
    // A different trailing path is content, not the baked fold.
    assert.equal(
      systemLine({ type: "started", content: "Spawned `claude` /worker in ~/dev/other" }, { fold: "~/dev/brane" }),
      "Spawned `claude` /worker in ~/dev/other in [~/dev/brane](brane://fold/~/dev/brane)",
    );
  });
});
