import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type Tab,
  CANONICAL_TABS,
  isIsolated,
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
  withDaemonFragment,
  daemonFromHash,
  activeDaemonBraneId,
  daemonToAdopt,
} from "../shared/view-url.js";

// These pin the URL contract that the Isolate menu item depends on. It opens
// the same narrative on the *other* origin — a shared app, or a daemon's own
// bundle — and the tab layout and open file live in sessionStorage, which is
// origin-scoped. So the query string is the only thing that crosses, and every
// assertion below is really asking the same question: does the view you were
// looking at survive the hop?
//
// The app carries no host of its own: "isolated" is `location.host` equal to
// the connection's host, and the way out of a daemon's bundle is whatever the
// daemon reports as its app host. So the shared host here is deliberately not
// brane's; any host serving the bundle is a shared app.

const CONN = { host: "chalk.tail1234.ts.net", token: "tok-abc123" };
const NID = "claude-0b9okmy2";
/** The page's host while on a shared app. */
const SHARED_SPA_HOST = "shell.example.test";
/** What the daemon reports as its `app_domain`: where a daemon's own bundle
 *  hops out to, which need not be the shared app the operator came from. */
const APP_HOST = "app.example.test";

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

describe("isIsolated", () => {
  it("is true only when the page is served by the daemon it is connected to", () => {
    assert.equal(isIsolated(CONN.host, CONN.host), true);
    assert.equal(isIsolated("CHALK.tail1234.TS.NET", CONN.host), true, "hosts are case-insensitive");
    for (const host of [SHARED_SPA_HOST, "brane.organelle.dev", "main.brane.organelle.dev", "localhost:8081", "127.0.0.1:8081"]) {
      assert.equal(isIsolated(host, CONN.host), false, host);
    }
  });

  it("counts the port: a daemon's bundle is reached on its port", () => {
    assert.equal(isIsolated("192.168.1.20:7777", "192.168.1.20:7777"), true);
    assert.equal(isIsolated("192.168.1.20:7777", "192.168.1.20:8888"), false);
    assert.equal(isIsolated("192.168.1.20", "192.168.1.20:7777"), false);
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
      // `daemon` names which daemon too, so it is consumed like the token.
      ["#daemon=brane-f66d2b", ""],
      ["#host=h:1&daemon=brane-f66d2b&token=t&x=1", "#x=1"],
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
        host: CONN.host,
        appHost: APP_HOST,
        protocol: "https:",
        search: "?scrollToSeq=42",
        path: `/${NID}`,
        conn: CONN,
        view,
      })!);
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
      host: CONN.host,
        appHost: APP_HOST,
      protocol: "https:",
      search: "?token=old-token",
      path: `/${NID}`,
      conn: CONN,
      view: viewParams("files", new Set(["terminal"]), "src/cli.ts", 4, 9),
    })!);
    // Out of a daemon's bundle, the target is what the daemon reported, not
    // any host the app knows.
    assert.equal(origin, `https://${APP_HOST}`);
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
      host: SHARED_SPA_HOST,
      protocol: "https:",
      search: `?host=${CONN.host}&token=${CONN.token}`,
      path: `/${NID}`,
      conn: CONN,
      view: viewParams("terminal", new Set(["chat"])),
    })!);
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
        host: SHARED_SPA_HOST,
        protocol,
        search: "",
        path: `/${NID}`,
        conn: CONN,
        view: viewParams("chat", new Set()),
      })!);
      assert.equal(origin, `${scheme}://${CONN.host}`, protocol);
    }
    // The hosted shell is https-only, whatever the daemon's bundle you left
    // was served over (a LAN session is plain http).
    const { origin } = open(buildIsolateUrl({
      host: "192.168.1.20:7777",
      protocol: "http:",
      search: "",
      path: `/${NID}`,
      conn: { host: "192.168.1.20:7777", token: CONN.token },
      appHost: APP_HOST,
      view: viewParams("chat", new Set()),
    })!);
    assert.equal(origin, `https://${APP_HOST}`);
  });

  it("has nowhere to go from a daemon's bundle that reported no app host, and says so", () => {
    // A daemon from before `app_domain` rode in /api/status, or one the
    // status probe could not reach: the menu hides Isolate rather than
    // handing out a link to a host the app made up.
    for (const appHost of [undefined, null, ""]) {
      assert.equal(
        buildIsolateUrl({ host: CONN.host, protocol: "https:", search: "", path: `/${NID}`, conn: CONN, appHost, view: {} }),
        null,
        String(appHost),
      );
    }
    // From a shared app the way *in* needs no app host at all.
    assert.ok(buildIsolateUrl({ host: SHARED_SPA_HOST, protocol: "https:", search: "", path: `/${NID}`, conn: CONN, view: {} }));
  });

  it("treats any host serving the bundle as a shared app, and hops in to the daemon from it", () => {
    for (const host of ["brane.organelle.dev", "main.brane.organelle.dev", "fork.example", "localhost:8081"]) {
      const { origin, conn } = open(buildIsolateUrl({ host, protocol: "https:", search: "", path: `/${NID}`, conn: CONN, view: {} })!);
      assert.equal(origin, `https://${CONN.host}`, host);
      assert.equal(conn.get("host"), null, host);
    }
  });

  it("never carries the departing origin's credentials", () => {
    // A stale host/token in the search string is the danger case: the SPA's
    // meld params must not follow you onto the daemon's own origin, where the
    // host is wrong and the URL would carry a second copy of the token.
    for (const host of [SHARED_SPA_HOST, CONN.host]) {
      const { params, conn } = open(buildIsolateUrl({
        host,
        appHost: APP_HOST,
        protocol: "https:",
        search: "?host=stale.example.com&token=stale-token&tab=files",
        path: `/${NID}`,
        conn: CONN,
        view: viewParams("files", new Set()),
      })!);
      assert.deepEqual(params.getAll("host"), [], host);
      assert.deepEqual(params.getAll("token"), [], host);
      assert.notEqual(conn.get("host"), "stale.example.com", host);
      assert.deepEqual(conn.getAll("token"), [CONN.token], host);
    }
  });

  it("keeps params it doesn't model, like the scroll target", () => {
    const { params } = open(buildIsolateUrl({
      host: SHARED_SPA_HOST,
      protocol: "https:",
      search: "?scrollToSeq=42&scrollTo=1787255699631&theme=dark",
      path: `/${NID}`,
      conn: CONN,
      view: viewParams("chat", new Set()),
    })!);
    assert.equal(params.get("scrollToSeq"), "42");
    assert.equal(params.get("scrollTo"), "1787255699631");
    assert.equal(params.get("theme"), "dark");
  });

  it("lets live state overwrite a stale param in the search string", () => {
    // This is why the URL alone isn't enough: what's in the address bar can be
    // older than what you're looking at.
    const { params } = open(buildIsolateUrl({
      host: SHARED_SPA_HOST,
      protocol: "https:",
      search: "?tab=chat&pinned=chat&path=old/file.ts&line=1",
      path: `/${NID}`,
      conn: CONN,
      view: viewParams("files", new Set(["terminal", "files"]), "new/file.ts", 30, 40),
    })!);
    assert.equal(params.get("tab"), "files");
    assert.equal(params.get("pinned"), "terminal,files");
    assert.equal(params.get("path"), "new/file.ts");
    assert.equal(params.get("line"), "30-40");
  });

  it("lets live state at its default clear a stale param", () => {
    const { params } = open(buildIsolateUrl({
      host: SHARED_SPA_HOST,
      protocol: "https:",
      search: "?tab=files&pinned=terminal&path=old/file.ts&line=1-9",
      path: `/${NID}`,
      conn: CONN,
      view: viewParams("chat", new Set()),
    })!);
    for (const key of ["tab", "pinned", "path", "line"]) {
      assert.equal(params.get(key), null, key);
    }
  });

  it("carries the layout a sessionStorage restore left out of the URL", () => {
    // The restore path deliberately skips router.setParams, so this is the
    // case the whole overlay exists for: an empty search string, a full view.
    const { params } = open(buildIsolateUrl({
      host: SHARED_SPA_HOST,
      protocol: "https:",
      search: "",
      path: `/${NID}`,
      conn: CONN,
      view: viewParams("files", new Set(["chat", "files"]), "src/shared/view-url.ts", 12),
    })!);
    assert.equal(params.get("tab"), "files");
    assert.equal(params.get("pinned"), "chat,files");
    assert.equal(params.get("path"), "src/shared/view-url.ts");
    assert.equal(params.get("line"), "12");
  });

  it("accepts a search string with or without its leading ?", () => {
    const view = viewParams("files", new Set(), "a.ts");
    const withQ = open(buildIsolateUrl({ host: SHARED_SPA_HOST, protocol: "https:", search: "?scrollToSeq=7", path: `/${NID}`, conn: CONN, view })!);
    const without = open(buildIsolateUrl({ host: SHARED_SPA_HOST, protocol: "https:", search: "scrollToSeq=7", path: `/${NID}`, conn: CONN, view })!);
    assert.equal(withQ.params.get("scrollToSeq"), "7");
    assert.deepEqual([...withQ.params], [...without.params]);
  });

  it("encodes paths that would otherwise break the URL", () => {
    for (const path of ["docs/a file with spaces.md", "src/c#sharp.ts", "a/b/c/d.ts", "notes/100% done.md", "x?y=z.ts", "π/unicode.ts"]) {
      const url = buildIsolateUrl({
        host: SHARED_SPA_HOST,
        protocol: "https:",
        search: "",
        path: `/${NID}`,
        conn: CONN,
        view: viewParams("files", new Set(), path),
      })!;
      assert.equal(open(url!).params.get("path"), path, path);
    }
  });

  it("preserves every view in the grid, in both directions", () => {
    for (const c of CASES) {
      const view = params(c);
      for (const host of [SHARED_SPA_HOST, CONN.host]) {
        const { params: got, conn } = open(buildIsolateUrl({
          host, appHost: APP_HOST, protocol: "https:", search: "", path: `/${NID}`, conn: CONN, view,
        })!);
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
        host: SHARED_SPA_HOST,
        protocol: "https:",
        search: "?scrollToSeq=42",
        path: `/${NID}`,
        conn: CONN,
        view,
      })!);
      const back = new URL(buildIsolateUrl({
        host: out.host,
        protocol: out.protocol,
        // The daemon's bundle is told where out is, as /api/status would.
        appHost: APP_HOST,
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
      })!);
      // Back out lands where the daemon says, which is the page we left only
      // if its app_domain names it; here it names APP_HOST.
      assert.equal(back.origin, `https://${APP_HOST}`, label(c));
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
      host: SHARED_SPA_HOST,
      protocol: "https:",
      search: "",
      path: `/${NID}`,
      conn: CONN,
      view: viewParams("files", new Set(["terminal"]), "src/cli.ts", 4, 9),
    })!);
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
      host: CONN.host,
        appHost: APP_HOST,
      protocol: "https:",
      search: "",
      path: `/${NID}`,
      conn: CONN,
      view: viewParams("terminal", new Set()),
    })!);
    assert.equal(url.origin, `https://${CONN.host}`);
    const conn = new URLSearchParams(url.hash.slice(1));
    assert.equal(conn.get("host"), null);
    assert.equal(conn.get("token"), CONN.token);
    assert.equal(url.searchParams.get("token"), null);
    assert.equal(url.searchParams.get("tab"), "terminal");
  });

  it("goes the opposite way from Isolate, from either origin", () => {
    // The whole difference between the two menu items, stated once.
    for (const host of [SHARED_SPA_HOST, CONN.host]) {
      const opts = {
        host,
        appHost: APP_HOST,
        protocol: "https:",
        search: "",
        path: `/${NID}`,
        conn: CONN,
        view: viewParams("chat", new Set()),
      };
      const meld = new URL(buildMeldUrl(opts));
      const isolate = new URL(buildIsolateUrl(opts)!);
      assert.equal(meld.host, host, `meld stays put from ${host}`);
      assert.notEqual(isolate.host, host, `isolate flips from ${host}`);
    }
  });

  it("carries the same view Isolate would, over the whole grid", () => {
    for (const c of CASES) {
      const view = params(c);
      for (const host of [SHARED_SPA_HOST, CONN.host]) {
        const url = new URL(buildMeldUrl({
          host, appHost: APP_HOST, protocol: "https:", search: "?scrollToSeq=42", path: `/${NID}`, conn: CONN, view,
        })!);
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
      host: "192.168.1.20:7777",
      protocol: "http:",
      search: "",
      path: `/${NID}`,
      conn: { host: "192.168.1.20:7777", token: CONN.token },
      view: viewParams("chat", new Set()),
    })!);
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

describe("withDaemonFragment", () => {
  // A link opened in a new tab arrives with no active daemon in that tab's
  // sessionStorage; the fragment is how it finds the one the link was written
  // from. So the question each case asks: is the daemon named, in the
  // fragment, and is the view the href's query already described left exactly
  // as it was?
  const BRANE = "brane-f66d2b";

  it("names the daemon in the fragment of a bare path", () => {
    assert.equal(withDaemonFragment("/", BRANE), `/#daemon=${BRANE}`);
    assert.equal(withDaemonFragment(`/${NID}`, BRANE), `/${NID}#daemon=${BRANE}`);
  });

  it("leaves the query, the view, exactly as it was", () => {
    const href = `/${NID}?tab=files&path=src%2Fa.ts&line=10-20`;
    const url = new URL(withDaemonFragment(href, BRANE), "https://example.test");
    assert.equal(url.pathname + url.search, href);
    assert.equal(url.searchParams.get("daemon"), null);
    assert.equal(daemonFromHash(url.hash), BRANE);
  });

  it("replaces a daemon already there, and keeps any other fragment param", () => {
    const url = new URL(withDaemonFragment(`/${NID}?scrollToSeq=4#x=1&daemon=old`, BRANE), "https://example.test");
    const frag = new URLSearchParams(url.hash.slice(1));
    assert.deepEqual(frag.getAll("daemon"), [BRANE]);
    assert.equal(frag.get("x"), "1");
    assert.equal(url.searchParams.get("scrollToSeq"), "4");
  });

  it("returns the href unchanged when the daemon is not known", () => {
    for (const none of [null, undefined, ""]) {
      assert.equal(withDaemonFragment(`/${NID}?scrollToSeq=4`, none), `/${NID}?scrollToSeq=4`);
    }
  });

  it("reads back through daemonFromHash, and is what the fragment cleaner removes", () => {
    const url = new URL(withDaemonFragment(`/${NID}?scrollToSeq=4`, BRANE), "https://example.test");
    assert.equal(daemonFromHash(url.hash), BRANE);
    assert.equal(daemonFromHash(url.hash.slice(1)), BRANE);
    assert.equal(withoutConnectionHash(url.hash), "");
    assert.equal(withoutConnectionParams(url.search), "?scrollToSeq=4");
  });

  it("is absent from daemonFromHash when missing or empty", () => {
    assert.equal(daemonFromHash(""), null);
    assert.equal(daemonFromHash("#"), null);
    assert.equal(daemonFromHash("#daemon="), null);
    assert.equal(daemonFromHash("#token=t"), null);
  });

  it("is not carried by Isolate or Meld, whose token already names the daemon", () => {
    // Isolate and Meld seed from the page's search string; a stray `daemon`
    // there (an old link) must not ride along in either half of the URL.
    const opts = {
      host: SHARED_SPA_HOST,
      protocol: "https:",
      search: `?scrollToSeq=4&daemon=${BRANE}`,
      path: `/${NID}`,
      conn: CONN,
      view: viewParams("chat", new Set()),
    };
    for (const built of [buildIsolateUrl(opts)!, buildMeldUrl(opts)]) {
      const { params, conn } = open(built);
      assert.equal(params.get("daemon"), null, built);
      assert.equal(conn.get("daemon"), null, built);
      assert.equal(params.get("scrollToSeq"), "4", built);
      assert.equal(conn.get("token"), CONN.token, built);
    }
  });
});

describe("the daemon a tab names, and the one it adopts", () => {
  // The registry entries these read, as `expo/lib/registry.ts` stores them:
  // `id` is the display key the tab's slot holds, `brane_id` what a link names.
  const CHALK = { id: "ben@chalk", brane_id: "brane-aaaaaa" };
  const SLATE = { id: "ben@slate", brane_id: "brane-bbbbbb" };
  const BOTH = [CHALK, SLATE];

  it("a link names the tab's active daemon", () => {
    assert.equal(activeDaemonBraneId(BOTH, SLATE.id), SLATE.brane_id);
    assert.equal(activeDaemonBraneId(BOTH, CHALK.id), CHALK.brane_id);
  });

  it("falls back to the first entry when the active id is missing or stale, as the layout connects", () => {
    assert.equal(activeDaemonBraneId(BOTH, null), CHALK.brane_id);
    assert.equal(activeDaemonBraneId(BOTH, "ben@gone"), CHALK.brane_id);
  });

  it("names nothing with nothing melded, so the link stays bare", () => {
    assert.equal(activeDaemonBraneId([], null), null);
    assert.equal(withDaemonFragment("/", activeDaemonBraneId([], null)), "/");
  });

  it("a new tab, whose slot is empty, adopts the daemon its link named", () => {
    assert.equal(daemonToAdopt(BOTH, null, SLATE.brane_id), SLATE.id);
  });

  it("a tab that already has a daemon keeps it, so a reload never undoes a switch", () => {
    // The router restores the initial fragment on its first URL write, so a
    // tab opened on SLATE and later switched to CHALK can still say SLATE.
    assert.equal(daemonToAdopt(BOTH, CHALK.id, SLATE.brane_id), null);
    assert.equal(daemonToAdopt(BOTH, SLATE.id, SLATE.brane_id), null);
  });

  it("a daemon this browser has not melded is no instruction at all", () => {
    assert.equal(daemonToAdopt(BOTH, null, "brane-cccccc"), null);
    assert.equal(daemonToAdopt([], null, SLATE.brane_id), null);
  });

  it("round-trips: what one tab names, a fresh tab adopts", () => {
    for (const from of BOTH) {
      const href = withDaemonFragment(`/${NID}`, activeDaemonBraneId(BOTH, from.id));
      const named = daemonFromHash(new URL(href, "https://example.test").hash)!;
      assert.equal(daemonToAdopt(BOTH, null, named), from.id);
    }
  });
});
