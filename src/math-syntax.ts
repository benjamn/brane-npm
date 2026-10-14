/** micromark syntax extension for math: `$…$` (text) and `$$` fences (flow).
 *
 *  Vendored from `micromark-extension-math` 3.1.0 (`dev/lib/syntax.js`,
 *  `math-flow.js`, `math-text.js`), the syntax half only, so the published
 *  package no longer depends on it. That package's index also loads its
 *  `mathHtml()`, which imports `katex` at the range it pins (`^0.16.0`). Our
 *  root `overrides` dedupe that onto our own katex in this checkout, but npm
 *  ignores a dependency's `overrides`, so every `npm install brane` got a
 *  second, older katex: loaded, never called (`src/math.ts` is our `mathHtml`),
 *  and flagged by `npm audit` (GHSA-238p-pmpm-9mq7). The tokenizers are
 *  unchanged apart from TypeScript annotations and dropping the `devlop`
 *  assertions, which upstream's production build drops too. The web app still
 *  imports the package itself: it ships prebuilt, under `expo/`'s overrides.
 *
 *  Upstream: https://github.com/micromark/micromark-extension-math
 *
 *  (The MIT License)
 *
 *  Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>
 *
 *  Permission is hereby granted, free of charge, to any person obtaining
 *  a copy of this software and associated documentation files (the
 *  'Software'), to deal in the Software without restriction, including
 *  without limitation the rights to use, copy, modify, merge, publish,
 *  distribute, sublicense, and/or sell copies of the Software, and to
 *  permit persons to whom the Software is furnished to do so, subject to
 *  the following conditions:
 *
 *  The above copyright notice and this permission notice shall be
 *  included in all copies or substantial portions of the Software.
 *
 *  THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
 *  EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 *  MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 *  IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 *  CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 *  TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 *  SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import { factorySpace } from "micromark-factory-space";
import { markdownLineEnding } from "micromark-util-character";
import { codes, constants, types } from "micromark-util-symbol";
import type {
  Construct,
  Event,
  Extension,
  Previous,
  Resolver,
  State,
  Token,
  TokenizeContext,
  Tokenizer,
} from "micromark-util-types";

/** Configuration. */
export interface Options {
  /** Whether to support math (text) with a single dollar (default: `true`).
   *
   *  Single dollars work in Pandoc and many other places, but often interfere
   *  with “normal” dollars in text. If you turn this off, you can use two or
   *  more dollars for text math.
   */
  singleDollarTextMath?: boolean | null | undefined;
}

declare module "micromark-util-types" {
  interface CompileData {
    mathFlowOpen?: boolean;
  }

  interface TokenTypeMap {
    mathFlow: "mathFlow";
    mathFlowFence: "mathFlowFence";
    mathFlowFenceMeta: "mathFlowFenceMeta";
    mathFlowFenceSequence: "mathFlowFenceSequence";
    mathFlowValue: "mathFlowValue";
    mathText: "mathText";
    mathTextData: "mathTextData";
    mathTextPadding: "mathTextPadding";
    mathTextSequence: "mathTextSequence";
  }
}

/** Create an extension for `micromark` to enable math syntax. */
export function math(options?: Options | null | undefined): Extension {
  return {
    flow: { [codes.dollarSign]: mathFlow },
    text: { [codes.dollarSign]: mathText(options) },
  };
}

// --- math (flow) ------------------------------------------------------------

const mathFlow: Construct = {
  tokenize: tokenizeMathFenced,
  concrete: true,
  name: "mathFlow",
};

const nonLazyContinuation: Construct = {
  tokenize: tokenizeNonLazyContinuation,
  partial: true,
};

