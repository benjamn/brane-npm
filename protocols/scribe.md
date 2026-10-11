# /scribe [target]

Take human dictation and render it faithfully into a progressively more
complete document, without embellishment. The operator dictates; the
scribe commits only what the operator **endorses**, in the operator's own
voice, and nothing more. The scribe is a **faithful recorder, not an
author** — its fidelity to the source *is* the job.

`/scribe` is the near-mirror of [`/wiki`](wiki.md): the wiki forbids the
agent from inventing *concepts*; the scribe forbids it from inventing
*words*. Anything on the page the operator did not endorse is a defect.

The endgame is a fully voice-driven tool — speech-to-text in,
text-to-speech read-back out — so every rule holds when the operator
can't see the screen and must trust their ears. That makes fidelity
load-bearing, not aspirational.

## Prime directive

**No content enters the document except as a faithful rendering of
something the operator endorsed** — composed, pasted, or authorized by
reference (see *Provenance*). The scribe contributes no substance of its
own: no invented sentences, no connective tissue, no "the author notes
that…", no polishing a rough idea, no filling a gap with a guess. When
tempted to add, it raises an **open question** and waits.

The page is in the **operator's voice**, their phrasing preserved. The
scribe's own voice appears only in read-backs and open questions, never
in document prose.

## Target, up front

A session **begins by fixing its destination** — the operator names the
artifact (usually a markdown file) before any dictation is committed:

```
/scribe spec.md
```

- **File doesn't exist** → the scribe creates it and starts an empty
  manifest (see *The ledger*).
- **File exists** → the scribe **adopts** it: its current content becomes
  one or more `baseline` fragments — preserved and rendered, but with no
  endorsement chain (a later `/notary` pass marks baseline ungrounded).
  The scribe never claims baseline content as human-authored.
- **No target set** → the scribe's first act is to ask for one; nothing
  is committed until a destination exists.

The target is **sticky**: dictation lands there until the operator
redirects (`/scribe other.md`) or exits.

## Latched session

Dictation is continuous — the operator won't prefix every sentence,
least of all by voice — so the scribe **latches**:

- `/scribe <target>` opens a resident session.
- While latched, **every** `human_signal` is handled by the scribe (as
  prose, instruction, query, or correction), not as a general LIVE-loop
  request.
- `/scribe stop` closes it; the scribe confirms and returns to the
  ordinary loop.

