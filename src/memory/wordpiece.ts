/**
 * A BERT WordPiece tokenizer, read straight from a HuggingFace `tokenizer.json`.
 *
 * This exists so brane can embed text without `@huggingface/transformers`,
 * whose omnibus package drags in `onnxruntime-web` (91 MB) and `sharp` (whose
 * libvips advisories are the only findings in a root `npm audit`) purely to
 * support modalities and runtimes brane never uses. What brane actually needs
 * from that package is this file plus one ONNX session.
 *
 * The implementation is a deliberate port of transformers.js's own
 * `BertNormalizer`, `BertPreTokenizer` and `WordPieceTokenizer`, not an
 * independent reading of the BERT paper. Token ids must match the previous
 * pipeline *exactly*: `memory_vec` already holds vectors embedded the old way,
 * and a tokenizer that disagrees on even a rare word doesn't fail — it quietly
 * shifts query vectors away from the stored ones and degrades search in a way
 * no error surfaces. `src/test/wordpiece.test.ts` pins the agreement.
 */

import { readFileSync } from "node:fs";

/** Matches transformers.js's PUNCTUATION_REGEX (`src/tokenizers.js`): Unicode
 *  punctuation plus the ASCII symbol ranges BERT also treats as punctuation. */
const PUNCTUATION =
  "\\p{P}\\u0021-\\u002F\\u003A-\\u0040\\u005B-\\u0060\\u007B-\\u007E";