function tokenizeMathFenced(
  this: TokenizeContext,
  effects: Parameters<Tokenizer>[0],
  ok: State,
  nok: State,
): State {
  const self = this;
  const tail = self.events[self.events.length - 1];
  const initialSize =
    tail && tail[1].type === types.linePrefix
      ? tail[2].sliceSerialize(tail[1], true).length
      : 0;
  let sizeOpen = 0;

  return start;

  /** Start of math: `$$`, at the first `$`. */
  function start(code: Parameters<State>[0]): ReturnType<State> {
    effects.enter("mathFlow");
    effects.enter("mathFlowFence");
    effects.enter("mathFlowFenceSequence");
    return sequenceOpen(code);
  }

  /** In opening fence sequence. */
  function sequenceOpen(code: Parameters<State>[0]): ReturnType<State> {
    if (code === codes.dollarSign) {
      effects.consume(code);
      sizeOpen++;
      return sequenceOpen;
    }

    if (sizeOpen < 2) {
      return nok(code);
    }

    effects.exit("mathFlowFenceSequence");
    return factorySpace(effects, metaBefore, types.whitespace)(code);
  }

  /** In opening fence, before meta: `$$asciimath`, at `a`. */
  function metaBefore(code: Parameters<State>[0]): ReturnType<State> {
    if (code === codes.eof || markdownLineEnding(code)) {
      return metaAfter(code);
    }

    effects.enter("mathFlowFenceMeta");
    effects.enter(types.chunkString, { contentType: constants.contentTypeString });
    return meta(code);
  }

  /** In meta. */
  function meta(code: Parameters<State>[0]): ReturnType<State> {
    if (code === codes.eof || markdownLineEnding(code)) {
      effects.exit(types.chunkString);
      effects.exit("mathFlowFenceMeta");
      return metaAfter(code);
    }

    if (code === codes.dollarSign) {
      return nok(code);
    }

    effects.consume(code);
    return meta;
  }

  /** After meta. */
  function metaAfter(code: Parameters<State>[0]): ReturnType<State> {
    // Guaranteed to be eol/eof.
    effects.exit("mathFlowFence");

    if (self.interrupt) {
      return ok(code);
    }

    return effects.attempt(nonLazyContinuation, beforeNonLazyContinuation, after)(code);
  }

  /** After eol/eof in math, at a non-lazy closing fence or content. */
  function beforeNonLazyContinuation(code: Parameters<State>[0]): ReturnType<State> {
    return effects.attempt(
      { tokenize: tokenizeClosingFence, partial: true },
      after,
      contentStart,
    )(code);
  }

  /** Before math content, definitely not before a closing fence. */
  function contentStart(code: Parameters<State>[0]): ReturnType<State> {
    return (
      initialSize
        ? factorySpace(effects, beforeContentChunk, types.linePrefix, initialSize + 1)
        : beforeContentChunk
    )(code);
  }

  /** Before math content, after optional prefix. */
  function beforeContentChunk(code: Parameters<State>[0]): ReturnType<State> {
    if (code === codes.eof) {
      return after(code);
    }

    if (markdownLineEnding(code)) {
      return effects.attempt(nonLazyContinuation, beforeNonLazyContinuation, after)(code);
    }

    effects.enter("mathFlowValue");
    return contentChunk(code);
  }

  /** In math content. */
  function contentChunk(code: Parameters<State>[0]): ReturnType<State> {
    if (code === codes.eof || markdownLineEnding(code)) {
      effects.exit("mathFlowValue");
      return beforeContentChunk(code);
    }

    effects.consume(code);
    return contentChunk;
  }

  /** After math (ha!). */
  function after(code: Parameters<State>[0]): ReturnType<State> {
    effects.exit("mathFlow");
    return ok(code);
  }

  function tokenizeClosingFence(
    this: TokenizeContext,
    effects: Parameters<Tokenizer>[0],
    ok: State,
    nok: State,
  ): State {
    let size = 0;

    // Before closing fence, at optional whitespace.
    return factorySpace(
      effects,
      beforeSequenceClose,
      types.linePrefix,
      self.parser.constructs.disable.null!.includes("codeIndented")
        ? undefined
        : constants.tabSize,
    );

    /** In closing fence, after optional whitespace, at sequence. */
    function beforeSequenceClose(code: Parameters<State>[0]): ReturnType<State> {
      effects.enter("mathFlowFence");
      effects.enter("mathFlowFenceSequence");
      return sequenceClose(code);
    }

    /** In closing fence sequence. */
    function sequenceClose(code: Parameters<State>[0]): ReturnType<State> {
      if (code === codes.dollarSign) {
        size++;
        effects.consume(code);
        return sequenceClose;
      }

      if (size < sizeOpen) {
        return nok(code);
      }

      effects.exit("mathFlowFenceSequence");
      return factorySpace(effects, afterSequenceClose, types.whitespace)(code);
    }

    /** After closing fence sequence, after optional whitespace. */
    function afterSequenceClose(code: Parameters<State>[0]): ReturnType<State> {
      if (code === codes.eof || markdownLineEnding(code)) {
        effects.exit("mathFlowFence");
        return ok(code);
      }

      return nok(code);
    }
  }
}

function tokenizeNonLazyContinuation(
  this: TokenizeContext,
  effects: Parameters<Tokenizer>[0],
  ok: State,
  nok: State,
): State {
  const self = this;

  return start;

  function start(code: Parameters<State>[0]): ReturnType<State> {
    if (code === null) {
      return ok(code);
    }

    effects.enter(types.lineEnding);
    effects.consume(code);
    effects.exit(types.lineEnding);
    return lineStart;
  }

  function lineStart(code: Parameters<State>[0]): ReturnType<State> {
    return self.parser.lazy[self.now().line] ? nok(code) : ok(code);
  }
}

// --- math (text) ------------------------------------------------------------

