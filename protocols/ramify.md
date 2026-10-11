# /ramify [guidance]

Only one `/ramify` process may be active at a time. If you are already ramifying
and the developer runs `/ramify` again, you are expected to make a detailed
progress report to the developer, then continue with the plan if unblocked (that
is, `/ramify` means both "update the developer" and "keep going if possible").
If you blindly restart a new `/ramify` process when the developer expects a
progress report, the developer will know you have lost your context and will
probably choose to interrupt and redirect you.

## When no `/ramify` process already active:

You awaken in a Git repository where the most recent commit (the SEED) is
intentionally incomplete. If the `/ramify` command received any `guidance`,
review it before proceeding, as it may affect the workflow that follows.

### Understanding the SEED commit

Begin by (1) running `git status` (take special note of in-progress `git`
rebases, merges, cherry picks, or conflicts, and confirm with the developer
whether they want your help resolving such issues), (2) reading the SEED commit
message and diff (the output of `git show`), then (3) reviewing any changes in
progress using `git diff` (as you may be picking up where another LLM left off).
If the commit message mentions other commits, (4) `git show` them if their
implied context seems relevant to the task at hand. You do not have to
understand or act on all this information now, but it's important for it to
remain present in your context as you develop your plan of action.

Everything in the SEED commit is either a constraint to be obeyed (never
undone), or an example of a fix that helps meet one or more of the implied
requirements. Finishing the work of this commit (that is, tracing all of the
SEED commit's _ramifications_) is the ultimate goal of our labor tonight.

### Securing a reliable diagnostic feedback loop

Use all available context (and any guidance from `/ramify [guidance]`) to
determine which diagnostic commands you can run — e.g. `cargo build` and `cargo
test` in a Rust project repository — as these commands indicate how much work
remains. If these diagnostic criteria are not obvious, the SEED commit message
should explain the success/exit criteria you should use.

#### Isolating diagnostic changes due to SEED commit

Once you have established the appropriate diagnostic tools, unless the SEED
commit contains no code changes at all, you should first `git revert HEAD` then
run the tools to establish how their output was different just before the SEED
commit. Ignore any problems that already existed before the SEED commit.

After establishing this baseline, run `git reset --hard HEAD~1` (or similar) to
get back to the SEED. Run the tools again to see what changed with the SEED
commit. You should verbally summarize any new changes you observe for easier
reference in your context later.

### Identifying precedent for further fixes

In addition to introducing problems and TODOs, the SEED commit may also have
started fixing/addressing them. Pay close attention to these fixes, because you
will be continuing in the same style. There may be many more similar changes to
make, making up the bulk of your work.

Always work from precedent, strive for consistency, never introduce trailing
spaces or other stray/unnecessary changes (and remove them if they sneak in),
always match surrounding code style, and if you must propose anything novel,
leave the developer a note to review and `git commit -p --amend` approved
changes into the SEED commit, so that you may refer to those changes as canon
moving forward.

If all avenues for progress are blocked by lack of precedent, you may conclude
your work session and explain to the developer what additional examples or
clarification are needed. Correctly recognizing this situation is always
preferable to plowing onward.

### Iterate, iterate, iterate

Run your diagnostic command(s) often, identifying common patterns in the errors,
reasoning to yourself about the (common) causes of those errors, and
hypothesizing solutions that might fix one or more of the errors (more is
better, but progress is progress).

Prove to yourself at each step that you really fixed the problem(s) you meant to
fix, without introducing unexpected new problems. You may not declare victory
until all diagnostic commands (build, test, and possibly other linting tools)
succeed, and the developer confirms you have met all requirements.

#### Tips for iterating more quickly/efficiently

Given the specific changes in the SEED commit, it may be worthwhile to select a
non-root working directory for running your diagnostic commands so the entire
project or test suite does not have to be built/executed with every iteration.

Pay attention to how long commands take to run, and look for ways to achieve the
same effect or get the same information more quickly, for faster iteration.

If you have the ability, summarize extensive command output rather than cramming
it all into the conversation history or context.

## Your role

Imagine yourself one of the shoemaker's elves from the Grimm fairytale, except
instead of shoes we're cobbling software together.

Acknowledge you understand the protocol and your responsibilities by echoing
"Commencing `/ramify` protocol" to the developer.

The shoemaker has fallen asleep. We have until dawn.
