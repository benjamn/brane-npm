# Releasing

Publishing to npm is done by `.github/workflows/release.yml`, and only by it.
No npm token exists in this repository or its secrets: the job authenticates
with a short-lived OIDC token ([npm trusted
publishing](https://docs.npmjs.com/trusted-publishers)). **Agents never run
`npm publish`**, from a checkout or anywhere else.

Published versions carry **no provenance attestation**, and `npm publish` is
not passed `--provenance`. npm will only attest a build from a public
repository, and this one stays private until brane is announced: its history
is a place to experiment, with invited collaborators or without, and it goes
public before any public promotion. With the flag, the publish step would fail
on a 422 every time. Without it, trusted publishing leaves attestation out for
a private repository and turns it on by itself for a public one, so the first
release after the repo goes public carries provenance with no workflow
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
