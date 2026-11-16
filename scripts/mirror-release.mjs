// Carries one release of brane to benjamn/brane-npm, the repository npm
// publishes from (docs/releasing.md).
//
//   node scripts/mirror-release.mjs [--from <ref>] [--mirror <path>]
//                                   [--source <path>] [--new-identity] [--push]
//
// The release is the tree at <ref> (default origin/main, fetched first), and
// its version is that tree's package.json version. brane-npm gets one new
// commit with exactly that tree, on top of its main, with the message
// `<name> <version>` plus the version's CHANGELOG section, and an annotated
// tag v<version> on it. Nothing from brane's history crosses: no commit, no
// message, no hash.
//
// The author and committer are the mirror clone's git identity, and the commit
// and tag are signed when its commit.gpgsign is true. A release must keep the
// identity of the release before it, and stay signed if that one was: a commit
// on brane-npm's main is permanent. --new-identity accepts a change on purpose.
//
// Without --push it only reads, and prints what it would create. With --push
// it creates the commit and tag in the mirror clone and pushes the commit to
// main and the tag in one atomic push; the clone's own main moves only once
// that push has succeeded. That push starts the release: release.yml in
// brane-npm stages a main whose version is not on npm yet, and the operator
// publishes it by approving it on npmjs.com. If the push fails, nothing
// on brane-npm changed, and running the script again pushes the same commit
// and tag rather than making new ones.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changelogSection, stripPullRequestLinks, wrapForCommit } from "./changelog.mjs";

const USAGE =
  "usage: node scripts/mirror-release.mjs [--from <ref>] [--mirror <path>] [--source <path>] [--new-identity] [--push]";

function fail(message) {
  console.error(`mirror-release: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { from: "origin/main", mirror: null, source: null, push: false, newIdentity: false };
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) fail(`${flag} needs a value\n${USAGE}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--push") opts.push = true;
    else if (arg === "--new-identity") opts.newIdentity = true;
    else if (arg === "--from") opts.from = value(++i, arg);
    else if (arg === "--mirror") opts.mirror = value(++i, arg);
    else if (arg === "--source") opts.source = value(++i, arg);
    else fail(`unknown argument: ${arg}\n${USAGE}`);
  }
  return opts;
}

