// One version's section of CHANGELOG.md, cleaned for readers outside the
// private repository. Two callers: scripts/mirror-release.mjs writes it into
// the brane-npm commit's message, and release.yml (in brane-npm) turns it into
// the GitHub release notes. CHANGELOG.md itself ships as written.
//
// As a command:
//   node scripts/changelog.mjs notes <version> <repo> [<previous-version>]
// prints the release notes for <version>: the install lines, the section
// unwrapped to one line per paragraph and bullet, and a compare link on
// github.com/<repo> when a previous version is given.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The body under `## <version> - <date>`, up to the next `## ` heading.
export function changelogSection(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => {
    const m = /^## (\S+)(?:\s|$)/.exec(line);
    return m !== null && m[1] === version;
  });
  if (start < 0) {
    throw new Error(`CHANGELOG.md has no "## ${version} - <date>" section`);
  }
  let end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join("\n").trim();
  if (body === "") throw new Error(`CHANGELOG.md's ${version} section is empty`);
  return body;
}

// Pull request links name PRs in the private repository, which nobody reading
// brane-npm can open, and whose numbers GitHub would autolink to brane-npm's
// own (unrelated) issues. Removes ` ([#645](…))` and multi-link groups like
// `([#598](…),\n  [#599](…))`, then any space left before punctuation.
export function stripPullRequestLinks(markdown) {
  return markdown
    .replace(/\s*\((?:\[#\d+\]\([^)\s]*\)[,\s]*)+\)/g, "")
    .replace(/[ \t]+([.,;:])/g, "$1");
}

// Reflows markdown paragraphs and `- ` bullets to `width` columns for a
// commit message. Bullets in one list stay adjacent; other blocks are
// separated by a blank line. Fenced code and nested lists are not expected in
// CHANGELOG sections and are not special-cased.
export function wrapForCommit(markdown, width = 72) {
  const blocks = markdown
    .trim()
    .split(/\n\s*\n|\n(?=- )/)
    .map((block) => block.trim().replace(/\s*\n\s*/g, " "));
  let out = "";
  blocks.forEach((block, i) => {
    const bullet = block.startsWith("- ");
    if (i > 0) out += bullet && blocks[i - 1].startsWith("- ") ? "\n" : "\n\n";
    out += fill(block, width, bullet ? "  " : "");
  });
  return out;
}

function fill(text, width, indent) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (line !== "" && candidate.length > width) {
      lines.push(line);
      line = indent + word;
    } else {
      line = candidate;
    }
  }
  if (line !== "") lines.push(line);
  return lines.join("\n");
}

// GitHub renders a release body's newlines as line breaks, as it does an
// issue comment's, so CHANGELOG.md's hard wrapping would show on the release
// page. Joins each paragraph's and list item's continuation lines onto it;
// blank lines, list items at any depth, headings, quotes, tables, fenced code
// and hard breaks (a trailing backslash or two spaces) keep their lines.
export function unwrapForRelease(markdown) {
  const out = [];
  let fence = null; // the opening run of ``` or ~~~ while inside a fence
  let open = false; // whether the last line is paragraph text a line can join
  for (const line of markdown.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== null) {
      out.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      out.push(line);
      open = false;
      continue;
    }
    const starts = line.trim() === "" || /^\s*(?:[-*+]|\d+[.)])(?:\s|$)|^\s*[#>|]/.test(line);
    if (open && !starts) {
      out[out.length - 1] += " " + line.trim();
    } else {
      out.push(line);
    }
    open = line.trim() !== "" && !/^\s*[#|]/.test(line) && !/(?:\\| {2})$/.test(line);
  }
  return out.join("\n");
}

export function releaseNotes({ changelog, name, version, repo, previous }) {
  const section = unwrapForRelease(stripPullRequestLinks(changelogSection(changelog, version)));
  let notes = "```\n" +
    `npm install -g ${name}@${version}\n` +
    `${name} daemon restart\n` +
    "```\n\n" +
    section + "\n";
  if (previous) {
    notes += `\nFull diff: https://github.com/${repo}/compare/v${previous}...v${version}\n`;
  }
  return notes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, version, repo, previous] = process.argv.slice(2);
  if (command !== "notes" || !version || !repo) {
    console.error("usage: node scripts/changelog.mjs notes <version> <owner/repo> [<previous-version>]");
    process.exit(2);
  }
  const root = new URL("../", import.meta.url);
  const changelog = readFileSync(new URL("CHANGELOG.md", root), "utf8");
  const { name } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  process.stdout.write(releaseNotes({ changelog, name, version, repo, previous }));
}
