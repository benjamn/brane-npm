import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type Tab,
  CANONICAL_TABS,
  SHARED_SPA_HOST,
  isIsolatedHost,
  parseActiveTab,
  parsePinnedTabs,
  serializePinned,
  viewParams,
  parseLineSpec,
  buildIsolateUrl,
  buildMeldUrl,
  terminalOnlyHref,
  withoutConnectionHash,
  withoutConnectionParams,
  connectionFragment,
} from "../shared/view-url.js";

// These pin the URL contract that the Isolate menu item depends on. It opens
// the same narrative on the *other* origin — the shared SPA at brane.organelle.dev
// or a daemon's own bundle — and the tab layout and open file live in
// sessionStorage, which is origin-scoped. So the query string is the only thing
// that crosses, and every assertion below is really asking the same question:
// does the view you were looking at survive the hop?

const CONN = { host: "chalk.tail1234.ts.net", token: "tok-abc123" };
const NID = "claude-0b9okmy2";

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

interface ViewCase {
  tab: Tab;
  pins: Set<Tab>;
  path?: string;
  line?: number;
  lineEnd?: number;
}

const LINE_CASES: Array<{ line?: number; lineEnd?: number }> = [
  {},
  { line: 10 },
  { line: 10, lineEnd: 20 },
  { line: 10, lineEnd: 10 },  // degenerate range
  { line: 10, lineEnd: 5 },   // end before start
  { lineEnd: 20 },            // end with no start
];

const PATH_CASES: Array<string | undefined> = [
  undefined,
  "",
  "src/daemon/server.ts",
  "docs/a file with spaces.md",
  "wiki/why-tailscale.md",
];

/** The full grid: 3 tabs × 8 pin subsets × 5 paths × 6 line specs = 720. */
function viewCases(): ViewCase[] {
  const out: ViewCase[] = [];
  for (const tab of CANONICAL_TABS) {
    for (const pins of pinPowerset()) {
      for (const path of PATH_CASES) {
        for (const line of LINE_CASES) {
          out.push({ tab, pins, path, ...line });
        }
      }
    }
  }
  return out;
}

const CASES = viewCases();

function params(c: ViewCase): Record<string, string | undefined> {
  return viewParams(c.tab, c.pins, c.path, c.line, c.lineEnd);
}

/** How a case should read once it has been through a URL and back. */
function expectedLine(c: ViewCase): string | undefined {
  if (!c.line) return undefined;
  return c.lineEnd && c.lineEnd > c.line ? `${c.line}-${c.lineEnd}` : String(c.line);
}

function label(c: ViewCase): string {
  return `${c.tab} pins=[${serializePinned(c.pins) || "-"}] path=${c.path ?? "-"} line=${c.line ?? "-"}${c.lineEnd ? `-${c.lineEnd}` : ""}`;
}

describe("viewParams", () => {
  it("emits undefined for every default, never an empty string", () => {
    // undefined is what clears a param, both in router.setParams and in
    // buildIsolateUrl's overlay. "" would write `?tab=` and stick.
    const p = viewParams("chat", new Set());
    assert.deepEqual(p, { tab: undefined, pinned: undefined, path: undefined, line: undefined });
    for (const c of CASES) {
      for (const [key, value] of Object.entries(params(c))) {
        assert.notEqual(value, "", `${label(c)} → ${key} was empty string`);
      }
    }
  });

  it("omits the chat tab and names every other one", () => {
    for (const c of CASES) {
      assert.equal(params(c).tab, c.tab === "chat" ? undefined : c.tab, label(c));
    }
  });

  it("serializes pins in canonical order, whatever order they went in", () => {
    for (const c of CASES) {
      const p = params(c);
      if (c.pins.size === 0) {
        assert.equal(p.pinned, undefined, label(c));
        continue;
      }
      const expected = CANONICAL_TABS.filter((t) => c.pins.has(t)).join(",");
      assert.equal(p.pinned, expected, label(c));
      // Same pins added back-to-front produce the same string.
      const reversed = new Set([...c.pins].reverse());
      assert.equal(serializePinned(reversed), expected, label(c));
    }
  });

  it("carries a path only when there is one", () => {
    for (const c of CASES) {
      assert.equal(params(c).path, c.path ? c.path : undefined, label(c));
    }
  });

  it("writes a range only when the end is past the start", () => {
    for (const c of CASES) {
      assert.equal(params(c).line, expectedLine(c), label(c));
    }
    assert.equal(viewParams("files", new Set(), "a.ts", 10, 20).line, "10-20");
    assert.equal(viewParams("files", new Set(), "a.ts", 10, 10).line, "10");
    assert.equal(viewParams("files", new Set(), "a.ts", 10, 5).line, "10");
    assert.equal(viewParams("files", new Set(), "a.ts", undefined, 20).line, undefined);
  });

  it("round-trips through the parsers it is read back with", () => {
    for (const c of CASES) {
      const p = params(c);
      assert.equal(parseActiveTab(p.tab), c.tab, label(c));
      assert.deepEqual([...parsePinnedTabs(p.pinned)].sort(), [...c.pins].sort(), label(c));
      const spec = parseLineSpec(p.line);
      assert.equal(spec.line, c.line, label(c));
      // The one asymmetry, and it is deliberate: a range whose end equals its
      // start is written bare, so it reads back as a single line. Same lines.
      const expectedEnd = c.line && c.lineEnd && c.lineEnd > c.line ? c.lineEnd : undefined;
      assert.equal(spec.lineEnd, expectedEnd, label(c));
    }
  });
});

