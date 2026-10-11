# Contributing to brane

Brane is a single-maintainer project developed with coding agents. Most
commits on `main` were written by an agent under the operator's direction,
and every one of them was reviewed, authored, committed, and merged by a
human. This document says what that means for anyone touching the
repository, human or agent.

## How changes land

- `main` takes pull requests only. The `protect-main-branch` ruleset
  (2026-09-02) requires a PR, forbids force-pushes and deletions, and has
  no bypass actors.
- Work happens on a branch, usually in a worktree, and arrives as a PR
  with CI green.
- A human merges. Agents open PRs; they do not approve or merge them, not
  even their own.

## Working from a clone

```sh
npm install
npm link            # once: `brane` now resolves to this checkout
npm run build       # Compile TypeScript + build the Expo web bundle
```

`npm link` points your global `brane` at `<repo>/dist/cli.js`, so every
later `npm run build` is picked up without reinstalling; after a
server-side change, `brane daemon restart` puts the daemon on it. To go
back to a published release, `npm unlink -g brane` and then
`npm install -g brane`.

## Disclosure: say when an agent helped

Every commit an agent wrote or substantially shaped carries a trailer naming
the agent and the model version:

```
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

This is the form Claude Code emits and the form the history already uses on
most commits since 2026-02-28. The kernel-style
`Assisted-by: <tool>:<model>` trailer is equally acceptable for contributors
whose tools emit it. The trailer is a disclosure, not an attribution of
authorship: it records that a model was involved so a reader can tell, the
same way `Assisted-by:` does in the Linux kernel, Fedora, and LLVM. An
agent never removes or rewrites a trailer. The human who signs off on a
commit may rewrite it, trailer included, and by doing so takes sole
responsibility for its contents; that is what signing off means.

## Sign-off: humans only

Responsibility for a change belongs to a person. Concretely:

- **An agent never adds `Signed-off-by:`.** The Developer Certificate of
  Origin is a legal certification that the signer has the right to submit
  the work under the project's license. A model cannot hold copyright,
  enter an agreement, or take responsibility, so it cannot certify
  anything, and an agent must not write a sign-off on a human's behalf.
- **Outside contributors sign off.** Add
  `Signed-off-by: Your Name <you@example.com>` to each commit
  (`git commit -s`), certifying the
  [Developer Certificate of Origin 1.1](https://developercertificate.org/).
  Brane asks for a DCO sign-off rather than a contributor license
  agreement.
- **The maintainer's own changes are signed off by the merge.** Brane's
  history predates this file and does not carry `Signed-off-by` on every
  commit. For changes the maintainer lands, reviewing and merging the PR
  is the accountability step, so agents committing in the maintainer's
  checkout do not add a sign-off for the maintainer.
- **Understand what you submit.** Whoever signs off or merges is expected
  to have read the change, be able to explain it, and stand behind its
  correctness and licensing. "The agent wrote it" is a disclosure, not a
  defense.

## Licensing

Brane is AGPL-3.0-or-later (see `LICENSE`). Every contribution is accepted
under that license. Do not submit code you are not entitled to license
that way, including code whose origin you cannot account for.

## Security

Do not open a public issue for a vulnerability. See `SECURITY.md`.

## For agents

The same rules, phrased as instructions, are in `AGENTS.md` under
"Commits, Sign-off, and Accountability". Brane's own agents read that file
at startup.
