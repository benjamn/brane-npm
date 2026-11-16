import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// npm publishes from benjamn/brane-npm (docs/releasing.md). Two things have to
// agree for that to work: release.yml only runs in the repository it names,
// and package.json's repository.url must name that same repository, or npm
// refuses the publish once the repository is public and provenance is
// attached. The release notes and the mirror's commit messages are both cut
// from CHANGELOG.md by scripts/changelog.mjs, pinned below.
//
// This reads *source* (the workflow and scripts/), which the npm tarball does
// not carry, so each case skips when its source is absent rather than failing
// `brane doctor` on every install.

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RELEASE_YML = join(root, ".github", "workflows", "release.yml");
const CHANGELOG_MJS = join(root, "scripts", "changelog.mjs");

interface ChangelogModule {
  changelogSection(changelog: string, version: string): string;
  stripPullRequestLinks(markdown: string): string;
  wrapForCommit(markdown: string, width?: number): string;
  releaseNotes(o: { changelog: string; name: string; version: string; repo: string; previous?: string }): string;
}

async function loadChangelog(): Promise<ChangelogModule> {
  return import(pathToFileURL(CHANGELOG_MJS).href) as Promise<ChangelogModule>;
}

const PACK_SHASUM_MJS = join(root, "scripts", "pack-shasum.mjs");

// The first brane-npm release run failed here: the runner's npm@latest (npm
// 12) prints `npm pack --json` as an object keyed by package name, where npm
// 10 printed an array, and the step read only the array.
describe("scripts/pack-shasum.mjs", () => {
  const sha = "3a0d2424d63000156d04a4c2bfcdbc527fb17efb";
  const entry = { id: "brane@0.3.12-rc.0", name: "brane", version: "0.3.12-rc.0", shasum: sha, integrity: "sha512-x" };

  it("reads npm 10's array and npm 12's object alike", async (t) => {
    if (!existsSync(PACK_SHASUM_MJS)) return t.skip("source is not present (an installed package)");
    const { packShasum } = (await import(pathToFileURL(PACK_SHASUM_MJS).href)) as {
      packShasum(output: string): string | null;
    };
    assert.equal(packShasum(JSON.stringify([entry])), sha);
    assert.equal(packShasum(JSON.stringify({ brane: entry })), sha);
    for (const bad of ["", "not json", "null", "[]", "{}", JSON.stringify([{ shasum: "nope" }]), JSON.stringify({ brane: {} })]) {
      assert.equal(packShasum(bad), null, `no shasum from ${JSON.stringify(bad)}`);
    }
  });

  it("prints the shasum, or fails without output so the workflow stages anyway", (t) => {
    if (!existsSync(PACK_SHASUM_MJS)) return t.skip("source is not present (an installed package)");
    const ok = spawnSync(process.execPath, [PACK_SHASUM_MJS], { input: JSON.stringify({ brane: entry }), encoding: "utf8" });
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout, `${sha}\n`);
    const bad = spawnSync(process.execPath, [PACK_SHASUM_MJS], { input: "{}", encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, "");
    // The step must not let this script's failure stop `npm stage publish`.
    assert.match(readFileSync(RELEASE_YML, "utf8"), /node scripts\/pack-shasum\.mjs \|\| true\)/);
  });
});

