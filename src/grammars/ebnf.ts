import type { LanguageRegistration } from "shiki";

// TextMate grammar for EBNF / BNF-style rule definitions.
// Targets ISO EBNF (`rule = ... ;`, `(* comment *)`, `'x'` / `"x"` terminals) and
// W3C-style EBNF used in XML/HTML specs (`Rule ::= ...`, `#x20`, `[#x0-#x7F]`).
// BNF angle-bracket non-terminals (`<name>`) are highlighted too.
export const ebnf: LanguageRegistration = {
  name: "ebnf",
  scopeName: "source.ebnf",
  displayName: "EBNF",
  aliases: ["bnf"],
  patterns: [
    { include: "#comment" },
    { include: "#rule-definition" },
    { include: "#angle-nonterminal" },
    { include: "#char-class" },
    { include: "#string" },
    { include: "#hex-number" },
    { include: "#number" },
    { include: "#operator" },
    { include: "#identifier" },
  ],
  repository: {
    comment: {
      name: "comment.block.ebnf",
      begin: "\\(\\*",
      end: "\\*\\)",
    },
    "rule-definition": {
      match: "^\\s*(<[A-Za-z_][^<>\\s]*>|[A-Za-z_][A-Za-z0-9_-]*)\\s*(::=|=)(?!=)",
      captures: {
        "1": { name: "entity.name.function.ebnf" },
        "2": { name: "keyword.operator.definition.ebnf" },
      },
    },
    "angle-nonterminal": {
      name: "entity.name.tag.ebnf",
      match: "<[A-Za-z_][A-Za-z0-9_-]*>",
    },
    // Regex-style character classes (`[a-zA-Z_]`, `[^']`, `[#x0-#x7F]`).
    // Swallowed as a single scope so the identifier/number/operator/string
    // patterns don't fire on the interior — crucial because a bare `'` or
    // `"` inside `[^'…]` / `[^"…]` would otherwise open a stray string scope
    // that runs away until the next matching quote anywhere on the line.
    "char-class": {
      name: "constant.other.character-class.ebnf",
      begin: "\\[",
      beginCaptures: { "0": { name: "punctuation.definition.character-class.ebnf" } },
      end: "\\]",
      endCaptures: { "0": { name: "punctuation.definition.character-class.ebnf" } },
      patterns: [
        { name: "constant.character.escape.ebnf", match: "\\\\." },
        { name: "constant.numeric.hex.ebnf", match: "#x[0-9A-Fa-f]+" },
      ],
    },
    string: {
      patterns: [
        {
          name: "string.quoted.double.ebnf",
          begin: '"',
          end: '"',
          patterns: [
            { name: "constant.character.escape.ebnf", match: "\\\\." },
          ],
        },
        {
          name: "string.quoted.single.ebnf",
          begin: "'",
          end: "'",
          patterns: [
            { name: "constant.character.escape.ebnf", match: "\\\\." },
          ],
        },
      ],
    },
    "hex-number": {
      name: "constant.numeric.hex.ebnf",
      match: "#x[0-9A-Fa-f]+",
    },
    number: {
      name: "constant.numeric.decimal.ebnf",
      match: "\\b[0-9]+\\b",
    },
    operator: {
      name: "keyword.operator.ebnf",
      match: "::=|[|,;.*+?()\\[\\]{}=\\-→]",
    },
    identifier: {
      name: "entity.name.tag.ebnf",
      match: "\\b[A-Za-z_][A-Za-z0-9_]*\\b",
    },
  },
};