If something plainly outside the writing task arrives while latched, the
scribe raises an open question ("didn't sound like dictation — step out
of the session?") rather than silently acting or transcribing.

## Channels: four kinds of utterance

Every latched `human_signal` is one of four things, never bleeding
together:

1. **Prose** — content to render, in the operator's voice.
2. **Instruction** — a directive about the document's *shape*: "intro
   goes last," "keep §3 before §2," "put the pricing bit under §2." May
   be **standing** or one-off. Changes fragment *metadata* (placement,
   ordering), never fragment *text*.
3. **Query** — a question *about* the document that changes nothing:
   "read me back §2," "word count?" Answered from the render; no change.
4. **Correction / retraction** — a change to what's there: an in-flight
   fix ("no, make that fifteen percent") **supersedes** a fragment; a
   retraction ("strike that") **retracts** one.

**Disambiguation is hybrid:** infer the channel from phrasing by default;
reserved mode-words override when the operator wants certainty (`note:` /
`instruction:` mark an instruction, `scribe:` addresses the scribe,
`verbatim:` forces prose — for dictating text that *itself* begins with a
mode-word, e.g. writing documentation about scribe; plain speech is
prose); the **read-back is the safety net** — a misclassification is
caught on the next breath. When genuinely uncertain *and* the guess would
change the document, the scribe **asks**. A wrong silent guess is exactly
the embellishment this protocol prevents.

## The per-utterance loop

For **every** latched `human_signal`, in order:

1. **Classify** the channel (prose / instruction / query / correction).
2. **Apply the fidelity licence** and create or modify **fragment(s)** in
   the manifest — never edit document text directly.
3. **Re-render** the target wholesale from the manifest (see *Projection*).
4. **Verify** the render equals a fresh recompute from the manifest,
   byte-for-byte; on mismatch, **fail closed** — re-render, do not proceed.
5. **Read back** the fragment delta and cite the endorsing seq.
6. **Update `meta.summary`** to `Scribe: <target> — §<current section>`.

Queries touch neither manifest nor file — answer from the current render
and read back. Everything else runs the full loop.

## The ledger: fragment, manifest, projection

The document is **not the store** — it is a *projection*. The store is a
ledger of endorsed fragments; the file is regenerated from it on every
change. Nothing is ever edited in place, so nothing untouched can be
silently relexed: *the document is a projection; the log is the
notarized ledger.*

**Fragment — the unit of record.** Each endorsed utterance yields at most
one fragment: the operator's words, verbatim after the fidelity licence.
A fragment carries:

- `id` — a stable handle, `f<seq>` of the endorsing signal (`baseline-N`
  for adopted content).
- `endorse` — the endorsing `human_signal` `nid:seq` (`null` for
  baseline).
- `origin` — for adopted-by-reference passages, the `nid:seq` the words
  came from; else `null`. Two-coordinate provenance: *who authorized*
  distinct from *where the words came from*.
- `section` — the placement label (which outline section it belongs to);
  `null` ⇒ appended at document end.
- `status` — `active` · `superseded:<id>` · `retracted` · `baseline`.
- `text` — the verbatim content.

**Manifest — the working store.** A sidecar next to the target:
`<target>.scribe.json`. It holds the ordered section outline, every
fragment record (**never deleted** — only its `status` changes), standing
instructions, open questions, and the hash of the last render. The event
log remains ground truth for audit; the manifest is the machine-checkable
index into it. Maintain it with ordinary file tools until a future
`brane scribe` command owns it.

```json
{
  "target": "spec.md",
  "sections": ["Overview", "Pricing", "Deployment"],
  "fragments": [
    { "id": "f7", "endorse": "claude-4anserzq:7", "origin": null,
      "section": "Pricing", "status": "active",
      "text": "Pricing starts at fifteen percent of contract value." }
  ],
  "standing": ["Introduction goes last."],
  "questions": [
    { "id": "q9", "kind": "hole", "text": "§Deployment named, not yet dictated." }
  ],
  "render_hash": "sha256:…"
}
```

**Projection — the document is rendered, never edited.** On every change,
regenerate the target `.md` wholesale: section headings in outline order,
then each section's `active` fragments in manifest order, then the
scribe-notes block. Rendering is **mechanical copying** — the agent
assembles the file *by reading `text` out of the manifest*, never by
recalling prose from context. Writing (overwriting) the target is the
*render mechanism* and is expected; the ledger, not the file, is the thing
never rewritten from memory.

**Render verification — the fail-closed gate.** The render is a *pure
function of the manifest* — headings from `sections`, each section's
`active` fragments in order, then the notes block. So verification is
**deterministic equality**: recompute the expected render from the
manifest and require it to match the file on disk **byte-for-byte**. Any
mismatch ⇒ re-render; never accept a render that doesn't match. This is
strictly stronger than the old snapshot→diff gate — one check proves at
once that every fragment is present and faithful, that **nothing
unendorsed was inserted between fragments**, and that the order is
correct. And because the check is a pure recompute, a dumb tool can run
it — a future `brane scribe render --check`, the notary, or the operator
— so fidelity never rests on the agent's discipline.

**Placement — no cursor.** The operator never manages an insertion point.
A fragment's `section` is set from the section the operator most recently
named; absent any, it appends at document end. "Put the pricing bit under
§2" is a **metadata change** (set `section`) plus a re-render — no text
surgery. The scribe never *guesses* placement: ambiguous placement stays
an open question. Directed placement is faithful; invented placement is
embellishment.

**Corrections and retractions.** "No wait, fifteen percent" → a **new**
fragment (endorsed by the correcting seq) whose `status` supersedes the
old one; the superseded record stays in the manifest, absent from the
render. "Strike that" → set the fragment's `status` to `retracted` (text
preserved in the manifest, absent from the render). No in-place text edit
exists anywhere in this protocol.

**Drift guard.** Before each render, compare the on-disk file to the
manifest's `render_hash`. A mismatch means the file was hand-edited since
the last render. **Never clobber silently:** raise an open question. If
the operator endorses the drift, adopt it as a fragment endorsed by that
signal; otherwise the next render restores the manifest's truth.

## Fidelity line

Faithful is not literal-to-a-fault; speech carries noise the operator
doesn't intend as content. The licence is narrow and fixed:

**Permitted** (faithful to intent): strip disfluencies ("um," false
starts, stumbles); honor explicit self-corrections (commit the corrected
form, not the abandoned one); normalize mechanical surface (casing,
obvious punctuation, implied paragraph breaks).

**Forbidden** (embellishment): adding, sharpening, or "improving" any
substantive word; reordering beyond an explicit instruction; resolving an
ambiguity by guessing intent; expanding a pronoun or reference unless its
referent is unambiguous in the immediate dictation — otherwise raise an
open question.

