# Export Scope

An export is the whole conversation, the messages the operator picked, or
everything but them. The picking is not new: the chat has kept a selection
since `re` chips existed — tap a bubble's timestamp and its seq joins
`selectedSeqs` (`expo/app/[nid].tsx`), which is what the composer attaches
to the next signal as `re`. Export reads the same set, as *"these ones"* or
as *"all but these"*.

| Piece | Where | Does |
|---|---|---|
| `MessageSelection` | `src/shared/message-selection.ts` | The selection itself, with per-seq subscriptions — see [The Selection Store](selection-store.md) |
| `formatSeqParam` / `parseSeqParam` | `src/shared/export-selection.ts` | The `seqs=12,14,19` grammar, both halves in one module; `src/test/export-selection.test.ts` |
| `SeqSelectionMode` | `src/shared/export-selection.ts` | Which side of it: `only` (the default) or `except`, on the wire as `seqs_mode` |
| `selectedCount` / `ExportScope` | `src/shared/narrative-menu.ts` | Splits the 🦠 item into **📨 Export 2 selected** and **📤 Export 2 excluded**, and tells the press which one — the list card has no selection and passes nothing |
| `ExportOptions.seqs` / `.seqsMode` | `src/export.ts` | Keeps (or drops) those events, counts the gaps, writes the disclosure |

Seven things are less obvious than they look:

**An excerpt says it is one, in the line that used to say how many.**
`Exported … · 3 of 47 messages` is the whole disclosure, and it is
load-bearing: the reader of an exported file is generally not the operator
who made it, and a 3-message document that does not mention the other 44
reads as a short conversation rather than a quotation from a long one.

**A gap between two shown messages is marked; a gap before or after them is
not.** `⋯ 4 messages not shown` sits between non-adjacent picks, because
two bubbles stacked in a transcript otherwise assert adjacency — the one
claim an excerpt must never make by accident. What was dropped from the
ends is already covered by the header's count, and marking it would put an
elision row at the top of nearly every excerpt.

**Anchors stay `#seq-N`.** Rows are not renumbered, so `nid:seq` citations
into an excerpt mean what they mean everywhere else, and a full export and
an excerpt of the same narrative agree on every link. It is also why the
selection travels as seqs rather than as an index range.

**An unreadable `seqs` exports everything rather than failing.** An export
is a read; a 400 would cost the operator their transcript over a typo in a
URL they probably did not type. Empty, absent, and junk all mean "no
selection", and `{ seqs: [] }` is byte-identical to the export brane made
before this parameter existed — pinned by `src/test/export.test.ts`.

**The mode's tolerance runs one way.** Only the exact word `except`
inverts an export; `Except`, `exclude`, `1` and junk all read as `only`.
The asymmetry is the point: a garbled `only` hands the operator a document
whose header already says how much of the conversation it holds, while a
garbled `except` would hand them the *complement* of what they asked for —
and a selection is as often "the messages nobody else should read" as it is
"the interesting ones". For the same reason the parameter is written only
when it changes something, so an ordinary excerpt's URL is unchanged.

**An excerpt's file name carries its count; a redaction leaves the summary
out.** The 💾 button saves `<nid>.html` for a full export and
`<nid>.3-of-47.<digest>.html` for either scope (`exportFileName`): the count
the header discloses, plus six hex digits naming exactly which seqs it holds.
The count alone gave `only` and `except` of a half-selection one name, and
they are the pair a redaction exists to keep apart. Like the header, the name
doesn't say which side of the line was taken. An `except` export drops
the narrative's summary, which is agent-written over the whole conversation
and can paraphrase exactly what was left out.

**The complement reads the conversation; the excerpt does not.** `seqs IN
(…)` is an index lookup per selected message, which is why exporting two
messages out of ten thousand costs two rows. Excluding two of ten thousand
exports 9,998 of them, so it reads the log and drops the picks — a full
export's cost, which is what it is. Both scopes then disclose identically:
`3 of 47` and `44 of 47` are both excerpts, and neither says which side of
the line it took.
