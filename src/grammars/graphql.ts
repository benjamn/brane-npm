import { bundledLanguages, type LanguageRegistration } from "shiki";

// Corrections to the GraphQL grammar shiki bundles, applied to its copy at load
// time so we don't vendor the whole grammar. src/test/highlight.test.ts pins
// the behavior, so a shiki upgrade that changes these rules fails there.
//
// Bundled languages can't be patched lazily: http, hurl and ruby embed graphql,
// and shiki keeps whichever registration of a name arrives first. Loading one
// of them before this would make the stock grammar stick for good, which is why
// highlight.ts registers this one when it creates the highlighter.

interface Rule {
  include?: string;
  begin?: string;
  end?: string;
  patterns?: Rule[];
  [key: string]: unknown;
}

const STRING_RULES: Rule[] = [{ include: "#graphql-block-string" }, { include: "#graphql-string-value" }];
const isDescription = (rule: Rule) => rule.include === "#graphql-description-docstring";

// A value's strings have to outrank the rules that read `"` and `"""` as a
// description or comment, which is correct only ahead of a definition.
function preferStrings(rules: Rule[]): Rule[] {
  return [...STRING_RULES, ...rules.filter((rule) => !isDescription(rule) && !STRING_RULES.some((s) => s.include === rule.include))];
}

function patch(stock: LanguageRegistration): LanguageRegistration {
  const grammar = structuredClone(stock);
  const repository = grammar.repository as unknown as Record<string, Rule>;

  // `schema` ends only after a `}`, but its body is optional: `extend schema
  // @link(...)` stayed open and swallowed the next definition. End it, too, at
  // the first character that can't continue a schema.
  repository["graphql-schema"].end = '(?<=\\})|(?=[^\\s@{#"])';

  repository["graphql-block-string"] = {
    begin: '\\s*"""',
    end: '"""',
    name: "string.quoted.block.graphql",
    patterns: [{ match: '\\\\"""', name: "constant.character.escape.graphql" }],
  };
  const value = repository["graphql-value"];
  value.patterns = preferStrings(value.patterns!);
  const argument = repository["graphql-arguments"].patterns!.find((rule) => rule.begin?.includes("(:)"))!;
  argument.patterns = preferStrings(argument.patterns!);

  return grammar;
}

export async function loadGraphql(): Promise<LanguageRegistration[]> {
  const { default: registrations } = (await bundledLanguages.graphql()) as { default: LanguageRegistration[] };
  return registrations.map((registration) => (registration.name === "graphql" ? patch(registration) : registration));
}