Every substantive word is preserved. When in doubt, preserve and ask.

## Scribe notes: holes and standing instructions

Standing instructions and open questions aren't prose but belong *with*
the document. They live **only in the manifest** (`standing`,
`questions`) and are **rendered** into a visible, scribe-owned block at
the foot of the file — one source of truth, so the block and any inline
markers can never drift apart:

```markdown
<!-- SCRIBE:BEGIN -->
## Scribe notes
**Standing instructions**
- Introduction goes last.
**Open questions**
- [order?] Pricing paragraph under §2 or its own section?
- [hole] §Deployment named but not yet dictated.
<!-- SCRIBE:END -->
```

- **Holes** (sections named but not dictated) and **debates** (order,
  referent, ambiguity) are `questions` entries; the render surfaces each,
  including any inline `> [SCRIBE: …]` marker at its location.
- The scribe **never resolves an open question itself** — that would be
  authoring. It waits for the operator, then applies the resolution
  (a manifest change + re-render) and drops the `questions` entry.
- **Standing instructions apply retroactively.** "Intro goes last" sets
  placement metadata now, is read back, and is recorded in `standing` to
  govern future work.

## Read-back: the operator's only mirror

In a voice-only session the read-back is the *sole* way to catch an
embellishment, so it is **mandatory** and **derived from the fragment
delta** (what the utterance created, superseded, or retracted), never from
recollection of intent:

- **Cadence:** one concise read-back **per `human_signal`** — what
  changed, plus any open question raised. Full-document read-back only on
  request.
- **Form (two-part):** a **speakable sentence** first — TTS reads this
  ("Added to §Pricing; one question: before or after the terms?") —
  followed by the committed **fragment text verbatim** in a fenced block,
  the literal audit record:

  ```
  Pricing starts at fifteen percent of contract value.
  ```
- **Content is literal, never a paraphrase.** Cite the endorsing seq via
  `re:` and in text; for adopted content also name the `origin` seq.

## Provenance: every fragment carries a human endorsement

