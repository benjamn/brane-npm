# Releasing

Publishing to npm is done by `.github/workflows/release.yml`, and only by it.
No npm token exists in this repository or its secrets: the job authenticates
with a short-lived OIDC token ([npm trusted
publishing](https://docs.npmjs.com/trusted-publishers)). **Agents never run
`npm publish`**, from a checkout or anywhere else.

`npm publish` is not passed `--provenance`, and needs no flag for it.
Trusted publishing attests a build by itself when the repository is public
and leaves attestation out when it is private, where `--provenance` would
fail the publish on a 422. 0.3.0 was published while the repository was still
private, so it is the one release with **no provenance attestation**; every
release since the repository went public carries it, with no workflow
change.

The trigger is a **published GitHub release**, not a tag push, so the release
notes and the publish are one act and a stray tag cannot publish anything.

1. Land the version bump on `main` by pull request, with `npm version <v>
   --no-git-tag-version` so `package-lock.json` moves with it.
2. Create a GitHub release on `main` tagged `v<version>`, exactly the
   `package.json` version with a `v` prefix. The workflow refuses any other
   tag, and refuses a version that is already on the registry.
3. The **"Set as a pre-release"** checkbox chooses the dist-tag: unchecked
   publishes under `latest`, checked publishes under `next`. That is the only
   place the choice is made.

The job builds from scratch (`npm run build` plus the precache check, since
`dist/` and `expo/dist/` are gitignored and there is no `prepare` script),
runs the full test suite, prints the `npm pack --dry-run` manifest to the log,
and then publishes. A failure anywhere before the last step is a red run and
nothing on the registry.

Trusted publishing needs npm 11.5.1 or newer, which no runner ships, so the job
runs `npm install -g npm@latest` first. The npm-side configuration lives at
`https://www.npmjs.com/package/brane/access`, is per package, and is the
operator's: the trusted publisher entry (`benjamn` / `brane` / `release.yml`,
no environment), and "Require two-factor authentication and disallow tokens",
which is what actually retires tokens as a publish path.

A newly created trusted-publisher entry reads **Pending validation** until
its first successful publish, and npm deletes it if none happens within
about 48 hours of creation; the access page shows the deadline. So either
create the entry on the day of the release, or validate a fresh one with a
release marked pre-release, which publishes to `next` and leaves `latest`
where it was.

`src/cli.ts` reads its version from `package.json` at startup, so
`brane --version` reports whatever was published rather than a string that
has to be bumped by hand.

## The app ships with the release

The shared app (the `brane` worker in `worker/wrangler.toml`, at
`app_domain`'s default host) serves the web app of the version npm calls
`latest`, and nothing else. A merge to `main` deploys nothing: `ci.yml` only
tests.

- After an ordinary release publishes, `release.yml`'s `deploy-app` job runs
  `.github/workflows/deploy-app.yml` with the release's version. A pre-release
  deploys nothing.
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
- **Redeploy or roll back** by dispatching `deploy-app.yml` from the Actions
  tab with a version. It refuses a version that is not `latest`, so a rollback
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