describe("parseActiveTab / parsePinnedTabs", () => {
  it("falls back to chat for anything unrecognized", () => {
    for (const bad of [undefined, "", "  ", "Chat", "wiki", "files,terminal", "0", "null"]) {
      assert.equal(parseActiveTab(bad), "chat", JSON.stringify(bad));
    }
    for (const tab of CANONICAL_TABS) assert.equal(parseActiveTab(tab), tab);
  });

  it("keeps the tabs it knows and drops the rest", () => {
    const cases: Array<[string | undefined, Tab[]]> = [
      [undefined, []],
      ["", []],
      ["files", ["files"]],
      ["files,terminal", ["files", "terminal"]],
      [" files , terminal ", ["files", "terminal"]],
      ["files,wiki,terminal", ["files", "terminal"]],
      ["wiki", []],
      ["files,files", ["files"]],
      ["chat,terminal,files", ["chat", "terminal", "files"]],
    ];
    for (const [input, expected] of cases) {
      assert.deepEqual(
        [...parsePinnedTabs(input)].sort(),
        [...expected].sort(),
        JSON.stringify(input),
      );
    }
  });
});

describe("isIsolatedHost", () => {
  it("treats only the shared SPA as un-isolated", () => {
    assert.equal(isIsolatedHost(SHARED_SPA_HOST), false);
    for (const host of ["chalk.tail1234.ts.net", "localhost", "127.0.0.1", "brane.example.com"]) {
      assert.equal(isIsolatedHost(host), true, host);
    }
  });
});

/** Parse a built URL back into something assertable. */
/** A built URL, taken apart the way the app takes it apart: `params` is the
 *  query string (the view), `conn` is the fragment (the connection). */
function open(url: string): { origin: string; pathname: string; params: URLSearchParams; conn: URLSearchParams } {
  const u = new URL(url);
  return { origin: u.origin, pathname: u.pathname, params: u.searchParams, conn: new URLSearchParams(u.hash.slice(1)) };
}

