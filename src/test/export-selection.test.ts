import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatSeqModeParam,
  formatSeqParam,
  parseSeqModeParam,
  parseSeqParam,
  exportFileName,
  seqDigest,
} from "../shared/export-selection.js";

describe("formatSeqParam", () => {
  it("writes ascending, deduped decimal seqs", () => {
    assert.equal(formatSeqParam([19, 12, 14, 12]), "12,14,19");
  });

  it("is null when there is nothing to send", () => {
    assert.equal(formatSeqParam([]), null);
    assert.equal(formatSeqParam(null), null);
    assert.equal(formatSeqParam(undefined), null);
  });

  it("drops values that are not seqs", () => {
    // seq numbering starts at 1, so 0 and negatives name nothing.
    assert.equal(formatSeqParam([0, -3, 1.5, 7]), "7");
    assert.equal(formatSeqParam([0]), null);
  });

  it("takes a Set, which is the shape the chat keeps its selection in", () => {
    assert.equal(formatSeqParam(new Set([3, 1, 2])), "1,2,3");
  });
});

describe("parseSeqParam", () => {
  it("reads what formatSeqParam writes", () => {
    const seqs = [4, 17, 23];
    assert.deepEqual(parseSeqParam(formatSeqParam(seqs)), seqs);
  });

  it("is empty for an absent or blank parameter", () => {
    assert.deepEqual(parseSeqParam(null), []);
    assert.deepEqual(parseSeqParam(undefined), []);
    assert.deepEqual(parseSeqParam(""), []);
    assert.deepEqual(parseSeqParam(",,"), []);
  });

  it("ignores junk rather than refusing the export", () => {
    assert.deepEqual(parseSeqParam("3,abc,5"), [3, 5]);
    assert.deepEqual(parseSeqParam("12abc"), [], "a partial number is not a seq");
    assert.deepEqual(parseSeqParam("-1,0,2.5,2"), [2]);
    assert.deepEqual(parseSeqParam("nonsense"), [], "unreadable means no selection, which means a full export");
  });

  it("sorts and dedupes whatever order it arrives in", () => {
    assert.deepEqual(parseSeqParam("9, 2 ,9,2,5"), [2, 5, 9]);
  });

  it("reads plain decimal digits only — `Number` accepts more than a seq", () => {
    // Each of these is a number to `Number()` and a message nobody picked.
    assert.deepEqual(parseSeqParam("1e2"), []);
    assert.deepEqual(parseSeqParam("0x10"), []);
    assert.deepEqual(parseSeqParam("+4"), []);
    assert.deepEqual(parseSeqParam("5.0"), []);
    assert.deepEqual(parseSeqParam("0b11,0o7"), []);
    assert.deepEqual(parseSeqParam("9007199254740993"), [], "past MAX_SAFE_INTEGER, Number() rounds to a different seq");
    assert.deepEqual(parseSeqParam("007"), [7], "leading zeros are still decimal");
    assert.deepEqual(parseSeqParam("9007199254740991"), [9007199254740991], "MAX_SAFE_INTEGER itself is a seq");
    assert.deepEqual(parseSeqParam("1e2,3"), [3], "a rejected part drops alone; the rest of the list stands");
  });
});

describe("exportFileName", () => {
  it("a full export keeps the name sibling exports link to", () => {
    assert.equal(exportFileName("claude-aaaaaaaa"), "claude-aaaaaaaa.html");
    assert.equal(exportFileName("claude-aaaaaaaa", null), "claude-aaaaaaaa.html");
  });

  it("an excerpt carries its count and a digest of its seqs", () => {
    assert.match(exportFileName("claude-aaaaaaaa", { seqs: [2, 5, 9], total: 47 }), /^claude-aaaaaaaa\.3-of-47\.[0-9a-f]{6}\.html$/);
  });

  it("two excerpts of the same size are two names — `only` and `except` of a half-selection included", () => {
    // seqs [1,4] of four messages: `only` exports 1,4 and `except` exports 2,3.
    // Both are 2-of-4; the count alone gave them one name.
    const only = exportFileName("claude-aaaaaaaa", { seqs: [1, 4], total: 4 });
    const except = exportFileName("claude-aaaaaaaa", { seqs: [2, 3], total: 4 });
    assert.notEqual(only, except);
  });

  it("the digest depends on the set, not the order it was tapped in", () => {
    assert.equal(seqDigest([9, 2, 5]), seqDigest([2, 5, 9]));
    assert.notEqual(seqDigest([1, 23]), seqDigest([12, 3]), "the separator keeps 1,23 and 12,3 apart");
  });
});

describe("the selection's mode", () => {
  it("reads what it writes", () => {
    assert.equal(parseSeqModeParam(formatSeqModeParam("except")), "except");
    assert.equal(parseSeqModeParam(formatSeqModeParam("only")), "only");
  });

  it("leaves the default off the URL", () => {
    // An ordinary excerpt's link stays the one brane built before a complement
    // was possible — the parameter appears only when it changes something.
    assert.equal(formatSeqModeParam("only"), null);
    assert.equal(formatSeqModeParam(null), null);
    assert.equal(formatSeqModeParam(undefined), null);
    assert.equal(formatSeqModeParam("except"), "except");
  });

  it("inverts an export only on the exact word", () => {
    // The tolerance runs one way on purpose: a garbled parameter must never
    // hand the operator the complement of the document they asked for.
    assert.equal(parseSeqModeParam("except"), "except");
    assert.equal(parseSeqModeParam(" except "), "except");
    for (const junk of ["Except", "EXCEPT", "exclude", "excluded", "!", "1", "true", "", " "]) {
      assert.equal(parseSeqModeParam(junk), "only", `${JSON.stringify(junk)} is not "except"`);
    }
  });

  it("is `only` when absent, which is what every export was", () => {
    assert.equal(parseSeqModeParam(null), "only");
    assert.equal(parseSeqModeParam(undefined), "only");
  });
});
