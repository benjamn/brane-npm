import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isInlinePayload, isVideoPayload, servesPayloadInline, attachmentDisposition } from "../shared/payload-inline.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("isInlinePayload", () => {
  test("images render inline", () => {
    for (const p of ["a.png", "a.JPG", "a.jpeg", "a.gif", "a.webp", "a.bmp", "a.avif", "a.svg"]) {
      assert.equal(isInlinePayload(p), true, p);
    }
  });

  test("everything else is a file, including what a browser could display", () => {
    // The question is not "can the browser render it" — it is "does brane
    // render it inline". A `.pdf` or `.html` a browser would happily make a
    // page of is exactly the case this exists to catch.
    for (const p of ["a.pdf", "a.html", "a.txt", "a.json", "a.zip", "a"]) {
      assert.equal(isInlinePayload(p), false, p);
    }
  });

  test("the extension must end the name", () => {
    assert.equal(isInlinePayload("a.png.html"), false);
    assert.equal(isInlinePayload("png"), false);
  });

  test("a full payload path answers the same as its basename", () => {
    assert.equal(isInlinePayload("claude-4c7289d1/shot.png"), true);
    assert.equal(isInlinePayload("claude-4c7289d1/notes.md"), false);
  });

  test("a dot in a directory name is not the file's extension", () => {
    assert.equal(isInlinePayload("shots.png/README"), false);
  });
});

describe("isVideoPayload", () => {
  test("videos play in the chat", () => {
    for (const p of ["a.mp4", "a.MP4", "a.m4v", "a.mov", "a.webm", "claude-4c7289d1/clip.mp4"]) {
      assert.equal(isVideoPayload(p), true, p);
    }
  });

  test("a video is not an inline payload", () => {
    // The lightbox steps through inline payloads, and the export embeds each
    // one as a data URI; a video belongs in neither.
    for (const p of ["a.mp4", "a.mov", "a.webm"]) assert.equal(isInlinePayload(p), false, p);
  });

  test("raw streams and the like are still files", () => {
    for (const p of ["a.h264", "a.mkv", "a.avi", "a.mp4.html", "clips.mp4/README"]) {
      assert.equal(isVideoPayload(p), false, p);
    }
  });

  test("the daemon serves images and videos inline, and nothing else", () => {
    for (const p of ["a.png", "a.svg", "a.mp4", "a.webm"]) assert.equal(servesPayloadInline(p), true, p);
    for (const p of ["a.pdf", "a.html", "a.h264", "a"]) assert.equal(servesPayloadInline(p), false, p);
  });
});

describe("attachmentDisposition", () => {
  test("a plain name is a quoted attachment", () => {
    assert.equal(attachmentDisposition("notes.md"), 'attachment; filename="notes.md"');
  });

  test("a quote in the name cannot end the quoted string early", () => {
    // Otherwise `"; filename="evil.exe` is an injection into the parameter
    // list, and the browser saves under the second name.
    assert.equal(attachmentDisposition('a".txt'), 'attachment; filename="a\\".txt"');
    // A backslash never survives as itself: it is a path separator on the
    // other kind of machine, so it is neutralized before quoting rather than
    // escaped into the header.
    assert.equal(attachmentDisposition("a\\b.txt"), 'attachment; filename="a_b.txt"');
  });

  test("a non-ASCII name sends both parameters", () => {
    const d = attachmentDisposition("réponse.txt");
    assert.match(d, /^attachment; filename="r_ponse\.txt"; filename\*=UTF-8''/);
    assert.ok(d.endsWith("r%C3%A9ponse.txt"), d);
  });

  test("path separators and control characters never reach the header", () => {
    // A payload filename is whatever an agent narrated: a CR would end the
    // header, and a slash would suggest a directory to save into.
    assert.equal(
      attachmentDisposition("../../etc/passwd"),
      'attachment; filename=".._.._etc_passwd"',
    );
    assert.equal(
      attachmentDisposition("a\r\nX-Evil: 1"),
      'attachment; filename="aX-Evil: 1"',
    );
  });

  test("a name that survives none of that still yields something saveable", () => {
    assert.equal(attachmentDisposition(""), 'attachment; filename="download"');
    assert.equal(attachmentDisposition(" "), 'attachment; filename=" "');
  });
});

// The rule is only as good as its call sites, and this is a regression use
// cannot show you: opening a tokened URL as a page looks perfectly fine until
// someone saves it. Same shape as the source lint in `api-request.test.ts`.
const chatSource = join(repoRoot, "expo", "app", "[nid].tsx");
const filesSource = join(repoRoot, "expo", "components", "FilesView.tsx");
const sourcesPresent = existsSync(chatSource) && existsSync(filesSource);

describe("the app never navigates to a tokened daemon URL", {
  skip: sourcesPresent ? false : "expo source not shipped",
}, () => {
  const sources = sourcesPresent
    ? [
        { path: "expo/app/[nid].tsx", text: readFileSync(chatSource, "utf8") },
        { path: "expo/components/FilesView.tsx", text: readFileSync(filesSource, "utf8") },
      ]
    : [];

  test("no window.open on a payload or raw-file URL", () => {
    for (const { path, text } of sources) {
      for (const m of text.matchAll(/window\.open\(([^)]*)\)/g)) {
        assert.ok(
          !/payloadUrl|filesRawUrl/.test(m[1]),
          `${path}: window.open(${m[1]}) — download it instead; the URL carries the token`,
        );
      }
    }
  });

  test("both files reach those URLs through the download helper", () => {
    for (const { path, text } of sources) {
      assert.match(text, /from "@\/lib\/download"/, `${path} should import the helper`);
    }
  });
});
