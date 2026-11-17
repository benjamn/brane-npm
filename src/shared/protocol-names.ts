/** What a `/command` names. The one parser for protocol names: the daemon's
 *  `read_protocol` and the app's reader both go through `parseProtocolRef`, so
 *  `/brane.idle` can't mean one thing to an agent and another on a phone.
 *
 *  Protocols live in namespaces, searched in `SEARCH_ORDER`. A bare name
 *  (`review`) resolves to its first match; a qualified one (`brane.review`)
 *  reads one namespace; a namespace's own name (`brane`) is a generated page
 *  listing what it holds. What is actually fetchable (protected names, files
 *  the daemon ignored) is the daemon's call, not this module's: it only says
 *  what a name *means*. See docs/protocols.md. */

export type ProtocolNamespace = "fold" | "home" | "brane";

/** Most local first. A bare name resolves to the first namespace that has it. */
export const SEARCH_ORDER: readonly ProtocolNamespace[] = ["fold", "home", "brane"];

/** Command names that list a namespace rather than read a protocol. `folds` is
 *  the root other folds will hang from (`/folds.<label>.<name>`); for now only
 *  `/folds.self` (= `/fold`) and `/folds.brane` (= `/brane`) resolve under it. */
export const NAMESPACE_COMMANDS: readonly string[] = ["brane", "home", "fold", "folds"];

/** Built-ins no other namespace may define: the loop's own contract
 *  (`prelude`, prepended to every protocol, and `LIVE_loop`, which every agent
 *  reads first), `keeper`, which governs what one agent may do to other
 *  agents' sessions, and `twin`, which spawn forces as a role. A `home` or
 *  `fold` file with one of these names is ignored, and only `/brane.<name>`
 *  resolves. Everything else, `/idle` included, may be overridden; a local
 *  version builds on the original by citing `/brane.<name>`. */
export const PROTECTED_PROTOCOLS: readonly string[] = ["prelude", "LIVE_loop", "keeper", "twin"];

/** The shape of a protocol name, anchored. Must accept exactly what
 *  `PROTOCOL_PATTERN` (markdown-protocols.ts) captures, so anything the chat
 *  links is something `read_protocol` will parse. */
export const PROTOCOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;

export type ProtocolRef =
  | { kind: "document"; name: string; from?: ProtocolNamespace }
  | { kind: "index"; namespace: ProtocolNamespace | "folds" }
  | { kind: "invalid"; reason: string };

const NAMESPACES = new Set<string>(SEARCH_ORDER);

/** Parse a `/command` name as written (without the slash). */
export function parseProtocolRef(raw: string): ProtocolRef {
  if (!PROTOCOL_NAME_RE.test(raw)) {
    return { kind: "invalid", reason: `"${raw}" is not a protocol name (letters, digits, "_", "-" and ".", starting with a letter)` };
  }
  if (raw === "folds") return { kind: "index", namespace: "folds" };
  if (NAMESPACES.has(raw)) return { kind: "index", namespace: raw as ProtocolNamespace };

  const dot = raw.indexOf(".");
  if (dot < 0) return { kind: "document", name: raw };
  const head = raw.slice(0, dot);
  const rest = raw.slice(dot + 1);

  if (NAMESPACES.has(head)) return qualified(head as ProtocolNamespace, rest, raw);
  if (head === "folds") {
    // `/folds.self` is my fold and `/folds.brane` the install fold; every
    // other label is reserved for reaching other folds' shared protocols.
    const labelDot = rest.indexOf(".");
    const label = labelDot < 0 ? rest : rest.slice(0, labelDot);
    const alias: ProtocolNamespace | undefined = label === "self" ? "fold" : label === "brane" ? "brane" : undefined;
    if (!alias) {
      return { kind: "invalid", reason: `"${raw}" names another fold's protocols, which can't be reached yet; only /folds.self (= /fold) and /folds.brane (= /brane) resolve` };
    }
    if (labelDot < 0) return { kind: "index", namespace: alias };
    return qualified(alias, rest.slice(labelDot + 1), raw);
  }
  // A dot that doesn't follow a namespace is part of the name (`reviewer.draft`).
  return { kind: "document", name: raw };
}

function qualified(from: ProtocolNamespace, name: string, raw: string): ProtocolRef {
  if (!name || !PROTOCOL_NAME_RE.test(name)) {
    return { kind: "invalid", reason: `"${raw}" names no protocol after the namespace` };
  }
  if (isReservedProtocolName(name)) {
    return { kind: "invalid", reason: `"${raw}": "${name}" is a namespace name, not a protocol` };
  }
  return { kind: "document", name, from };
}

/** A name no protocol file may take, in any namespace: the namespace commands
 *  themselves (`brane`, `home`, `fold`, `folds`), bare or as a prefix, compared
 *  without case so `Home.md` can't claim the spelling on a case-insensitive
 *  disk. */
export function isReservedProtocolName(name: string): boolean {
  const lower = name.toLowerCase();
  return NAMESPACE_COMMANDS.some((ns) => lower === ns || lower.startsWith(ns + "."));
}

/** The `PROTECTED_PROTOCOLS` spelling of a name, matched without case
 *  (`Twin` → `twin`), or undefined when it isn't protected. */
export function protectedProtocol(name: string): string | undefined {
  const lower = name.toLowerCase();
  return PROTECTED_PROTOCOLS.find((p) => p.toLowerCase() === lower);
}

/** Whether a name is one of `PROTECTED_PROTOCOLS`, without case. */
export function isProtectedProtocol(name: string): boolean {
  return protectedProtocol(name) !== undefined;
}

/** The wiki source label the daemon serves a namespace's files under, for
 *  `/api/wiki/read`. `brane` keeps the label it always had. */
export function protocolSourceLabel(from: ProtocolNamespace): string {
  return from === "brane" ? "protocols" : `protocols:${from}`;
}

/** Every `/command` name a library makes resolvable as a document: each bare
 *  name, and each `<namespace>.<name>` that exists. What the chat linkifies. */
export function protocolCommandNames(layers: Record<string, ProtocolNamespace[]>): string[] {
  const names: string[] = [];
  for (const [name, froms] of Object.entries(layers)) {
    names.push(name);
    for (const from of froms) names.push(`${from}.${name}`);
  }
  return names;
}

/** Where the reader should open a tapped `/command`: the file that is in
 *  force for a bare name, or the named namespace's file for a qualified one.
 *  `layers` maps each name to the namespaces that have it, in search order.
 *  Null when the name resolves to no file (a generated page, or nothing). */
export function protocolReaderTarget(
  raw: string,
  layers: Record<string, ProtocolNamespace[]>,
): { source: string; slug: string } | null {
  const ref = parseProtocolRef(raw);
  if (ref.kind !== "document") return null;
  const froms = layers[ref.name];
  if (!froms || froms.length === 0) {
    // A daemon too old to report layers has only built-ins.
    return Object.keys(layers).length === 0 && !ref.from ? { source: "protocols", slug: ref.name } : null;
  }
  const from = ref.from ?? froms[0];
  if (!froms.includes(from)) return null;
  return { source: protocolSourceLabel(from), slug: ref.name };
}
