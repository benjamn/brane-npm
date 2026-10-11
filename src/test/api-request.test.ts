import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DEFAULT_TIMEOUT_MS,
  JSON_HEADERS,
  MAX_ATTEMPTS,
  NO_HEADERS,
  isRetryableError,
  isRetryableMethod,
  requiresPreflight,
  retryDelayMs,
  withToken,
} from "../shared/api-request.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("requiresPreflight", () => {
  test("a bare GET is simple — the case the whole design turns on", () => {
    assert.equal(requiresPreflight("GET", NO_HEADERS), false);
    assert.equal(requiresPreflight("GET"), false);
  });

  test("an Authorization header forces a preflight", () => {
    // This is the regression. It is why the token rides in the query string:
    // on a LAN this header costs a millisecond, at 741ms RTT it cost the app.
    assert.equal(
      requiresPreflight("GET", { Authorization: "Bearer abc" }),
      true,
    );
  });

  test("application/json forces a preflight even on a POST", () => {
    assert.equal(requiresPreflight("POST", JSON_HEADERS), true);
  });

  test("safelisted content types do not", () => {
    assert.equal(requiresPreflight("POST", { "Content-Type": "text/plain" }), false);
    assert.equal(
      requiresPreflight("POST", { "Content-Type": "text/plain;charset=UTF-8" }),
      false,
    );
  });

  test("PATCH and DELETE always preflight, headers or not", () => {
    assert.equal(requiresPreflight("PATCH", NO_HEADERS), true);
    assert.equal(requiresPreflight("DELETE", NO_HEADERS), true);
  });

  test("header names are matched case-insensitively", () => {
    assert.equal(requiresPreflight("GET", { "content-type": "application/json" }), true);
    assert.equal(requiresPreflight("GET", { "CONTENT-TYPE": "text/plain" }), false);
  });
});

describe("withToken", () => {
  test("appends to a bare path", () => {
    assert.equal(withToken("/api/status", "abc"), "/api/status?token=abc");
  });

  test("joins an existing query string with & rather than a second ?", () => {
    assert.equal(
      withToken("/api/narratives?archived=1", "abc"),
      "/api/narratives?archived=1&token=abc",
    );
  });

  test("escapes tokens that would otherwise break the query string", () => {
    assert.equal(withToken("/api/status", "a b&c=d"), "/api/status?token=a%20b%26c%3Dd");
  });

  test("stays in front of a fragment, which is never sent to the server", () => {
    assert.equal(withToken("/api/files?path=x#L10", "abc"), "/api/files?path=x&token=abc#L10");
    assert.equal(withToken("/api/status#top", "abc"), "/api/status?token=abc#top");
  });
});

describe("retry policy", () => {
  test("replays only what cannot have had an effect", () => {
    assert.equal(isRetryableMethod("GET"), true);
    assert.equal(isRetryableMethod("head"), true);
    // A timed-out spawn may have spawned. Asking twice is worse than failing.
    assert.equal(isRetryableMethod("POST"), false);
    assert.equal(isRetryableMethod("PATCH"), false);
  });

  test("retries transport failures, not answers", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    assert.equal(isRetryableError(abort), true);
    assert.equal(isRetryableError(new TypeError("Failed to fetch")), true);
    // An HTTP error is an answer; the caller decides what it means.
    assert.equal(isRetryableError(new Error("Status 404")), false);
  });

  test("backs off exponentially", () => {
    assert.equal(retryDelayMs(0), 500);
    assert.equal(retryDelayMs(1), 1000);
    assert.equal(retryDelayMs(2), 2000);
  });

  test("a ceiling that clears a satellite link's fixed costs", () => {
    // ~0.75s TCP + ~1.5s TLS + ~10 RTT of slow start is ~10s before a large
    // response can be moving at speed. The old 10s budget was spent before the
    // transfer began.
    assert.ok(DEFAULT_TIMEOUT_MS >= 30_000, "must survive a high-RTT link");
    assert.ok(MAX_ATTEMPTS >= 2, "one attempt is not a retry policy");
  });
});

// The three checks below read `expo/lib/api.ts` as text. The tarball ships
// `expo/dist/` (the built app) but not the source, so from an installed
// package — `brane doctor` — there is nothing to lint and the whole block
// skips with a reason rather than failing on ENOENT.
const apiSourcePath = join(repoRoot, "expo", "lib", "api.ts");
describe("the app's own request layer obeys the rules", { skip: existsSync(apiSourcePath) ? false : "expo source not shipped" }, () => {
  // Guards against the regression that a browser on a fast network cannot
  // show you: reinstating a header that quietly reintroduces a preflight.
  const api = existsSync(apiSourcePath) ? readFileSync(apiSourcePath, "utf8") : "";

  test("no request sets an Authorization header", () => {
    // Matches an object key, not the word in prose — the module explains
    // itself in comments and should be allowed to name what it avoids.
    assert.equal(
      /["']?Authorization["']?\s*:/i.test(api),
      false,
      "auth belongs in the query string; a header would force a preflight",
    );
  });

  test("every request's headers come from the two shared constants", () => {
    const headerValues = [...api.matchAll(/headers:\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
    assert.ok(headerValues.length > 0, "expected to find request call sites");
    for (const v of headerValues) {
      assert.ok(
        v === "NO_HEADERS" || v === "JSON_HEADERS",
        `unexpected headers value ${v} — use NO_HEADERS or JSON_HEADERS`,
      );
    }
  });

  test("nothing appends its own token — apiUrl already did", () => {
    // Caught in review: `payloadUrl` and `wikiAssetUrl` built their own query
    // strings, so once apiUrl started supplying the token they appended a
    // second one and the URL stopped authenticating. Images silently broke.
    // Matches a token being *put into* a URL or param bag, not the word
    // appearing as an interface field or a function argument.
    const stray = [
      ...api.matchAll(/token:\s*conn\.token/g),
      ...api.matchAll(/token=\$\{/g),
    ].map((m) => m[0]);
    assert.deepEqual(stray, [], "let apiUrl supply the token; a second one breaks auth");
  });

  test("bodied requests are the only ones carrying JSON_HEADERS", () => {
    // JSON_HEADERS on a bodiless request would buy a preflight for nothing.
    const blocks = api.split("fetchWithTimeout(");
    for (const b of blocks.slice(1)) {
      const head = b.slice(0, b.indexOf("});") + 1);
      if (head.includes("JSON_HEADERS")) {
        assert.ok(head.includes("body:"), `JSON_HEADERS without a body:\n${head}`);
      }
    }
  });
});
