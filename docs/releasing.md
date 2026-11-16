# Releasing

Publishing to npm is done by `.github/workflows/release.yml` running in
[`benjamn/brane-npm`](https://github.com/benjamn/brane-npm), and only there.
This repository carries the same workflow, but every job in it checks
`github.repository` and is skipped here. No npm token exists in either
repository or its secrets: the job authenticates with a short-lived OIDC
token ([npm trusted publishing](https://docs.npmjs.com/trusted-publishers)),
and all that token may do is **stage** the version. It reaches the registry
only when the operator approves it on npmjs.com, behind npm's 2FA (see [The
gates](#the-gates)).
**Agents never run `npm publish`** or `npm stage approve`, from a checkout or
anywhere else, and never run `scripts/mirror-release.mjs --push`, which starts
the release.

## brane-npm

`brane-npm` is the repository npm publishes from and the one `package.json`'s
`repository`, `homepage` and `bugs` name. Its history is **one commit per
release**, whose message is `brane <version>` and that version's
`CHANGELOG.md` section, and from 0.3.12-rc.0 on each commit's tree is
exactly this repository's tree at the commit that was released. Nothing else
crosses: no commit from here, no commit message, no pull request discussion,
no hash. It begins at 0.3.0; 0.3.0 to 0.3.11 were published from this
repository and recreated there on 2026-11-15, each commit dated to its npm
publish.

Every file in a release's tree is public once `brane-npm` is, including
those `package.json`'s `files` keeps out of the tarball (`src/`, `wiki/`
outside `shared/`, tests, workflows). Nothing that has to stay private
belongs in this repository's tree.

The commits are made by `scripts/mirror-release.mjs` from a clone of
`brane-npm` beside this checkout (`../brane-npm`, or `--mirror <path>`), whose
`origin` must be the repository `package.json`'s `repository.url` names. They
are made as the git identity that clone is configured with, and signed when
its `commit.gpgsign` is true. A commit on `brane-npm`'s `main` is permanent, so
`--push` refuses an author or committer different from the previous release's,
or an unsigned commit after a signed one; `--new-identity` accepts a change on
purpose. The script borrows this repository's objects through
`GIT_ALTERNATE_OBJECT_DIRECTORIES` for one `commit-tree` and repacks before it
pushes, so the clone never fetches this history and stands alone afterwards.
`src/test/release-mirror.test.ts` runs it against throwaway repositories.

## Cutting a release

1. Land the version bump on `main` by pull request, with `npm version <v>
   --no-git-tag-version` so `package-lock.json` moves with it, and a
   `## <version> - <date>` section in `CHANGELOG.md`. That section becomes the
   `brane-npm` commit's message and the GitHub release's notes, with pull
   request links (` ([#645](…))`) removed, since they name pull requests here
   that nobody there can open.
2. Run `node scripts/mirror-release.mjs` from a checkout of this repository.
   It fetches `origin/main`, reads the version from its `package.json`, and
   prints the commit it would make: tree, parent, identity, message. It writes
   nothing. It refuses a version `brane-npm` already has a tag for, a tree
   `brane-npm` already has, and a missing `CHANGELOG.md` section.
3. Run it again with `--push`. It creates the commit and an annotated
   `v<version>` tag in the `brane-npm` clone and pushes the commit to `main`
   and the tag in one atomic push; the clone's own `main` moves only once the
   push has succeeded. That push starts the release. With `--push`, `--from`
   must name a commit on `origin/main`: only merged commits are released.
4. When the run in `brane-npm` has staged the version, **approve it on
   npmjs.com** (Staged Packages, at
   `https://www.npmjs.com/settings/<user>/staged-packages`, or `npm stage
   approve <stage-id>`), after checking it is the one you pushed: the `stage` job of
   the run for your commit is green, and the SHASUM npmjs.com shows is the one
   that job printed (see [The gates](#the-gates)). That approval, with its
   2FA, is the publish.
5. For an ordinary release, **approve the app deploy** in `brane-npm`'s
   Actions tab (Review deployments, on the run). A prerelease deploys nothing.

If the push fails (no network, `gh` logged out), `brane-npm` is unchanged and
the commit and tag stay in the clone; running `--push` again pushes that same
commit and tag. A local tag that is not this release (another tree, or not on
top of `brane-npm`'s `main`) is refused with the command to remove it, for the
operator to run after looking.

The push runs `release.yml` in `brane-npm`, in five jobs:

- **`plan`** decides what the commit still needs. A version not on npm, with
  `v<version>` naming the pushed commit, is to be staged. A version already on
  npm is never staged again; if it has no GitHub release yet, the run
  *finishes* it (notes and deploy, below) instead. A version missing from npm
  whose tag is absent or names another commit is a red run.
- **`stage`** builds from scratch (`npm run build` plus the precache check,
  since `dist/` and `expo/dist/` are gitignored and there is no `prepare`
  script), runs the full test suite, prints the `npm pack --dry-run` manifest
  to the log, and runs `npm stage publish`. A failure anywhere is a red run and
  nothing in npm's stage queue.
- **`approval`** waits for the operator's approval on npmjs.com to show on the
  public registry: the version published, and its dist-tag naming it. It
  waits an hour. Approved later than that, it stops green with a notice, and
  dispatching `release.yml` on `main` afterwards finishes the release.
- **`release-notes`** then creates the GitHub release `v<version>` in
  `brane-npm` from the `CHANGELOG.md` section (`scripts/changelog.mjs
  notes`): install lines, the section, and a compare link to the previous tag.
  It is marked a pre-release when the version is one. A failure there is a
  re-run of that job, never a second publish.
- **`deploy-app`**, for an ordinary release, puts its app on the shared host
  (below), once the operator approves the job in the `app` environment.

**The version chooses the dist-tag.** A semver prerelease (`0.4.0-rc.1`)
stages under `next`; any other version stages under `latest`. npm fixes the
tag when the version is staged (changing it means rejecting and staging
again), and the workflow never moves one.

A version the operator **rejects** on npmjs.com never reaches the registry,
and nothing is announced or deployed. The `approval` job cannot see the
rejection (the stage queue needs a login no OIDC token has), so it waits out
its hour and stops with a notice that says so. npm's documentation describes
staging again after a rejection only for changing a dist-tag; a dispatch on
the same commit may stage the version again, and if npm refuses it, bump the
version. Bump it anyway if the commit itself was wrong.

`release.yml` also has `workflow_dispatch`: run it from `brane-npm`'s Actions
tab on `main` for a push that ran nothing (Actions was off), to finish a
release approved after its run stopped waiting, or to finish one whose run
failed after the approval. The `plan` job makes that safe on any commit. A
deploy that failed after its release was finished is redeployed by
dispatching `deploy-app.yml` (below).

## Provenance

`npm stage publish` is not passed `--provenance`, and needs no flag for it.
Trusted publishing attests a build by itself when the repository is public
and leaves attestation out when it is private, where `--provenance` would
fail the publish on a 422; npm says a staged version gets provenance on
parity with a direct publish. Every release from 0.3.0 to 0.3.12-rc.1 was
published from a private repository and carries **no provenance
attestation**. `brane-npm` went public on 2026-11-16, and every release
from it should carry one, with no workflow change, provided `package.json`'s
`repository.url` names `brane-npm`: npm rejects a provenance-bearing publish
whose `repository.url` names another repository. A staged version is not on
the registry until it is approved, so its attestation can only be confirmed
afterwards, with `npm view <name>@<version> dist.attestations`. `src/test/release-mirror.test.ts` keeps that URL
and the workflow's repository check equal. Check `gh repo view
benjamn/brane-npm --json visibility` before a release's notes say which it
is: the 0.3.1 CHANGELOG entry in its tarball claims provenance it does not
have.

## npm and GitHub settings

Staged publishing needs npm 11.15.0 or newer (trusted publishing alone, 11.5.1),
which no runner ships, so the job runs `npm install -g npm@latest` first. The
npm-side configuration lives at `https://www.npmjs.com/package/brane/access`,
is per package, and is the operator's:

- the trusted publisher entry `benjamn` / `brane-npm` / `release.yml` /
  environment `npm`, with **"Allow npm publish" and "Allow npm dist-tag" both
  off**, so the workflow can stage and do nothing else (`npm stage publish` is
  always allowed);
- "Require two-factor authentication and disallow tokens", which is what
  actually retires tokens as a publish path.

### The gates

Pushing to `brane-npm` starts a release; only the operator finishes one, at
two points that hold two different things.

**The registry: npm's stage queue.** `stage`, the only job in `release.yml`
that may mint an OIDC token (`id-token: write`), runs `npm stage publish`, and
the trusted publisher allows that and nothing else. A staged version is not
installable until a maintainer approves it, on npmjs.com or with `npm stage
approve`, and approval asks for 2FA, which no OIDC token can answer. A pushed
commit could rewrite `release.yml`, but the most a rewritten one can do with
the token is stage something, for the operator to reject. This holds against
anything that can push, a deploy key, a leaked credential, or an agent using
the operator's `gh` login alike, since none of them holds the operator's npm
2FA.

**Before approving**, check the staged version is the one you pushed. npm's
Staged Packages page shows each version's package, version, dist-tag,
publisher and SHASUM, but not the commit or run that staged it, so the check
goes through the run: the run for the commit `mirror-release.mjs` printed
(`Pushed <sha> and v<version>`) must have a green `stage` job, and the SHASUM
npmjs.com shows must be the one that job printed (in its log and in a notice
on the run). npm stages a version only once, so a version staged by something
else first makes the real run fail at its `stage` step: reject the stranger,
then dispatch `release.yml` again.

**The app host: the `app` environment.** `CLOUDFLARE_API_TOKEN` deploys
whatever it is given to the shared app host, the page that holds every
device's token, so it is a secret of `brane-npm`'s `app` environment, never a
repository secret, which any workflow in a pushed commit could read.
`deploy-app.yml`'s job runs in that environment and waits for the operator's
approval before it can read the token. This one is weaker against an agent
using the operator's `gh` login, which is the environment's reviewer and can
approve through the API: against that it is the rule in `AGENTS.md`, agents
never approve a deployment. Against a credential that can only push, it holds.
`deploy-app.yml`'s `gate` job refuses to deploy unless `app` exists with a
required reviewer, since GitHub creates a missing environment with no rules;
that check catches a mistake in the settings, while only the reviewer itself
stops a pushed commit that rewrites the file. Both of its jobs run only in
`brane-npm`. A waiting deploy holds the run, and so the `release`
concurrency group, and GitHub keeps one run pending behind it, cancelling the
older for a newer: reject a stale waiting deploy rather than leave it.

`src/test/release-mirror.test.ts` keeps `stage` the only job that can be
granted `id-token` (and no `write-all` anywhere), staging rather than
publishing, in the `npm` environment, and keeps the Cloudflare token out of
`release.yml` and in `deploy-app.yml`'s `app` job.

Both environments are configured once, in `brane-npm`'s Settings →
Environments, **before Actions is turned on**:

- **`npm`**: no secrets, no variables, and no required reviewer (npm's
  approval is the gate; a reviewer here would only add a click before
  staging). Deployment branches limited to `main`, so a run on another branch
  cannot stage. It exists because the trusted publisher entry names it.
- **`app`**: the operator as required reviewer **first**, with "Prevent
  self-review" off, since the operator is the only reviewer and also whoever
  the push was made as; deployment branches limited to `main`; and only then
  the secret `CLOUDFLARE_API_TOKEN`, so the secret never sits in an
  environment that does not wait. A deploy that waits is approved or rejected
  from the run's page (Review deployments); GitHub gives up after 30 days,
  which deploys nothing. An `app` environment that is missing, has no
  reviewer, or has no secret fails the deploy, and nothing else.

**What the first release will prove.** None of this has run yet. npm's
documentation disagrees with itself on one point that matters: the
trusted-publishers page says `npm stage publish` is always allowed, while the
`npm stage` CLI page says short-lived tokens cannot run `npm stage`
subcommands. If the first `stage` step is refused, that is why, and the fix is
in the trusted publisher entry or the workflow, not a reason to allow `npm
publish`. Two more are unverified: whether the workflow's `GITHUB_TOKEN` can
read an environment's protection rules (the `gate` job fails closed if not),
and whether the SHASUM `npm pack` prints is the one npmjs.com shows for the
staged tarball.

A newly created trusted-publisher entry reads **Pending validation** until
its first successful publish, and npm deletes it if none happens within
about 48 hours of creation; the access page shows the deadline. So either
create the entry on the day of the release, or validate a fresh one with a
prerelease version, which stages under `next` and leaves `latest` where it
was. npm's documentation does not say whether a staged version, once
approved, is what validates the entry; if it lapses, create it again.

`brane-npm`'s Actions were off while 0.3.0 to 0.3.11 were recreated, because
those trees carry the earlier `release.yml`, which publishes on a published
GitHub release. Turn them on **after** both environments exist (above) and
**before** the first `--push` that carries this `release.yml`: a push runs the
workflow file at the pushed commit, so that push runs this one, and until then
the only thing to avoid is creating a GitHub release in `brane-npm` by hand. A
push made while Actions are off runs nothing; dispatch `release.yml`
afterwards to run it.

`src/cli.ts` reads its version from `package.json` at startup, so
`brane --version` reports whatever was published rather than a string that
has to be bumped by hand.

## The app ships with the release

The shared app (the `brane` worker in `worker/wrangler.toml`, at
`app_domain`'s default host) serves the web app of the version npm calls
`latest`, and nothing else. A merge to `main` deploys nothing: `ci.yml` only
tests.

- After an ordinary release is approved on npm, `release.yml`'s `deploy-app`
  job runs `.github/workflows/deploy-app.yml` with the release's version, and
  waits for the operator's approval in the `app` environment, which holds the
  Cloudflare token ([The gates](#the-gates)). A prerelease version deploys
  nothing.
- `deploy-app.yml` does not build. It waits until the registry has the version
  and names it `latest` (right after a publish either can lag by up to a
  minute), unpacks `npm pack <name>@<version>`, checks the tarball's name,
  version and `expo/dist/index.html`, runs the precache check, and
  `wrangler deploy`s that `expo/dist`. The shared app is therefore the same
  bytes every daemon of that version installs and serves itself, by
  construction rather than by a second build that is supposed to match.
- It is its own job because a publish cannot be undone and a deploy can be
  repeated: a Cloudflare failure is a re-run of that job, never a second
  release.
- **Redeploy or roll back** by dispatching `deploy-app.yml` from `brane-npm`'s
  Actions tab with a version; it waits for approval in the `app` environment
  like any deploy. It refuses a version that is not `latest`, so a rollback
  is `npm dist-tag add brane@<version> latest` (the operator's, like everything
  on the registry) and then the dispatch. The dispatch checks out the branch it
  is run from, so an old version's bundle is deployed with *that branch's*
  `wrangler.toml` and precache check, not its tag's: the route is where the
  app lives whatever its version. A version that isn't `latest` is refused
  only after the registry-lag retries, about four minutes in.
- **A `wrangler.toml` change is first exercised by the next release's
  deploy.** A merge deploys nothing and `wrangler deploy --dry-run` doesn't
  talk to Cloudflare, so watch that release's `deploy-app` job. Declaring the
  custom domain needs zone permissions on `CLOUDFLARE_API_TOKEN`, not only
  Workers ones; if the job fails there, the fix is the token and a re-run, and
  the publish before it stands.

**Staging is Isolate.** A daemon running `main` (after `/rrr`) serves its own
bundle, built from that checkout, so Isolate on it shows everything merged
since the last release, together, before a release promotes it to the shared
app. Every daemon serves its own version's app the same way, which is also
what an older install has: `brane meld --local`, or Isolate, gives it the app
it shipped with. Between releases, then, a daemon running `main` is newer than
the shared app, the ordinary case of an older app on a newer daemon.

The deploy names no host and no package: the package name comes from
`package.json`, and the route is declared in `worker/wrangler.toml` as a
custom domain, with `workers_dev = false` so it is the only place the shared
app is served and the Cloudflare dashboard holds nothing the repository
doesn't. That route is `CONFIG_DEFAULTS.app_domain`, the host `brane meld`
points at, and `src/test/wrangler-route.test.ts` keeps the two equal. A fork
that publishes under its own name and serves its own app changes `name` in
`package.json`, `name` and the route in `wrangler.toml`, and
`CONFIG_DEFAULTS.app_domain`.