describe("withoutConnectionParams", () => {
  // The shared SPA cleans the meld params out of the URL once it has used
  // them. It used to do that by resetting to the bare pathname, which threw
  // away the view an Isolate hop had just carried across — so these are the
  // assertions that keep the cleaning surgical.
  it("drops the connection params and nothing else", () => {
    const cases: Array<[string, string]> = [
      ["?host=h:1&token=t", ""],
      ["?token=t", ""],
      ["?host=h:1", ""],
      ["", ""],
      ["?", ""],
      ["?tab=files&host=h:1&token=t", "?tab=files"],
      ["?host=h:1&tab=files&token=t&pinned=terminal", "?tab=files&pinned=terminal"],
      ["?scrollToSeq=42&token=t", "?scrollToSeq=42"],
      ["?tab=files&pinned=chat%2Cfiles&path=src%2Fa.ts&line=10-20",
       "?tab=files&pinned=chat%2Cfiles&path=src%2Fa.ts&line=10-20"],
      // No leading ? is fine, and the return value always has one when non-empty.
      ["tab=files&token=t", "?tab=files"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(withoutConnectionParams(input), expected, JSON.stringify(input));
    }
  });

  it("removes repeated connection params, not just the first", () => {
    assert.equal(withoutConnectionParams("?token=a&token=b&tab=files"), "?tab=files");
    assert.equal(withoutConnectionParams("?host=a&host=b"), "");
  });
});

describe("withoutConnectionHash", () => {
  // The fragment is where links carry the connection now, so the cleaner has
  // a fragment half. Same surgery: the connection goes, anything else stays.
  it("drops the connection params and nothing else", () => {
    const cases: Array<[string, string]> = [
      ["#host=h:1&token=t", ""],
      ["#token=t", ""],
      ["#host=h%3A1&token=t", ""],
      ["", ""],
      ["#", ""],
      ["#other=1&token=t", "#other=1"],
      ["host=h:1&token=t", ""],
      ["#token=a&token=b&x=1", "#x=1"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(withoutConnectionHash(input), expected, JSON.stringify(input));
    }
  });
});

describe("connectionFragment", () => {
  it("carries host and token for the shared SPA, token alone for a daemon's own bundle", () => {
    const shared = new URLSearchParams(connectionFragment(CONN, true).slice(1));
    assert.equal(shared.get("host"), CONN.host);
    assert.equal(shared.get("token"), CONN.token);
    const own = new URLSearchParams(connectionFragment(CONN, false).slice(1));
    assert.equal(own.get("host"), null);
    assert.equal(own.get("token"), CONN.token);
  });

  it("round-trips a host with a port through the fragment", () => {
    const conn = { host: "127.0.0.1:58353", token: "t" };
    const frag = connectionFragment(conn, true);
    assert.ok(frag.startsWith("#"));
    assert.equal(new URLSearchParams(frag.slice(1)).get("host"), conn.host);
  });

  it("is what the cleaner removes, leaving nothing", () => {
    assert.equal(withoutConnectionHash(connectionFragment(CONN, true)), "");
    assert.equal(withoutConnectionHash(connectionFragment(CONN, false)), "");
  });

  it("leaves a view intact all the way from Isolate to the cleaned URL", () => {
    // The end-to-end shape: build the hop, then clean it the way the SPA does
    // on arrival. What's left is the view, and only the view.
    for (const c of CASES) {
      const view = params(c);
      const url = new URL(buildIsolateUrl({
        hostname: CONN.host,
        protocol: "https:",
        search: "?scrollToSeq=42",
        path: `/${NID}`,
        conn: CONN,
        view,
      }));
      const cleaned = new URLSearchParams(withoutConnectionParams(url.search));
      assert.equal(cleaned.get("token"), null, label(c));
      assert.equal(cleaned.get("host"), null, label(c));
      assert.equal(withoutConnectionHash(url.hash), "", label(c));
      // The query string never carried the connection in the first place.
      assert.equal(url.searchParams.get("token"), null, label(c));
      assert.equal(url.searchParams.get("host"), null, label(c));
      assert.equal(cleaned.get("scrollToSeq"), "42", label(c));
      for (const key of ["tab", "pinned", "path", "line"]) {
        assert.equal(cleaned.get(key), view[key] ?? null, `${label(c)} → ${key}`);
      }
    }
  });
});

describe("buildIsolateUrl", () => {
  it("targets the shared SPA when leaving a daemon, and melds it back", () => {
    const { origin, pathname, params, conn } = open(buildIsolateUrl({
      hostname: CONN.host,
      protocol: "https:",
      search: "?token=old-token",
      path: `/${NID}`,
      conn: CONN,
      view: viewParams("files", new Set(["terminal"]), "src/cli.ts", 4, 9),
    }));
    assert.equal(origin, `https://${SHARED_SPA_HOST}`);
    assert.equal(pathname, `/${NID}`);
    // The connection rides in the fragment, never the query string: a query
    // string is sent to the SPA's host, a fragment is not.
    assert.equal(conn.get("host"), CONN.host);
    assert.equal(conn.get("token"), CONN.token);
    assert.equal(params.get("host"), null);
    assert.equal(params.get("token"), null);
    assert.equal(params.get("tab"), "files");
    assert.equal(params.get("pinned"), "terminal");
    assert.equal(params.get("path"), "src/cli.ts");
    assert.equal(params.get("line"), "4-9");
  });

  it("targets the daemon's own bundle when leaving the SPA, with no host param", () => {
    const { origin, pathname, params, conn } = open(buildIsolateUrl({
      hostname: SHARED_SPA_HOST,
      protocol: "https:",
      search: `?host=${CONN.host}&token=${CONN.token}`,
      path: `/${NID}`,
      conn: CONN,
      view: viewParams("terminal", new Set(["chat"])),
    }));
    assert.equal(origin, `https://${CONN.host}`);
    assert.equal(pathname, `/${NID}`);
    // The daemon's own bundle knows which daemon it is; host would be noise.
    assert.equal(conn.get("host"), null);
    assert.equal(conn.get("token"), CONN.token);
    assert.equal(params.get("token"), null);
    assert.equal(params.get("tab"), "terminal");
    assert.equal(params.get("pinned"), "chat");
  });

  it("follows the page's scheme to the daemon, so plain http stays http", () => {
    for (const [protocol, scheme] of [["https:", "https"], ["http:", "http"]] as const) {
      const { origin } = open(buildIsolateUrl({
        hostname: SHARED_SPA_HOST,
        protocol,
        search: "",
        path: `/${NID}`,
        conn: CONN,
        view: viewParams("chat", new Set()),
      }));
      assert.equal(origin, `${scheme}://${CONN.host}`, protocol);
    }
    // The shared SPA is https-only, whatever the page you left was served over.
    const { origin } = open(buildIsolateUrl({
      hostname: "localhost",
      protocol: "http:",
      search: "",
      path: `/${NID}`,
      conn: CONN,
      view: viewParams("chat", new Set()),
    }));
    assert.equal(origin, `https://${SHARED_SPA_HOST}`);
  });

  it("never carries the departing origin's credentials", () => {
    // A stale host/token in the search string is the danger case: the SPA's
    // meld params must not follow you onto the daemon's own origin, where the
    // host is wrong and the URL would carry a second copy of the token.
    for (const hostname of [SHARED_SPA_HOST, CONN.host]) {
      const { params, conn } = open(buildIsolateUrl({
        hostname,
        protocol: "https:",
        search: "?host=stale.example.com&token=stale-token&tab=files",
        path: `/${NID}`,
        conn: CONN,
        view: viewParams("files", new Set()),
      }));
      assert.deepEqual(params.getAll("host"), [], hostname);
      assert.deepEqual(params.getAll("token"), [], hostname);
      assert.notEqual(conn.get("host"), "stale.example.com", hostname);
      assert.deepEqual(conn.getAll("token"), [CONN.token], hostname);
    }
  });

  it("keeps params it doesn't model, like the scroll target", () => {
    const { params } = open(buildIsolateUrl({
      hostname: SHARED_SPA_HOST,
      protocol: "https:",
      search: "?scrollToSeq=42&scrollTo=1787255699631&theme=dark",
      path: `/${NID}`,
      conn: CONN,
      view: viewParams("chat", new Set()),
    }));
    assert.equal(params.get("scrollToSeq"), "42");
    assert.equal(params.get("scrollTo"), "1787255699631");
    assert.equal(params.get("theme"), "dark");
  });

  it("lets live state overwrite a stale param in the search string", () => {
    // This is why the URL alone isn't enough: what's in the address bar can be
    // older than what you're looking at.
    const { params } = open(buildIsolateUrl({
      hostname: SHARED_SPA_HOST,
      protocol: "https:",
      search: "?tab=chat&pinned=chat&path=old/file.ts&line=1",
      path: `/${NID}`,
      conn: CONN,
      view: viewParams("files", new Set(["terminal", "files"]), "new/file.ts", 30, 40),
    }));
    assert.equal(params.get("tab"), "files");
    assert.equal(params.get("pinned"), "terminal,files");
    assert.equal(params.get("path"), "new/file.ts");
    assert.equal(params.get("line"), "30-40");
  });

  it("lets live state at its default clear a stale param", () => {
    const { params } = open(buildIsolateUrl({
      hostname: SHARED_SPA_HOST,
      protocol: "https:",
      search: "?tab=files&pinned=terminal&path=old/file.ts&line=1-9",
      path: `/${NID}`,
      conn: CONN,
      view: viewParams("chat", new Set()),
    }));
    for (const key of ["tab", "pinned", "path", "line"]) {
      assert.equal(params.get(key), null, key);
    }
  });

  it("carries the layout a sessionStorage restore left out of the URL", () => {
    // The restore path deliberately skips router.setParams, so this is the
    // case the whole overlay exists for: an empty search string, a full view.
    const { params } = open(buildIsolateUrl({
      hostname: SHARED_SPA_HOST,
      protocol: "https:",
      search: "",
      path: `/${NID}`,
      conn: CONN,
      view: viewParams("files", new Set(["chat", "files"]), "src/shared/view-url.ts", 12),
    }));
    assert.equal(params.get("tab"), "files");
    assert.equal(params.get("pinned"), "chat,files");
    assert.equal(params.get("path"), "src/shared/view-url.ts");
    assert.equal(params.get("line"), "12");
  });

  it("accepts a search string with or without its leading ?", () => {
    const view = viewParams("files", new Set(), "a.ts");
    const withQ = open(buildIsolateUrl({ hostname: SHARED_SPA_HOST, protocol: "https:", search: "?scrollToSeq=7", path: `/${NID}`, conn: CONN, view }));
    const without = open(buildIsolateUrl({ hostname: SHARED_SPA_HOST, protocol: "https:", search: "scrollToSeq=7", path: `/${NID}`, conn: CONN, view }));
    assert.equal(withQ.params.get("scrollToSeq"), "7");
    assert.deepEqual([...withQ.params], [...without.params]);
  });

  it("encodes paths that would otherwise break the URL", () => {
    for (const path of ["docs/a file with spaces.md", "src/c#sharp.ts", "a/b/c/d.ts", "notes/100% done.md", "x?y=z.ts", "π/unicode.ts"]) {
      const url = buildIsolateUrl({
        hostname: SHARED_SPA_HOST,
        protocol: "https:",
        search: "",
        path: `/${NID}`,
        conn: CONN,
        view: viewParams("files", new Set(), path),
      });
      assert.equal(open(url).params.get("path"), path, path);
    }
  });

  it("preserves every view in the grid, in both directions", () => {
    for (const c of CASES) {
      const view = params(c);
      for (const hostname of [SHARED_SPA_HOST, CONN.host]) {
        const { params: got, conn } = open(buildIsolateUrl({
          hostname, protocol: "https:", search: "", path: `/${NID}`, conn: CONN, view,
        }));
        assert.equal(got.get("tab"), view.tab ?? null, label(c));
        assert.equal(got.get("pinned"), view.pinned ?? null, label(c));
        assert.equal(got.get("path"), view.path ?? null, label(c));
        assert.equal(got.get("line"), view.line ?? null, label(c));
        assert.equal(conn.get("token"), CONN.token, label(c));
        assert.equal(got.get("token"), null, label(c));
      }
    }
  });

  it("round-trips: isolate, unisolate, and you are where you started", () => {
    // The invariant behind both halves of the menu item. Leave the SPA, come
    // back, and the view — plus the scroll target the screen doesn't model —
    // is intact.
    for (const c of CASES) {
      const view = params(c);
      const out = new URL(buildIsolateUrl({
        hostname: SHARED_SPA_HOST,
        protocol: "https:",
        search: "?scrollToSeq=42",
        path: `/${NID}`,
        conn: CONN,
        view,
      }));
      const back = new URL(buildIsolateUrl({
        hostname: out.hostname,
        protocol: out.protocol,
        search: out.search,
        path: `/${NID}`,
        conn: CONN,
        // Re-derived on the far side from the params it was handed, exactly as
        // the screen does when it mounts.
        view: viewParams(
          parseActiveTab(out.searchParams.get("tab") ?? undefined),
          parsePinnedTabs(out.searchParams.get("pinned") ?? undefined),
          out.searchParams.get("path") ?? undefined,
          parseLineSpec(out.searchParams.get("line")).line,
          parseLineSpec(out.searchParams.get("line")).lineEnd,
        ),
      }));
      assert.equal(back.origin, `https://${SHARED_SPA_HOST}`, label(c));
      assert.equal(back.pathname, `/${NID}`, label(c));
      assert.equal(back.searchParams.get("scrollToSeq"), "42", label(c));
      const conn = new URLSearchParams(back.hash.slice(1));
      assert.equal(conn.get("host"), CONN.host, label(c));
      assert.equal(conn.get("token"), CONN.token, label(c));
      assert.equal(back.searchParams.get("host"), null, label(c));
      assert.equal(back.searchParams.get("token"), null, label(c));
      for (const key of ["tab", "pinned", "path", "line"]) {
        assert.equal(back.searchParams.get(key), view[key] ?? null, `${label(c)} → ${key}`);
      }
    }
  });
});

describe("buildMeldUrl", () => {
  // Meld aims at another device, not another origin. Isolate flips the origin
  // kind; this has to stay on it — hand a phone a shared-SPA link when the
  // operator is reaching the daemon directly and the phone loads an app that
  // has never heard of that daemon.
  it("stays on the shared SPA when that's where you are", () => {
    const url = new URL(buildMeldUrl({
      hostname: SHARED_SPA_HOST,
      protocol: "https:",
      search: "",
      path: `/${NID}`,
      conn: CONN,
      view: viewParams("files", new Set(["terminal"]), "src/cli.ts", 4, 9),
    }));
    assert.equal(url.origin, `https://${SHARED_SPA_HOST}`);
    assert.equal(url.pathname, `/${NID}`);
    // The scanning device has never met this daemon, so it needs both — in
    // the fragment, which the QR carries and no server ever receives.
    const conn = new URLSearchParams(url.hash.slice(1));
    assert.equal(conn.get("host"), CONN.host);
    assert.equal(conn.get("token"), CONN.token);
    assert.equal(url.searchParams.get("host"), null);
    assert.equal(url.searchParams.get("token"), null);
    assert.equal(url.searchParams.get("tab"), "files");
    assert.equal(url.searchParams.get("pinned"), "terminal");
    assert.equal(url.searchParams.get("path"), "src/cli.ts");
    assert.equal(url.searchParams.get("line"), "4-9");
  });

  it("stays on the daemon's own bundle when that's where you are", () => {
    const url = new URL(buildMeldUrl({
      hostname: CONN.host,
      protocol: "https:",
      search: "",
      path: `/${NID}`,
      conn: CONN,
      view: viewParams("terminal", new Set()),
    }));
    assert.equal(url.origin, `https://${CONN.host}`);
    const conn = new URLSearchParams(url.hash.slice(1));
    assert.equal(conn.get("host"), null);
    assert.equal(conn.get("token"), CONN.token);
    assert.equal(url.searchParams.get("token"), null);
    assert.equal(url.searchParams.get("tab"), "terminal");
  });

  it("goes the opposite way from Isolate, from either origin", () => {
    // The whole difference between the two menu items, stated once.
    for (const hostname of [SHARED_SPA_HOST, CONN.host]) {
      const opts = {
        hostname,
        protocol: "https:",
        search: "",
        path: `/${NID}`,
        conn: CONN,
        view: viewParams("chat", new Set()),
      };
      const meld = new URL(buildMeldUrl(opts));
      const isolate = new URL(buildIsolateUrl(opts));
      assert.equal(meld.hostname, hostname, `meld stays put from ${hostname}`);
      assert.notEqual(isolate.hostname, hostname, `isolate flips from ${hostname}`);
    }
  });

  it("carries the same view Isolate would, over the whole grid", () => {
    for (const c of CASES) {
      const view = params(c);
      for (const hostname of [SHARED_SPA_HOST, CONN.host]) {
        const url = new URL(buildMeldUrl({
          hostname, protocol: "https:", search: "?scrollToSeq=42", path: `/${NID}`, conn: CONN, view,
        }));
        assert.equal(url.searchParams.get("scrollToSeq"), "42", label(c));
        assert.equal(new URLSearchParams(url.hash.slice(1)).get("token"), CONN.token, label(c));
        assert.equal(url.searchParams.get("token"), null, label(c));
        for (const key of ["tab", "pinned", "path", "line"]) {
          assert.equal(url.searchParams.get(key), view[key] ?? null, `${label(c)} -> ${key}`);
        }
      }
    }
  });

  it("hands out an http link when the page itself is http", () => {
    // A LAN session without TLS must not emit https links the phone can't load.
    const url = new URL(buildMeldUrl({
      hostname: "192.168.1.20:7777",
      protocol: "http:",
      search: "",
      path: `/${NID}`,
      conn: { host: "192.168.1.20:7777", token: CONN.token },
      view: viewParams("chat", new Set()),
    }));
    assert.equal(url.protocol, "http:");
  });
});

describe("terminalOnlyHref", () => {
  it("names the terminal and pins nothing", () => {
    const url = new URL(terminalOnlyHref(NID), "https://example.test");
    assert.equal(url.pathname, `/${NID}`);
    assert.equal(url.searchParams.get("tab"), "terminal");
    assert.equal(url.searchParams.get("pinned"), null);
    assert.equal(url.searchParams.get("path"), null);
    assert.equal(url.searchParams.get("line"), null);
  });

  it("reads back as terminal-only through the same parsers the screen uses", () => {
    // The point of the href is the view it produces, so assert the round trip
    // rather than the string: a `tab` param the screen wouldn't parse back to
    // "terminal" would land a revive or an End in the chat tab, silently.
    const url = new URL(terminalOnlyHref(NID), "https://example.test");
    assert.equal(parseActiveTab(url.searchParams.get("tab") ?? undefined), "terminal");
    assert.equal(parsePinnedTabs(url.searchParams.get("pinned") ?? undefined).size, 0);
  });
});