// To do (upstream): next major: clean spaces in HTML compiler.
// This has to be coordinated together with `mdast-util-math`.

function mathText(options?: Options | null | undefined): Construct {
  const options_ = options || {};
  let single = options_.singleDollarTextMath;

  if (single === null || single === undefined) {
    single = true;
  }

  return {
    tokenize: tokenizeMathText,
    resolve: resolveMathText,
    previous,
    name: "mathText",
  };

  function tokenizeMathText(
    this: TokenizeContext,
    effects: Parameters<Tokenizer>[0],
    ok: State,
    nok: State,
  ): State {
    let sizeOpen = 0;
    let size: number;
    let token: Token;

    return start;

    /** Start of math (text): `$a$` at the first `$`, or `\$a$` at the second. */
    function start(code: Parameters<State>[0]): ReturnType<State> {
      effects.enter("mathText");
      effects.enter("mathTextSequence");
      return sequenceOpen(code);
    }

    /** In opening sequence. */
    function sequenceOpen(code: Parameters<State>[0]): ReturnType<State> {
      if (code === codes.dollarSign) {
        effects.consume(code);
        sizeOpen++;
        return sequenceOpen;
      }

      // Not enough markers in the sequence.
      if (sizeOpen < 2 && !single) {
        return nok(code);
      }

      effects.exit("mathTextSequence");
      return between(code);
    }

    /** Between something and something else. */
    function between(code: Parameters<State>[0]): ReturnType<State> {
      if (code === codes.eof) {
        return nok(code);
      }

      if (code === codes.dollarSign) {
        token = effects.enter("mathTextSequence");
        size = 0;
        return sequenceClose(code);
      }

      // Tabs don’t work, and virtual spaces don’t make sense.
      if (code === codes.space) {
        effects.enter("space");
        effects.consume(code);
        effects.exit("space");
        return between;
      }

      if (markdownLineEnding(code)) {
        effects.enter(types.lineEnding);
        effects.consume(code);
        effects.exit(types.lineEnding);
        return between;
      }

      // Data.
      effects.enter("mathTextData");
      return data(code);
    }

    /** In data. */
    function data(code: Parameters<State>[0]): ReturnType<State> {
      if (
        code === codes.eof ||
        code === codes.space ||
        code === codes.dollarSign ||
        markdownLineEnding(code)
      ) {
        effects.exit("mathTextData");
        return between(code);
      }

      effects.consume(code);
      return data;
    }

    /** In closing sequence. */
    function sequenceClose(code: Parameters<State>[0]): ReturnType<State> {
      // More.
      if (code === codes.dollarSign) {
        effects.consume(code);
        size++;
        return sequenceClose;
      }

      // Done!
      if (size === sizeOpen) {
        effects.exit("mathTextSequence");
        effects.exit("mathText");
        return ok(code);
      }

      // More or less accents: mark as data.
      token.type = "mathTextData";
      return data(code);
    }
  }
}

const resolveMathText: Resolver = function (events: Event[]): Event[] {
  let tailExitIndex = events.length - 4;
  let headEnterIndex = 3;
  let index: number;
  let enter: number | undefined;

  // If we start and end with an EOL or a space.
  if (
    (events[headEnterIndex][1].type === types.lineEnding ||
      events[headEnterIndex][1].type === "space") &&
    (events[tailExitIndex][1].type === types.lineEnding ||
      events[tailExitIndex][1].type === "space")
  ) {
    index = headEnterIndex;

    // And we have data.
    while (++index < tailExitIndex) {
      if (events[index][1].type === "mathTextData") {
        // Then we have padding.
        events[tailExitIndex][1].type = "mathTextPadding";
        events[headEnterIndex][1].type = "mathTextPadding";
        headEnterIndex += 2;
        tailExitIndex -= 2;
        break;
      }
    }
  }

  // Merge adjacent spaces and data.
  index = headEnterIndex - 1;
  tailExitIndex++;

  while (++index <= tailExitIndex) {
    if (enter === undefined) {
      if (index !== tailExitIndex && events[index][1].type !== types.lineEnding) {
        enter = index;
      }
    } else if (index === tailExitIndex || events[index][1].type === types.lineEnding) {
      events[enter][1].type = "mathTextData";

      if (index !== enter + 2) {
        events[enter][1].end = events[index - 1][1].end;
        events.splice(enter + 2, index - enter - 2);
        tailExitIndex -= index - enter - 2;
        index = enter + 2;
      }

      enter = undefined;
    }
  }

  return events;
};

const previous: Previous = function (this: TokenizeContext, code) {
  // If there is a previous code, there will always be a tail.
  return (
    code !== codes.dollarSign ||
    this.events[this.events.length - 1][1].type === types.characterEscape
  );
};