/** CJK ranges that BERT surrounds with whitespace so each char is its own token. */
function isChineseChar(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

/** Control characters, excluding the three whitespace ones BERT keeps. */
const CONTROL_RE = /^\p{Cc}|\p{Cf}|\p{Co}|\p{Cs}$/u;
function isControl(char: string): boolean {
  if (char === "\t" || char === "\n" || char === "\r") return false;
  return CONTROL_RE.test(char);
}

interface NormalizerConfig {
  clean_text?: boolean;
  handle_chinese_chars?: boolean;
  strip_accents?: boolean | null;
  lowercase?: boolean;
}

interface AddedToken {
  id: number;
  content: string;
  special?: boolean;
}

interface TokenizerJson {
  normalizer: NormalizerConfig & { type: string };
  pre_tokenizer: { type: string };
  added_tokens?: AddedToken[];
  model: {
    type: string;
    vocab: Record<string, number>;
    unk_token: string;
    continuing_subword_prefix: string;
    max_input_chars_per_word?: number;
  };
}

/** The ids the ONNX session is fed for one text. */
export interface Encoding {
  input_ids: number[];
  attention_mask: number[];
  token_type_ids: number[];
}

export class WordPieceTokenizer {
  private readonly vocab: Map<string, number>;
  private readonly unkToken: string;
  private readonly prefix: string;
  private readonly maxCharsPerWord: number;
  private readonly norm: NormalizerConfig;
  private readonly preTokenizePattern: RegExp;
  private readonly addedPattern: RegExp | null;
  private readonly addedIds: Map<string, number>;

  readonly clsId: number;
  readonly sepId: number;
  readonly padId: number;
  readonly unkId: number;
  /** Longest sequence the model's position embeddings cover, `[CLS]`/`[SEP]` included. */
  readonly modelMaxLength: number;

  constructor(json: TokenizerJson, modelMaxLength = 512) {
    if (json.model.type !== "WordPiece") {
      throw new Error(`Unsupported tokenizer model: ${json.model.type}`);
    }
    if (json.normalizer?.type !== "BertNormalizer") {
      throw new Error(`Unsupported normalizer: ${json.normalizer?.type}`);
    }
    if (json.pre_tokenizer?.type !== "BertPreTokenizer") {
      throw new Error(`Unsupported pre-tokenizer: ${json.pre_tokenizer?.type}`);
    }

    this.vocab = new Map(Object.entries(json.model.vocab));
    this.unkToken = json.model.unk_token;
    const unkId = this.vocab.get(this.unkToken);
    if (unkId === undefined) throw new Error("unk_token missing from vocab");
    this.unkId = unkId;
    this.prefix = json.model.continuing_subword_prefix;
    this.maxCharsPerWord = json.model.max_input_chars_per_word ?? 100;
    this.norm = json.normalizer;
    this.modelMaxLength = modelMaxLength;

    // Equivalent to "strip whitespace, split on punctuation" — the same pattern
    // transformers.js builds to match the Rust implementation.
    this.preTokenizePattern = new RegExp(
      `[^\\s${PUNCTUATION}]+|[${PUNCTUATION}]`,
      "gu",
    );

    // Added tokens are matched against the *raw* text before normalization, so
    // a literal "[CLS]" appearing in a narration tokenizes as the special token
    // — matching the reference implementation rather than being lowercased into
    // pieces. Longest-first so "[MASK]" can't be shadowed by a shorter entry.
    const added = (json.added_tokens ?? []).slice().sort(
      (a, b) => b.content.length - a.content.length,
    );
    this.addedIds = new Map(added.map((t) => [t.content, t.id]));
    this.addedPattern = added.length
      ? new RegExp(added.map((t) => escapeRegExp(t.content)).join("|"), "g")
      : null;

    this.clsId = this.requireId("[CLS]");
    this.sepId = this.requireId("[SEP]");
    this.padId = this.requireId("[PAD]");
  }

  /** Load from a HuggingFace `tokenizer.json` on disk. */
  static fromFile(path: string, modelMaxLength = 512): WordPieceTokenizer {
    return new WordPieceTokenizer(
      JSON.parse(readFileSync(path, "utf8")) as TokenizerJson,
      modelMaxLength,
    );
  }

  private requireId(token: string): number {
    const id = this.addedIds.get(token) ?? this.vocab.get(token);
    if (id === undefined) throw new Error(`Required token missing: ${token}`);
    return id;
  }

  /** BertNormalizer: clean → space out CJK → lowercase → strip accents. */
  private normalize(text: string): string {
    if (this.norm.clean_text) {
      let out = "";
      for (const char of text) {
        const cp = char.codePointAt(0)!;
        if (cp === 0 || cp === 0xfffd || isControl(char)) continue;
        out += /^\s$/.test(char) ? " " : char;
      }
      text = out;
    }

    if (this.norm.handle_chinese_chars) {
      let out = "";
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        out += isChineseChar(char.charCodeAt(0)) ? ` ${char} ` : char;
      }
      text = out;
    }

    if (this.norm.lowercase) {
      text = text.toLowerCase();
      // `strip_accents: null` means "follow lowercase" — only an explicit
      // `false` disables it. bge-small-en-v1.5 ships null, so accents go.
      if (this.norm.strip_accents !== false) text = stripAccents(text);
    } else if (this.norm.strip_accents) {
      text = stripAccents(text);
    }

    return text;
  }

  /** Greedy longest-match-first WordPiece over one pre-token. */
  private wordPiece(token: string): string[] {
    const chars = [...token];
    if (chars.length > this.maxCharsPerWord) return [this.unkToken];

    const sub: string[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let match: string | null = null;
      while (start < end) {
        const candidate =
          (start > 0 ? this.prefix : "") + chars.slice(start, end).join("");
        if (this.vocab.has(candidate)) {
          match = candidate;
          break;
        }
        --end;
      }
      // A single unmatched piece makes the *whole* word unknown — not just the
      // offending span. That is BERT's rule and dropping it would silently
      // change ids for any word containing an unseen character.
      if (match === null) return [this.unkToken];
      sub.push(match);
      start = end;
    }
    return sub;
  }

  /** Text → vocabulary ids, without `[CLS]`/`[SEP]` and without truncation. */
  tokenize(text: string): number[] {
    const ids: number[] = [];

    const segments = this.addedPattern
      ? splitKeepingDelimiters(text, this.addedPattern)
      : [{ text, isAdded: false }];

    for (const seg of segments) {
      if (seg.isAdded) {
        ids.push(this.addedIds.get(seg.text)!);
        continue;
      }
      const normalized = this.normalize(seg.text);
      const preTokens = normalized.trim().match(this.preTokenizePattern) ?? [];
      for (const pre of preTokens) {
        for (const piece of this.wordPiece(pre)) {
          ids.push(this.vocab.get(piece) ?? this.unkId);
        }
      }
    }

    return ids;
  }

  /**
   * Encode one text the way the feature-extraction pipeline does: wrap in
   * `[CLS]`/`[SEP]`, then truncate to the model's position-embedding limit.
   *
   * Order matters, and not in the way it first looks. The obvious reading —
   * reserve two slots so a long text still ends in `[SEP]` — is *wrong* here,
   * because HuggingFace truncates the already-post-processed sequence: an
   * over-long text comes back 512 ids ending on an ordinary word, with the
   * closing `[SEP]` cut off. Reserving room instead put `[SEP]` at index 511
   * and disagreed with the reference on every text over the limit — 13% of
   * this corpus, all of them long ones. Matching the reference is the whole
   * point of this file, so the surprising behaviour is the correct one.
   */
  encode(text: string): Encoding {
    const ids = this.tokenize(text);

    let input_ids = [this.clsId, ...ids, this.sepId];
    if (input_ids.length > this.modelMaxLength) {
      input_ids = input_ids.slice(0, this.modelMaxLength);
    }
    return {
      input_ids,
      attention_mask: new Array(input_ids.length).fill(1),
      token_type_ids: new Array(input_ids.length).fill(0),
    };
  }

  /**
   * Encode a batch, right-padding to the longest member. Padding positions get
   * `attention_mask: 0` so mean pooling ignores them — a batch must produce the
   * same vector for a text as encoding it alone would.
   */
  encodeBatch(texts: string[]): {
    input_ids: number[][];
    attention_mask: number[][];
    token_type_ids: number[][];
  } {
    const encodings = texts.map((t) => this.encode(t));
    const width = encodings.reduce((m, e) => Math.max(m, e.input_ids.length), 0);
    const pad = (row: number[], fill: number) => [
      ...row,
      ...new Array(width - row.length).fill(fill),
    ];
    return {
      input_ids: encodings.map((e) => pad(e.input_ids, this.padId)),
      attention_mask: encodings.map((e) => pad(e.attention_mask, 0)),
      token_type_ids: encodings.map((e) => pad(e.token_type_ids, 0)),
    };
  }
}

/** "Mark, Nonspacing" removal after NFD — BERT's accent stripping. */
function stripAccents(text: string): string {
  return text.normalize("NFD").replace(/\p{Mn}/gu, "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitKeepingDelimiters(
  text: string,
  pattern: RegExp,
): Array<{ text: string; isAdded: boolean }> {
  const out: Array<{ text: string; isAdded: boolean }> = [];
  let last = 0;
  pattern.lastIndex = 0;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), isAdded: false });
    out.push({ text: m[0], isAdded: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), isAdded: false });
  return out;
}