function git(cwd, args, { env, input } = {}) {
  return execFileSync("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

// Like git(), but a failure is a value: null.
function gitTry(cwd, args, opts) {
  try {
    return git(cwd, args, opts);
  } catch {
    return null;
  }
}

// owner/repo from a GitHub remote or repository URL, in any of its spellings.
function githubRepo(url) {
  const m = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url ?? "");
  return m ? m[1].toLowerCase() : null;
}

const opts = parseArgs(process.argv.slice(2));
const sourceRoot = git(opts.source ?? dirname(fileURLToPath(import.meta.url)), ["rev-parse", "--show-toplevel"]);
const sourceCommonDir = git(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
const mirror = resolve(opts.mirror ?? join(dirname(sourceCommonDir), "..", "brane-npm"));
if (!existsSync(join(mirror, ".git"))) {
  fail(`no git clone of brane-npm at ${mirror} (pass --mirror <path>)`);
}

// What to release, read from brane without touching its working tree.
if (opts.from.startsWith("origin/")) {
  git(sourceRoot, ["fetch", "--quiet", "origin", opts.from.slice("origin/".length)]);
}
const sourceCommit = gitTry(sourceRoot, ["rev-parse", "--verify", `${opts.from}^{commit}`]);
if (!sourceCommit) fail(`${opts.from} is not a commit in ${sourceRoot}`);
if (opts.push && opts.from !== "origin/main") {
  // A release is something merged. --from is for looking, or for a dry run.
  git(sourceRoot, ["fetch", "--quiet", "origin", "main"]);
  if (gitTry(sourceRoot, ["merge-base", "--is-ancestor", sourceCommit, "origin/main"]) === null) {
    fail(`${opts.from} (${sourceCommit.slice(0, 9)}) is not on origin/main; only merged commits are released`);
  }
}
const tree = git(sourceRoot, ["rev-parse", `${sourceCommit}^{tree}`]);
const pkg = JSON.parse(git(sourceRoot, ["show", `${sourceCommit}:package.json`]));
const { name, version } = pkg;
const tag = `v${version}`;
let section;
try {
  section = changelogSection(git(sourceRoot, ["show", `${sourceCommit}:CHANGELOG.md`]), version);
} catch (e) {
  fail(`${e.message} at ${opts.from}; land the version bump with its CHANGELOG entry first`);
}

// Where it goes. The clone's origin must be the repository the release names
// as its own, and the clone must be exactly that remote's main, so the new
// commit's parent is what brane-npm has. The URL compared is the configured
// one, before any insteadOf rewriting.
const origin = gitTry(mirror, ["config", "--get", "remote.origin.url"]);
const expected = githubRepo(pkg.repository?.url);
if (!expected || githubRepo(origin) !== expected) {
  fail(`${mirror}'s origin is ${origin ?? "unset"}, but package.json's repository.url names ${expected ?? "nothing on GitHub"}`);
}
git(mirror, ["fetch", "--quiet", "origin", "main"]);
const mirrorHead = git(mirror, ["rev-parse", "--verify", "origin/main^{commit}"]);
const branch = gitTry(mirror, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
if (branch !== "main" || git(mirror, ["rev-parse", "HEAD"]) !== mirrorHead) {
  fail(`${mirror} must have main checked out at origin/main (${mirrorHead.slice(0, 9)}); it is on ${branch ?? "a detached HEAD"}`);
}
if (git(mirror, ["status", "--porcelain"]) !== "") fail(`${mirror} has uncommitted changes`);
const mirrorVersion = JSON.parse(git(mirror, ["show", "origin/main:package.json"])).version;
if (git(mirror, ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]) !== "") {
  fail(`brane-npm already has ${tag}; bump the version in brane first`);
}
if (git(mirror, ["rev-parse", "origin/main^{tree}"]) === tree) {
  fail(`brane-npm's main already has this exact tree (${mirrorVersion})`);
}

// A tag only this clone has is a release that was made and never pushed. If
// it is this release (this tree, on top of brane-npm's main), push it again;
// anything else is left for the operator to look at.
let resume = null;
const localTag = gitTry(mirror, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
if (localTag) {
  const sameTree = git(mirror, ["rev-parse", `${localTag}^{tree}`]) === tree;
  const sameParent = gitTry(mirror, ["rev-parse", `${localTag}^`]) === mirrorHead;
  if (!sameTree || !sameParent) {
    fail(
      `this clone has a ${tag} that brane-npm does not, on a different commit (${localTag.slice(0, 9)}). ` +
        `Look at it, and remove it with \`git -C ${mirror} tag -d ${tag}\` if it is a leftover.`,
    );
  }
  resume = localTag;
}

// Identity: the clone's, held to the previous release's.
const sign = git(mirror, ["config", "--bool", "--default", "false", "commit.gpgsign"]) === "true";
const committer = git(mirror, ["var", "GIT_COMMITTER_IDENT"]).replace(/ \d+ [+-]\d{4}$/, "");
const author = git(mirror, ["var", "GIT_AUTHOR_IDENT"]).replace(/ \d+ [+-]\d{4}$/, "");
const previous = git(mirror, ["log", "-1", "--format=%an <%ae>%n%cn <%ce>", mirrorHead]).split("\n");
// Whether it carries a signature at all, not whether this machine can verify
// it: %G? depends on the local keyring and its trust settings.
const previousSigned = /^gpgsig /m.test(git(mirror, ["cat-file", "commit", mirrorHead]).split("\n\n")[0]);
const identityProblems = [];
if (author !== previous[0]) identityProblems.push(`author ${author}, but ${mirrorVersion} was ${previous[0]}`);
if (committer !== previous[1]) identityProblems.push(`committer ${committer}, but ${mirrorVersion} was ${previous[1]}`);
if (previousSigned && !sign) identityProblems.push(`unsigned (commit.gpgsign is off), but ${mirrorVersion} was signed`);

const message = `${name} ${version}\n\n${wrapForCommit(stripPullRequestLinks(section))}\n`;

console.log(`release   ${name} ${version} (brane-npm is at ${mirrorVersion})`);
console.log(`tree      ${tree} (from ${opts.from} = ${sourceCommit.slice(0, 9)})`);
console.log(`parent    ${mirrorHead} (brane-npm main)`);
console.log(`identity  ${committer}${sign ? ", signed" : ", unsigned"}`);
console.log(`mirror    ${mirror}`);
if (resume) console.log(`resuming  ${tag} at ${resume.slice(0, 9)}, made earlier and never pushed`);
for (const problem of identityProblems) console.log(`identity! ${problem}`);
console.log("");
console.log(message.replace(/^/gm, "    "));

if (!opts.push) {
  console.log("Dry run: nothing was written. Pass --push to create and push the commit and tag.");
  process.exit(0);
}
if (identityProblems.length > 0 && !opts.newIdentity) {
  fail("the identity differs from the previous release's (above). Fix the clone's git config, or pass --new-identity to change it on purpose.");
}

// brane's objects are borrowed through the alternates environment variable,
// so commit-tree can name the tree without fetching brane's history into the
// mirror. The repack copies the objects the new tag reaches into the mirror's
// own pack, so the clone stands alone once the variable is gone, and only
// those objects are pushed.
const env = { GIT_ALTERNATE_OBJECT_DIRECTORIES: join(sourceCommonDir, "objects") };
let commit = resume;
if (!commit) {
  commit = git(mirror, ["commit-tree", ...(sign ? ["-S"] : []), "-p", mirrorHead, tree], { env, input: message });
  git(mirror, ["tag", sign ? "-s" : "-a", tag, "-m", `${name} ${version}`, commit], { env });
}
// Also on a resumed run: one interrupted between the tag and the repack left
// objects only brane has. Repacking twice is harmless.
git(mirror, ["repack", "-a", "-d", "-q"], { env });
if (gitTry(mirror, ["rev-list", "--objects", "--quiet", commit]) === null) {
  fail(`the mirror clone is missing objects for ${commit}; nothing was pushed`);
}
if (git(mirror, ["rev-parse", `${commit}^{tree}`]) !== tree) {
  fail(`tree mismatch for ${commit}; nothing was pushed`);
}

try {
  git(mirror, ["push", "--atomic", "origin", `${commit}:refs/heads/main`, `refs/tags/${tag}:refs/tags/${tag}`]);
} catch (e) {
  const detail = (e.stderr || e.message || "").toString().trim();
  fail(
    `the push failed, so brane-npm is unchanged:\n${detail}\n` +
      `The commit and tag are kept in ${mirror}; run this again to push them.`,
  );
}
git(mirror, ["merge", "--quiet", "--ff-only", commit]);
console.log(
  `Pushed ${commit.slice(0, 9)} and ${tag} to brane-npm. release.yml there stages ${name}@${version} on npm; ` +
    "approve it on npmjs.com (Staged Packages) once its SHASUM matches the run's.",
);
