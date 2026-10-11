import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { WordPieceTokenizer } from "../memory/wordpiece.js";
import { MODEL_REPO, ensureFile } from "../memory/embedder.js";
import { WORDPIECE_GOLDEN } from "./fixtures/wordpiece-golden.js";

/**
 * `src/memory/wordpiece.ts` exists to reproduce transformers.js's tokenizer
 * exactly, so these tests assert *agreement*, not reasonableness. The golden
 * ids in the fixture came from `AutoTokenizer` while that package was still
 * installed; a mismatch here means query vectors have drifted away from what
 * `memory_vec` already holds, which nothing else would surface.
 *
 * `tokenizer.json` (~700 KB) is fetched into the model cache on a cold run
 * rather than skip-gating the suite: this assertion is the one the embedder
 * swap rests on, so it has to run everywhere, CI included.
 */

const tok = WordPieceTokenizer.fromFile(await ensureFile(MODEL_REPO, "tokenizer.json"));

describe("WordPieceTokenizer", () => {

  it("reproduces transformers.js token ids exactly", () => {
    for (const { text, ids } of WORDPIECE_GOLDEN) {
      assert.deepEqual(
        tok!.encode(text).input_ids,
        ids,
        `token ids differ for: ${JSON.stringify(text.slice(0, 60))}`,
      );
    }
  });

  it("wraps in [CLS]/[SEP] and reports a matching attention mask", () => {
    const enc = tok!.encode("hello world");
    assert.equal(enc.input_ids[0], tok!.clsId);
    assert.equal(enc.input_ids.at(-1), tok!.sepId);
    assert.equal(enc.attention_mask.length, enc.input_ids.length);
    assert.ok(enc.attention_mask.every((m) => m === 1));
    assert.ok(enc.token_type_ids.every((t) => t === 0));
  });

  it("truncates the post-processed sequence, dropping [SEP] rather than reserving room", () => {
    // Deliberately pinned: HuggingFace truncates *after* adding both special
    // tokens, so an over-long text ends on an ordinary token. Reserving two
    // slots to keep [SEP] is the intuitive reading and disagrees with the
    // reference on every long input — see the comment in wordpiece.ts.
    const enc = tok!.encode("one two three ".repeat(500));
    assert.equal(enc.input_ids.length, tok!.modelMaxLength);
    assert.equal(enc.input_ids[0], tok!.clsId);
    assert.notEqual(enc.input_ids.at(-1), tok!.sepId);
  });

  it("pads a batch to its longest member and masks the padding", () => {
    const batch = tok!.encodeBatch(["hi", "a considerably longer sentence here"]);
    const width = batch.input_ids[0].length;
    assert.equal(batch.input_ids[1].length, width);
    assert.equal(batch.attention_mask[0].length, width);

    const short = batch.input_ids[0];
    const mask = batch.attention_mask[0];
    // Every padded position must be [PAD] with mask 0, or mean pooling would
    // fold padding into the vector and a batched text would embed differently
    // from the same text alone.
    for (let i = 0; i < width; i++) {
      if (mask[i] === 0) assert.equal(short[i], tok!.padId);
    }
    assert.equal(mask.reduce((a: number, b: number) => a + b, 0), tok!.encode("hi").input_ids.length);
  });

  it("treats a whole word as unknown when any piece is unmatchable", () => {
    // BERT's rule, and load-bearing: a per-piece fallback would produce
    // different ids for any word containing an unseen character.
    const ids = tok.tokenize("\u{10FFFF}\u{10FFFE}");
    assert.deepEqual(ids, [tok.unkId]);
  });

  it("encodes an empty string as just the special tokens", () => {
    assert.deepEqual(tok!.encode("").input_ids, [tok!.clsId, tok!.sepId]);
  });
});