The document is built so a later, independent
[`/notary`](#the-notary-a-separable-follow-on) pass can prove **every
fragment was endorsed by the operator**, and quantify *how*. Two brane
guarantees make it possible:

- **`source` is stamped server-side and cannot be spoofed** — a
  `human_signal` is provably operator-originated.
- **`seq` is monotonic and append-only** — `nid:seq` is an immutable
  coordinate for a specific human utterance.

The scribe's obligations:

1. **Admission rule.** Every fragment must carry an **operator
   endorsement** delivered through a `human_signal`. Endorsement is read
   *maximally* — composing words fresh, pasting them, **or authorizing a
   previously discussed passage by brief reference** ("add the pricing
   paragraph the agent drafted"). A reference is dictation in the
   abstract: the operator adopts an *identified* passage without
   re-uttering it. Forbidden is only the *scribe* pulling agent content
   in **on its own initiative**. When admitting by reference: the
   referent must be **unambiguous** (resolve to a specific `nid:seq`, else
   raise an open question — *which* passage?), and the retrieved passage
   is **rendered faithfully** (copied into the fragment `text`, not
   rewritten or "improved").
2. **Citation.** Each committing read-back cites the **endorsing
   `human_signal` seq** (the fragment's `endorse`, via `re:` and in text).
   For content admitted by reference, it *also* names the fragment's
   `origin` seq — distinguishing *where the words came from* from *who
   authorized them*, which makes the retrieval independently auditable.
3. **Grain.** Provenance is tracked per **fragment**. Reorders and
   re-placements move fragments without changing their `text`, so
   provenance rides along untouched.

The **canonical store is the event log**, not the document, and not the
manifest — the manifest is a convenience index and the document a
projection. The spoof-proof record is the chain of
`human_signal → citing read-back` events.

### What the chain proves: endorsement, not origination

Brane witnesses the **channel**, and that is enough. What passes through
the `human_signal` channel is, by that act, **adopted by the operator as
their own** — composed, recalled, or pasted alike. Copy-paste is **not
laundering and not discouraged**: sending something through the human
channel *is* the decision that "this is what I would have said." The chain
proves *every fragment was endorsed and faithfully rendered without the
agent adding anything unendorsed.* It does not prove where the operator's
ideas came from — **origination is unmeasurable and beside the point;
endorsement is what authorship has always meant.** A signature never
certified you originated the language, only that you adopted it.

The trust model is asymmetric **by design**: the system **distrusts the
agent** (fenced by the admission rule and the render-verification gate)
and **trusts the operator** (their endorsement is definitional). If you
wouldn't trust the operator's endorsement, no provenance system helps —
they're the authoring principal, not a party under audit.

So the notary's core metric is a **three-way split**, not a single
"endorsed fraction":

- **composed** — the operator supplied the words;
- **adopted** — the operator authorized an agent-originated passage by
  reference (endorsed, not their words);
- **unendorsed** — baseline, or a fragment added in violation of the
  admission rule (no endorsement).

"Endorsed" alone isn't the discriminator: an operator could authorize a
whole agent draft by reference — 100% endorsed, 0% composed, fully
legitimate but not the same as one they wrote. **Composed vs. adopted** is
what carries weight; ghostwriting surfaces as low-composed or
high-unendorsed, never as composed. This is the defensible reading of
"prove exactly how much of it is yours": your *words* (composed), your
*choices* (adopted), and what is *neither* (unendorsed).

## The notary: a separable follow-on

Notarization — *attesting* the chain holds — is a **different job** from
authoring, and wants to be structurally independent: a notary who wrote
the document is a weak notary. The scribe's citation discipline is the
evidence base a future `/notary` pass consumes to emit a
fragment-by-fragment attestation and the composed/adopted/unendorsed
split. The scribe lays the rails; it does not self-attest. `/notary`'s
own protocol is a follow-on, not part of this document.

## Skill vs. protocol — what Brane adds

Most of this document is portable: the behavioral spec (fidelity line,
channel-sorting, ledger discipline, open-question reflex) is
agent-interpreted prose that could live as a harness *skill*
(`.claude/skills/scribe.md`). That part is **not Brane-specific**.

Brane's irreducible contribution is **evidence, not behavior**: an
authority-stamped boundary between human and machine content. A skill's
only record is its own agent's transcript — single-party, ephemeral,
certifying nothing about which bytes were human; a process cannot
notarize its own inputs. Brane's log can, because `source` is stamped by
a party neither operator nor agent controls, and the log is append-only
and independently re-verifiable.

Scoping:

- **No provenance proof needed** → a `/scribe` *skill* is equivalent and
  simpler. Prefer it.
- **A provable human/AI split matters** — "no reliance on AI" (a fully
  *composed* document) or honest disclosure of what was *adopted* → only
  the Brane substrate delivers it.

The slogan: **"write with agent assistance — then prove exactly how much
of it is yours."** Read "yours" as *endorsed by you*. In one line: **the
skill gives you *faithful*; the log gives you *provable*.**

## Recovery

The manifest plus the event log are the **complete** session state — the
latch, target, ledger, and open questions all persist outside agent
context. After compaction or a revive:

1. `whoami`, then `listen` with `tail` to reload recent context.
2. Scan back for the most recent `/scribe <target>`; if it has no
   matching `/scribe stop`, the **latch is still on** and `<target>` is
   the sticky destination.
3. Reload `<target>.scribe.json` — it *is* the working state; re-render
   from it and verify. Nothing is lost.
4. If the current section is uncertain, read back the tail and **confirm
   with the operator** rather than guess.

## Golden rule

The scribe **never deletes files, git history, or any artifact** on its
own. Dictated *retraction* ("strike that sentence") sets a fragment's
`status` to `retracted` — the text leaves the render but stays in the
manifest, and the retraction command is itself the `human_signal` of
record — so the file and everything around it are never removed. Prefer
`cp` over `mv`; if something seems to need deletion, surface it to the
operator. See /prelude's Golden Rule.

## Quick reference

| Operator utterance | Channel | Manifest operation |
|---|---|---|
| Plain speech | Prose (composed) | Append `active` fragment, cite endorse seq |
| "add the pricing bit we discussed" | Prose (adopted by reference) | Append fragment with `origin`, cite endorse + origin |
| "intro goes last" | Instruction (standing) | Set placement, record in `standing`, re-render |
| "put the pricing bit under §2" | Instruction (placement) | Set fragment `section`, re-render |
| "read me back §2," "word count?" | Query | None — answer from render |
| "no wait, X" | Correction | New fragment supersedes prior, re-render |
| "strike that" | Retraction | Set `status: retracted`, re-render |
| Referent or placement unclear | (open question) | Add `questions` entry, wait |
| `/scribe stop` | Session control | None — closes session |

## Related protocols

- **[LIVE_loop](LIVE_loop.md)** — the loop this runs inside; source of the
  `human_signal` guarantees provenance depends on.
- **[wiki](wiki.md)** — sibling faithful-rendering protocol; shares the
  fidelity and provenance disciplines.
- **[review](review.md)** — precedent for keeping verification independent
  of production (the scribe/notary split).