describe("the publishing repository", () => {
  it("is the one release.yml runs in and package.json's repository.url names", (t) => {
    if (!existsSync(RELEASE_YML)) return t.skip("source is not present (an installed package)");
    const guards = [...readFileSync(RELEASE_YML, "utf8").matchAll(/github\.repository == '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(guards, ["benjamn/brane-npm"]);
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(pkg.repository.url, `git+https://github.com/${guards[0]}.git`);
  });

  // The gates (docs/releasing.md). npm's trusted publisher allows staging only,
  // from the npm environment, and a staged version is published only by the
  // operator's 2FA approval on npmjs.com. That holds while the one job that can
  // mint an OIDC token is the one in that environment, it stages rather than
  // publishes, and nothing else in the workflow can mint a token. The app's
  // Cloudflare token is an `app` environment secret, read by deploy-app.yml's
  // job in that environment and never handed over by release.yml.
  it("only stages, from the npm environment, the only job with id-token: write", (t) => {
    if (!existsSync(RELEASE_YML)) return t.skip("source is not present (an installed package)");
    const yml = readFileSync(RELEASE_YML, "utf8").replace(/^\s*#.*$/gm, "");
    const jobs = workflowJobs(yml);
    // write-all grants id-token without naming it, at either level.
    assert.doesNotMatch(yml, /write-all/, "no permissions: write-all anywhere");
    assert.doesNotMatch(yml.slice(0, yml.indexOf("\njobs:\n")), /id-token/, "no workflow-level id-token permission");
    // Any mention, so the inline form (permissions: { id-token: write }) counts.
    assert.deepEqual(
      [...jobs].filter(([, body]) => /id-token/.test(body)).map(([name]) => name),
      ["stage"],
    );
    const stage = jobs.get("stage")!;
    assert.match(stage, /^\s+id-token:\s*write\s*$/m);
    assert.match(stage, /^ {4}environment:\s*npm\s*$/m);
    assert.match(stage, /^\s+npm stage publish --tag/m);
    assert.doesNotMatch(yml, /\bnpm publish\b/, "nothing publishes directly");
    // The trusted publisher allows no dist-tag changes; nor does the workflow.
    assert.doesNotMatch(yml, /\bnpm dist-tag\b/, "nothing moves a dist-tag");
    assert.doesNotMatch(yml, /CLOUDFLARE_API_TOKEN/, "release.yml never handles the Cloudflare token");
    // No secrets: block at all, so `secrets: inherit` cannot hand the called
    // deploy the repository's secrets either.
    assert.doesNotMatch(yml, /^\s+secrets:/m, "release.yml passes no secrets");

    const deployYml = join(root, ".github", "workflows", "deploy-app.yml");
    const deploy = workflowJobs(readFileSync(deployYml, "utf8").replace(/^\s*#.*$/gm, ""));
    assert.deepEqual([...deploy.keys()], ["gate", "deploy"]);
    // Both run only in brane-npm, so a dispatch in the private repository (or
    // a fork) cannot create an unprotected app environment and deploy from it.
    for (const [name, body] of deploy) {
      assert.match(body, /^ {4}if: github\.repository == 'benjamn\/brane-npm'\s*$/m, `${name} checks the repository`);
    }
    assert.match(deploy.get("gate")!, /environments\/app/);
    assert.doesNotMatch(deploy.get("gate")!, /environment:/, "the gate itself runs outside the environment");
    assert.match(deploy.get("deploy")!, /^ {4}needs: gate\s*$/m);
    assert.match(deploy.get("deploy")!, /^ {4}environment:\s*app\s*$/m);
    assert.match(deploy.get("deploy")!, /secrets\.CLOUDFLARE_API_TOKEN/);
  });
});

// A workflow's jobs by name, each with the text of its body. Enough for the
// assertions above, which look for keys and commands, not for YAML structure.
function workflowJobs(yml: string): Map<string, string> {
  const at = yml.indexOf("\njobs:\n");
  assert.ok(at >= 0, "the workflow has a jobs: section");
  const jobs = new Map<string, string>();
  const parts = yml.slice(at + "\njobs:\n".length).split(/^ {2}([\w-]+):[ \t]*$/m);
  for (let i = 1; i < parts.length; i += 2) jobs.set(parts[i], parts[i + 1]);
  return jobs;
}

describe("scripts/changelog.mjs", () => {
  const changelog = [
    "# Changelog",
    "",
    "## 0.4.0-rc.1 - 2026-12-01",
    "",
    "- One thing changed",
    "  ([#700](https://github.com/benjamn/brane/pull/700)).",
    "- Two links, wrapped",
    "  ([#701](https://github.com/benjamn/brane/pull/701),",
    "  [#702](https://github.com/benjamn/brane/pull/702)).",
    "",
    "A closing paragraph.",
    "",
    "## 0.3.11 - 2026-11-06",
    "",
    "- Older.",
    "",
  ].join("\n");

  it("cuts one version's section, and refuses a version it lacks", async (t) => {
    if (!existsSync(CHANGELOG_MJS)) return t.skip("source is not present (an installed package)");
    const { changelogSection } = await loadChangelog();
    assert.equal(changelogSection(changelog, "0.3.11"), "- Older.");
    assert.match(changelogSection(changelog, "0.4.0-rc.1"), /^- One thing changed[\s\S]*A closing paragraph\.$/);
    assert.throws(() => changelogSection(changelog, "0.4.0"), /no "## 0\.4\.0 - <date>" section/);
  });

  it("drops private pull request links, single and grouped across lines", async (t) => {
    if (!existsSync(CHANGELOG_MJS)) return t.skip("source is not present (an installed package)");
    const { changelogSection, stripPullRequestLinks } = await loadChangelog();
    const stripped = stripPullRequestLinks(changelogSection(changelog, "0.4.0-rc.1"));
    assert.doesNotMatch(stripped, /#\d|github\.com/);
    assert.match(stripped, /- One thing changed\.\n- Two links, wrapped\./);
  });

  it("wraps for a commit message, keeping a list's bullets adjacent", async (t) => {
    if (!existsSync(CHANGELOG_MJS)) return t.skip("source is not present (an installed package)");
    const { wrapForCommit } = await loadChangelog();
    const long = "- " + "word ".repeat(30).trim();
    const wrapped = wrapForCommit(`${long}\n- short\n\nAfter the list.`, 40);
    const lines = wrapped.split("\n");
    assert.ok(lines.every((line) => line.length <= 40), wrapped);
    assert.ok(lines.slice(1).some((line) => line.startsWith("  word")), wrapped);
    assert.match(wrapped, /\n- short\n\nAfter the list\.$/);
  });

  it("writes release notes with install lines and a compare link", async (t) => {
    if (!existsSync(CHANGELOG_MJS)) return t.skip("source is not present (an installed package)");
    const { releaseNotes } = await loadChangelog();
    const notes = releaseNotes({ changelog, name: "brane", version: "0.3.11", repo: "benjamn/brane-npm", previous: "0.3.10" });
    assert.equal(
      notes,
      "```\nnpm install -g brane@0.3.11\nbrane daemon restart\n```\n\n- Older.\n\n" +
        "Full diff: https://github.com/benjamn/brane-npm/compare/v0.3.10...v0.3.11\n",
    );
  });

  it("finds a section for every version in the real CHANGELOG.md", async (t) => {
    if (!existsSync(CHANGELOG_MJS)) return t.skip("source is not present (an installed package)");
    const { changelogSection } = await loadChangelog();
    const real = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const versions = [...real.matchAll(/^## (\d+\.\d+\.\d+\S*) - /gm)].map((m) => m[1]);
    assert.ok(versions.length > 0);
    for (const v of versions) assert.ok(changelogSection(real, v).length > 0, v);
  });
});

// scripts/mirror-release.mjs makes the release: one push that cannot be taken
// back. It runs here against throwaway repositories only: a "brane" with its
// own origin, a bare "brane-npm" seeded with one release, and a clone of it.
// Global and system git config are replaced, so no signing key, identity or
// insteadOf from the machine running the suite applies, and every run passes
// --source and --mirror, so the real ../brane-npm is never in reach. The
// temporary directory is left for the OS to clear, like any other under tmpdir.
describe("scripts/mirror-release.mjs", () => {
  const MIRROR_RELEASE = join(root, "scripts", "mirror-release.mjs");
  const NPM_URL = "https://github.com/example/brane-npm.git";
  const present = existsSync(MIRROR_RELEASE);

  let dir = "";
  let env: NodeJS.ProcessEnv = {};
  let src = "";
  let npmOrigin = "";
  let mirror = "";

  const g = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [MIRROR_RELEASE, "--source", src, "--mirror", mirror, ...args], {
      env,
      encoding: "utf8",
    });
    return { status: r.status, out: r.stdout + r.stderr };
  };

  const files = (version: string, notes: string) => ({
    "package.json": JSON.stringify({ name: "brane", version, repository: { type: "git", url: `git+${NPM_URL}` } }, null, 2) + "\n",
    "CHANGELOG.md": `# Changelog\n\n## ${version} - 2026-12-01\n\n${notes}\n\n## 0.3.11 - 2026-11-06\n\n- Older.\n`,
  });

  const commitFiles = (repo: string, contents: Record<string, string>, message: string) => {
    for (const [file, text] of Object.entries(contents)) writeFileSync(join(repo, file), text);
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", message);
    return g(repo, "rev-parse", "HEAD");
  };

  before(() => {
    if (!present) return;
    dir = mkdtempSync(join(tmpdir(), "mirror-release-"));
    const globalConfig = join(dir, "gitconfig");
    writeFileSync(globalConfig, "[user]\n\tname = Release Tester\n\temail = release@example.invalid\n[init]\n\tdefaultBranch = main\n");
    env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_") && !key.startsWith("GIT_CONFIG")) delete env[key];

    // brane, with an origin of its own, at 0.3.11
    const srcOrigin = join(dir, "brane-origin.git");
    g(dir, "init", "-q", "--bare", srcOrigin);
    src = join(dir, "brane");
    g(dir, "clone", "-q", srcOrigin, src);
    commitFiles(src, files("0.3.11", "- Older."), "0.3.11");

    // brane-npm, seeded with that same release
    npmOrigin = join(dir, "brane-npm-origin.git");
    g(dir, "init", "-q", "--bare", npmOrigin);
    const seed = join(dir, "seed");
    g(dir, "clone", "-q", npmOrigin, seed);
    commitFiles(seed, files("0.3.11", "- Older."), "brane 0.3.11");
    g(seed, "tag", "-a", "v0.3.11", "-m", "brane 0.3.11");
    g(seed, "push", "-q", "origin", "main", "v0.3.11");

    // the clone the script works in, whose origin reads as the GitHub URL
    mirror = join(dir, "brane-npm");
    g(dir, "clone", "-q", npmOrigin, mirror);
    g(mirror, "remote", "set-url", "origin", NPM_URL);
    g(mirror, "config", `url.${npmOrigin}.insteadOf`, NPM_URL);

    // the release: 0.3.12 merged to brane's main
    commitFiles(src, files("0.3.12", "- A change\n  ([#700](https://github.com/benjamn/brane/pull/700))."), "Release 0.3.12 (#701)");
    g(src, "push", "-q", "origin", "main");
  });

  it("writes nothing without --push", (t) => {
    if (!present) return t.skip("source is not present (an installed package)");
    const before = g(npmOrigin, "rev-parse", "main");
    const r = run();
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /brane 0\.3\.12\n\s*\n\s+- A change\.\n/);
    assert.match(r.out, /Dry run: nothing was written/);
    assert.equal(g(npmOrigin, "rev-parse", "main"), before);
    assert.equal(g(mirror, "tag", "-l", "v0.3.12"), "");
  });

  it("refuses a --from that is not on origin/main", (t) => {
    if (!present) return t.skip("source is not present (an installed package)");
    g(src, "checkout", "-q", "-b", "side");
    commitFiles(src, { "extra.txt": "unmerged\n" }, "unmerged");
    g(src, "checkout", "-q", "main");
    const r = run("--from", "side", "--push");
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /is not on origin\/main/);
  });

  it("refuses an identity different from the previous release's", (t) => {
    if (!present) return t.skip("source is not present (an installed package)");
    g(mirror, "config", "user.email", "someone-else@example.invalid");
    try {
      const r = run("--push");
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /identity differs from the previous release/);
      assert.equal(g(mirror, "tag", "-l", "v0.3.12"), "");
    } finally {
      g(mirror, "config", "--unset", "user.email");
    }
  });

  it("leaves brane-npm unchanged when the push fails, and resumes on the next run", (t) => {
    if (!present) return t.skip("source is not present (an installed package)");
    const before = g(npmOrigin, "rev-parse", "main");
    const mirrorMain = g(mirror, "rev-parse", "main");
    // The script fetches before it pushes, so only pushes are sent nowhere.
    g(mirror, "config", "remote.origin.pushurl", join(dir, "nowhere.git"));

    const failed = run("--push");
    assert.equal(failed.status, 1, failed.out);
    assert.match(failed.out, /the push failed, so brane-npm is unchanged/);
    assert.equal(g(npmOrigin, "rev-parse", "main"), before);
    assert.equal(g(mirror, "rev-parse", "main"), mirrorMain, "the clone's main moves only after a push");
    const made = g(mirror, "rev-parse", "v0.3.12^{commit}");

    g(mirror, "config", "--unset", "remote.origin.pushurl");
    const resumed = run("--push");
    assert.equal(resumed.status, 0, resumed.out);
    assert.match(resumed.out, /resuming\s+v0\.3\.12/);

    const head = g(npmOrigin, "rev-parse", "main");
    assert.equal(head, made, "the resumed push is the commit made the first time");
    assert.equal(g(npmOrigin, "rev-parse", "v0.3.12^{commit}"), head);
    assert.equal(g(npmOrigin, "rev-parse", `${head}^`), before);
    assert.equal(g(npmOrigin, "rev-parse", `${head}^{tree}`), g(src, "rev-parse", "main^{tree}"));
    assert.equal(g(npmOrigin, "log", "-1", "--format=%B", head), "brane 0.3.12\n\n- A change.");
    assert.equal(g(mirror, "rev-parse", "main"), head);
    // none of brane's commits crossed
    for (const sha of g(src, "rev-list", "--all").split("\n")) {
      assert.throws(() => g(npmOrigin, "cat-file", "-e", sha), `brane commit ${sha} reached brane-npm`);
    }
  });

  it("refuses a version brane-npm already has", (t) => {
    if (!present) return t.skip("source is not present (an installed package)");
    const r = run("--push");
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /brane-npm already has v0\.3\.12/);
  });
});
