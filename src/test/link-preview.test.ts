// The link preview card is three files that have to agree: the served HTML
// (expo/public/index.html), its kept-in-step copy (expo/app/+html.tsx), and
// the image the tags name. An unfurler that follows the og:image URL to a
// 404, or reads a declared size the PNG doesn't have, shows no card at all —
// and nothing in a local build would notice. This pins the agreement.
//
// Reads source, so it skips from an install, where expo/ is not shipped —
// the same arrangement as api-request.test.ts.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const publicDir = join(repoRoot, "expo", "public");
const servedPath = join(publicDir, "index.html");
const templatePath = join(repoRoot, "expo", "app", "+html.tsx");
const layoutPath = join(repoRoot, "expo", "app", "_layout.tsx");

const SHARED_HOST = "https://brane.organelle.dev";

function tag(html: string, attr: "property" | "name" | "rel", key: string): string | undefined {
  const m = html.match(new RegExp(`<(?:meta|link)[^>]*\\b${attr}="${key}"[^>]*\\b(?:content|href)="([^"]*)"`));
  return m?.[1];
}

/** Width and height from a PNG's IHDR chunk, which always follows the
 *  8-byte signature: length(4) "IHDR"(4) width(4) height(4). */
function pngSize(file: string): [number, number] {
  const b = readFileSync(file);
  assert.equal(b.subarray(1, 4).toString("latin1"), "PNG", `${file} is not a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe("the link preview card", { skip: existsSync(servedPath) ? false : "expo source not shipped" }, () => {
  const served = existsSync(servedPath) ? readFileSync(servedPath, "utf8") : "";
  const template = existsSync(templatePath) ? readFileSync(templatePath, "utf8") : "";
  const layout = existsSync(layoutPath) ? readFileSync(layoutPath, "utf8") : "";

  test("the served HTML and its template carry the same card", () => {
    for (const key of ["og:site_name", "og:title", "og:description", "og:image", "og:image:width", "og:image:height", "og:image:alt"]) {
      assert.ok(tag(served, "property", key), `public/index.html lacks ${key}`);
      assert.equal(tag(template, "property", key), tag(served, "property", key), `${key} differs in +html.tsx`);
    }
    assert.equal(tag(served, "name", "twitter:card"), "summary_large_image");
    assert.equal(tag(template, "name", "twitter:card"), tag(served, "name", "twitter:card"));
  });

  test("og:image is absolute on the shared host, and names a file public/ ships at the declared size", () => {
    const url = tag(served, "property", "og:image")!;
    assert.ok(url.startsWith(`${SHARED_HOST}/`), `og:image must be absolute on ${SHARED_HOST}: ${url}`);
    const file = join(publicDir, url.slice(SHARED_HOST.length + 1));
    assert.ok(existsSync(file), `og:image points at ${file}, which does not exist`);
    const [w, h] = pngSize(file);
    assert.equal(String(w), tag(served, "property", "og:image:width"));
    assert.equal(String(h), tag(served, "property", "og:image:height"));
    // 1200×630 is the size every unfurler renders as a large card; smaller
    // falls back to a thumbnail on some and to nothing on others.
    assert.ok(w >= 1200 && h >= 630, `og:image is ${w}×${h}, below 1200×630`);
  });

  test("og:image is versioned, because iMessage caches a preview by URL", () => {
    const url = tag(served, "property", "og:image")!;
    assert.match(url, /\.v\d+\.png$/, `expected a .v<N>.png name: ${url}`);
  });

  test("the touch icon is linked from all three heads and is 180×180", () => {
    const href = tag(served, "rel", "apple-touch-icon");
    assert.equal(href, "/apple-touch-icon.png");
    assert.equal(tag(template, "rel", "apple-touch-icon"), href);
    assert.equal(tag(layout, "rel", "apple-touch-icon"), href);
    assert.deepEqual(pngSize(join(publicDir, href!.slice(1))), [180, 180]);
  });
});
