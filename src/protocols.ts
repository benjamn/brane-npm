/** The protocol library: which files each namespace holds, what a `/command`
 *  resolves to, and the generated pages that list a namespace. Directories
 *  come in as arguments, so the test suite builds its own and never reads the
 *  operator's `~/.brane`. Name parsing lives in `shared/protocol-names.ts`;
 *  this module decides what is fetchable. See docs/protocols.md. */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  PROTOCOL_NAME_RE,
  SEARCH_ORDER,
  isReservedProtocolName,
  protectedProtocol,
  parseProtocolRef,
  protocolCommandNames,
  type ProtocolNamespace,
} from "./shared/protocol-names.js";

export interface NamespaceDir {
  from: ProtocolNamespace;
  /** Absolute. Need not exist: a fold with no `.brane/protocols` is an empty
   *  namespace, not an error. */
  dir: string;
}

export interface ProtocolLayer {
  from: ProtocolNamespace;
  /** Absolute path of the file. */
  path: string;
  /** The approved content's hash, for a file outside `brane` scanned under
   *  approval: a read re-checks it, so a file edited after the scan is not
   *  served as the approved one. */
  sha256?: string;
}

export interface IgnoredProtocol {
  from: ProtocolNamespace;
  path: string;
  reason: string;
  /** Set when the file is ignored only for want of the operator's approval:
   *  the content's hash (what an approval must name), and whether an earlier
   *  version of the file was approved. */
  pending?: { sha256: string; changed: boolean };
}

/** The hash an approval pins: of the file's text as UTF-8. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The approved hash for a protocol file outside `brane`, by absolute path,
 *  or undefined when none is. See `src/db/protocol-approvals.ts`. */
export type ApprovedHash = (absPath: string) => string | undefined;

/** How the operator approves a pending file: what an ignore reason and a
 *  generated page say. */
export function approveHint(displayPath: string): string {
  return `the operator approves it with \`brane protocol approve ${displayPath}\` or in the app`;
}

export interface ProtocolLibrary {
  namespaces: NamespaceDir[];
  /** Each name's files, most local first (`SEARCH_ORDER`); `[0]` is in force. */
  entries: Map<string, ProtocolLayer[]>;
  ignored: IgnoredProtocol[];
}

/** A request `read_protocol` can't satisfy. The message says why, and is what
 *  the agent sees (via `sendToolError`). */
export class ProtocolError extends Error {}

/** Shows a path to a reader: the daemon passes `toPortablePath`. */
export type DisplayPath = (abs: string) => string;

const RANK = new Map(SEARCH_ORDER.map((ns, i) => [ns, i]));

/** A path with symlinks resolved as far as the disk allows: the nearest
 *  existing ancestor is resolved and the missing tail joined back on, so a
 *  directory that doesn't exist yet still compares equal to another spelling
 *  of the same place. */
export function canonicalDir(dir: string): string {
  const missing: string[] = [];
  let at = resolve(dir);
  for (;;) {
    try {
      return join(realpathSync(at), ...missing);
    } catch {
      const parent = dirname(at);
      if (parent === at) return resolve(dir);
      missing.unshift(basename(at));
      at = parent;
    }
  }
}

/** A caller's namespaces, most local first: its fold's `.brane/protocols`
 *  (when it has a fold), the operator's `homeDir`, and the built-ins in
 *  `braneDir`. A fold whose `.brane/protocols` *is* `homeDir` (a fold at `~`,
 *  however reached, symlinks included) gets no fold namespace: the directory
 *  counts once, as home. `foldOnlyIfExists` drops a fold namespace whose
 *  directory is absent, for `brane doctor`, which can't know the current
 *  directory is a fold. The daemon and doctor both build the list here. */
export function protocolNamespaces(
  foldAbs: string | undefined,
  homeDir: string,
  braneDir: string,
  opts: { foldOnlyIfExists?: boolean } = {},
): NamespaceDir[] {
  const namespaces: NamespaceDir[] = [];
  if (foldAbs) {
    const dir = join(foldAbs, ".brane", "protocols");
    let exists = true;
    try {
      exists = statSync(dir).isDirectory();
    } catch {
      exists = false;
    }
    if (canonicalDir(dir) !== canonicalDir(homeDir) && (exists || !opts.foldOnlyIfExists)) {
      namespaces.push({ from: "fold", dir });
    }
  }
  namespaces.push({ from: "home", dir: homeDir }, { from: "brane", dir: braneDir });
  return namespaces;
}

/** The `.md` regular files in a directory (symlinks followed), sorted so the
 *  library is the same on every disk. A missing or unreadable directory holds
 *  nothing. */
function markdownFiles(dir: string): Array<{ file: string; size: number }> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ file: string; size: number }> = [];
  for (const file of names.filter((f) => f.endsWith(".md") && !f.startsWith(".")).sort()) {
    try {
      const st = statSync(join(dir, file));
      if (st.isFile()) out.push({ file, size: st.size });
    } catch {
      // A dangling symlink, or gone since readdir: nothing to define.
    }
  }
  return out;
}

/** The largest protocol file read. Every list and read scans and hashes the
 *  caller's `home` and `fold` files, and a cloned repo chooses the fold's;
 *  the built-ins are a few dozen KB. */
export const MAX_PROTOCOL_BYTES = 256 * 1024;

/** Scan the namespaces into a library. Files are looked up by the exact names
 *  `readdir` returns — never by opening a path built from a requested name —
 *  so a case-insensitive disk can't let `live_loop.md` answer for `LIVE_loop`.
 *  A file is ignored, with a reason, when its name isn't a protocol name, is
 *  reserved (`brane`, `home.x`, ...), is protected and outside `brane`,
 *  differs only in case from a name a less local namespace already defines,
 *  or, given `approved`, is outside `brane` and its current content isn't the
 *  content the operator approved (docs/protocols.md#approval). Without
 *  `approved` nothing needs approval, which is how the suite tests the rest. */
export function loadProtocolLibrary(
  namespaces: NamespaceDir[],
  opts: { approved?: ApprovedHash; display?: (abs: string) => string } = {},
): ProtocolLibrary {
  const entries = new Map<string, ProtocolLayer[]>();
  const ignored: IgnoredProtocol[] = [];
  // The spelling each name was first defined with, keyed without case.
  // Namespaces are scanned least local first, so brane's spelling wins.
  const spelling = new Map<string, string>();
  const ordered = [...namespaces].sort((a, b) => RANK.get(b.from)! - RANK.get(a.from)!);
  const seenDirs = new Set<string>();

  for (const ns of ordered) {
    const canonical = canonicalDir(ns.dir);
    if (seenDirs.has(canonical)) continue;
    seenDirs.add(canonical);
    for (const { file, size } of markdownFiles(ns.dir)) {
      const name = file.slice(0, -".md".length);
      const path = join(ns.dir, file);
      const ignore = (reason: string) => ignored.push({ from: ns.from, path, reason });

      if (size > MAX_PROTOCOL_BYTES) {
        ignore(`larger than ${MAX_PROTOCOL_BYTES / 1024} KB`);
        continue;
      }
      if (!PROTOCOL_NAME_RE.test(name)) {
        ignore(`"${name}" is not a protocol name (letters, digits, "_", "-" and ".", starting with a letter)`);
        continue;
      }
      if (isReservedProtocolName(name)) {
        ignore(`"${name}" is reserved: /brane, /home, /fold and /folds name namespaces`);
        continue;
      }
      const guarded = protectedProtocol(name);
      if (ns.from !== "brane" && guarded) {
        ignore(`/${guarded} is protected: only /brane.${guarded} resolves`);
        continue;
      }
      const lower = name.toLowerCase();
      const first = spelling.get(lower);
      if (first !== undefined && first !== name) {
        ignore(`"${name}" differs only in case from /${first}`);
        continue;
      }
      let approvedSha: string | undefined;
      if (opts.approved && ns.from !== "brane") {
        let text: string;
        try {
          text = readFileSync(path, "utf-8");
        } catch (err) {
          ignore(`unreadable: ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
          continue;
        }
        const current = sha256(text);
        const approved = opts.approved(path);
        if (approved !== current) {
          const shown = (opts.display ?? ((p: string) => p))(path);
          ignored.push({
            from: ns.from,
            path,
            reason: `${approved === undefined ? "not approved" : "changed since it was approved"}: ${approveHint(shown)}`,
            pending: { sha256: current, changed: approved !== undefined },
          });
          continue;
        }
        approvedSha = current;
      }
      spelling.set(lower, name);
      const layers = entries.get(name) ?? [];
      layers.push({ from: ns.from, path, ...(approvedSha ? { sha256: approvedSha } : {}) });
      entries.set(name, layers);
    }
  }
  for (const layers of entries.values()) layers.sort((a, b) => RANK.get(a.from)! - RANK.get(b.from)!);
  return { namespaces, entries, ignored };
}

/** A leading YAML block (`---` … `---`), as wiki pages carry. Anchored to
 *  the start, so it is tried once and stays linear. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** A protocol's text without its frontmatter. Once anything is put above it
 *  (the provenance line, the prelude) the block is no longer frontmatter: it
 *  renders as a rule and a setext heading made of its own keys. What it holds
 *  that a reader wants, `description:`, `list_protocols` already shows. */
export function stripFrontmatter(text: string): string {
  const front = FRONTMATTER_RE.exec(text);
  return front ? text.slice(front[0].length).replace(/^(?:[ \t]*\r?\n)+/, "") : text;
}

/** What `list_protocols` shows beside a protocol: its frontmatter
 *  `description:` if it has one (as wiki pages do), else its first prose line
 *  after any frontmatter. */
export function describeProtocol(content: string, fallback: string): string {
  let body = content;
  const front = FRONTMATTER_RE.exec(content);
  if (front) {
    const desc = /^description:[ \t]*(.+)$/m.exec(front[1]);
    if (desc) return desc[1].trim().replace(/^(["'])(.*)\1$/, "$2");
    body = content.slice(front[0].length);
  }
  const line = body
    .split("\n")
    .find((l) => l.trim().length > 0 && !l.startsWith("#") && !l.startsWith("---"));
  return line?.trim() ?? fallback;
}

function readDescription(path: string, fallback: string): string {
  try {
    return describeProtocol(readFileSync(path, "utf-8"), fallback);
  } catch {
    return fallback;
  }
}

export interface ProtocolListing {
  name: string;
  description: string;
  /** The namespace of the file in force, and its path. */
  from: ProtocolNamespace;
  path: string;
  /** Every namespace that has the name, most local first: `which -a`. */
  layers: Array<{ from: ProtocolNamespace; path: string }>;
  version: string;
}

/** What `list_protocols` and `GET /api/protocols` return. `commands` is every
 *  name that resolves to a file, bare and qualified: what the chat links. */
export function listProtocols(lib: ProtocolLibrary, display: DisplayPath) {
  const protocols: ProtocolListing[] = [];
  for (const [name, layers] of [...lib.entries].sort(([a], [b]) => a.localeCompare(b))) {
    protocols.push({
      name,
      description: readDescription(layers[0].path, name),
      from: layers[0].from,
      path: display(layers[0].path),
      layers: layers.map((l) => ({ from: l.from, path: display(l.path) })),
      version: "1.0.0",
    });
  }
  const layerMap: Record<string, ProtocolNamespace[]> = {};
  for (const [name, layers] of lib.entries) layerMap[name] = layers.map((l) => l.from);
  return {
    protocols,
    namespaces: lib.namespaces.map((ns) => ({ from: ns.from, dir: display(ns.dir) })),
    ignored: lib.ignored.map((i) => ({
      from: i.from,
      path: display(i.path),
      reason: i.reason,
      ...(i.pending ? { pending: i.pending } : {}),
    })),
    commands: protocolCommandNames(layerMap),
  };
}

export type ProtocolRead =
  | {
      kind: "document";
      name: string;
      from: ProtocolNamespace;
      path: string;
      layers: Array<{ from: ProtocolNamespace; path: string }>;
      /** Files of this name that are not in force for want of the operator's
       *  approval, most local first; absent when there are none. They are
       *  never in `layers`, which lists only what resolves. */
      pending?: PendingLayer[];
      content: string;
    }
  | { kind: "generated"; name: string; content: string };

export interface PendingLayer {
  from: ProtocolNamespace;
  path: string;
  /** An earlier version was approved; this one isn't. */
  changed: boolean;
}

/** The files named `name` that await the operator's approval, most local
 *  first. A pending file passed every other check, so its file name is
 *  exactly `<name>.md`. */
function pendingFor(lib: ProtocolLibrary, name: string): IgnoredProtocol[] {
  return lib.ignored
    .filter((i) => i.pending && basename(i.path) === `${name}.md`)
    .sort((a, b) => RANK.get(a.from)! - RANK.get(b.from)!);
}

/** What an agent is told about a file of the name it asked for that isn't in
 *  force yet: so `/standup` before approval says "awaits approval", not
 *  "doesn't exist", and the operator learns there is something to approve. */
function pendingNote(name: string, p: IgnoredProtocol, display: DisplayPath): string {
  const why = p.pending!.changed ? "it changed since it was approved" : "it awaits the operator's approval";
  return `/${p.from}.${name} (\`${display(p.path)}\`) is not in force: ${why}, and ${approveHint(display(p.path))}. An agent can't approve it; tell the operator if it matters.`;
}

/** Resolve and read a `/command`. `from` restricts a bare name to one
 *  namespace, as the qualified spelling does. The prelude is prepended to
 *  every document but itself unless `noPrelude`. A file not from `brane`, or
 *  any file when others share its name, opens with a line saying which file
 *  this is and which others exist, so an agent can never mistake a shadowed
 *  copy for the one in force or miss that another exists. */
export function readProtocol(
  lib: ProtocolLibrary,
  raw: string,
  opts: { from?: string; noPrelude?: boolean; display: DisplayPath; installDir?: string },
): ProtocolRead {
  if (typeof raw !== "string" || raw.length === 0) throw new ProtocolError("name is required");
  if (opts.from !== undefined && !SEARCH_ORDER.includes(opts.from as ProtocolNamespace)) {
    throw new ProtocolError(`from must be one of ${SEARCH_ORDER.map((n) => `"${n}"`).join(", ")}`);
  }
  const ref = parseProtocolRef(raw);
  if (ref.kind === "invalid") throw new ProtocolError(ref.reason);
  if (ref.kind === "index") {
    if (opts.from !== undefined) throw new ProtocolError(`/${raw} lists a namespace; "from" doesn't apply`);
    return { kind: "generated", name: raw, content: renderIndex(lib, ref.namespace, opts.display, opts.installDir) };
  }

  const name = ref.name;
  if (ref.from && opts.from && ref.from !== opts.from) {
    throw new ProtocolError(`"${raw}" names namespace "${ref.from}", but from is "${opts.from}"`);
  }
  const from = (ref.from ?? opts.from) as ProtocolNamespace | undefined;
  const guarded = protectedProtocol(name);
  if (from && from !== "brane" && guarded) {
    throw new ProtocolError(`/${guarded} is protected: only /brane.${guarded} resolves`);
  }

  const pending = pendingFor(lib, name);
  const layers = lib.entries.get(name);
  if (!layers) {
    const waiting = pending.filter((p) => !from || p.from === from);
    if (waiting.length > 0) {
      throw new ProtocolError(
        `No ${from ? `/${from}.${name}` : `protocol /${name}`} in force. ${waiting.map((p) => pendingNote(name, p, opts.display)).join(" ")}`,
      );
    }
    const near = [...lib.entries.keys()].find((k) => k.toLowerCase() === name.toLowerCase());
    throw new ProtocolError(
      near
        ? `No protocol /${name}; did you mean /${near}?`
        : `No protocol /${name}. list_protocols, or /fold, /home and /brane, show what exists.`,
    );
  }
  const chosen = from ? layers.find((l) => l.from === from) : layers[0];
  if (!chosen) {
    const where = layers.map((l) => `/${l.from}.${name}`).join(", ");
    const waiting = pending.find((p) => p.from === from);
    throw new ProtocolError(
      `No /${from}.${name}; /${name} is defined as ${where}${waiting ? `. ${pendingNote(name, waiting, opts.display)}` : ""}`,
    );
  }

  let body: string;
  try {
    body = readFileSync(chosen.path, "utf-8");
  } catch (err) {
    throw new ProtocolError(`Couldn't read ${opts.display(chosen.path)}: ${(err as Error).message}`);
  }
  if (chosen.sha256 && sha256(body) !== chosen.sha256) {
    throw new ProtocolError(
      `${opts.display(chosen.path)} changed since it was approved: ${approveHint(opts.display(chosen.path))}`,
    );
  }

  body = stripFrontmatter(body);
  const stamp = [provenance(name, chosen, layers, opts.display), ...pending.map((p) => `> ${pendingNote(name, p, opts.display)}`)]
    .filter((line): line is string => line !== null)
    .join("\n>\n");
  let content = stamp ? `${stamp}\n\n${body}` : body;
  if (name !== "prelude" && !opts.noPrelude) {
    const prelude = lib.entries.get("prelude")?.find((l) => l.from === "brane");
    if (prelude) {
      try {
        content = readFileSync(prelude.path, "utf-8") + "\n---\n\n" + content;
      } catch {
        // No prelude: the document alone.
      }
    }
  }
  return {
    kind: "document",
    name,
    from: chosen.from,
    path: opts.display(chosen.path),
    layers: layers.map((l) => ({ from: l.from, path: opts.display(l.path) })),
    ...(pending.length > 0
      ? { pending: pending.map((p) => ({ from: p.from, path: opts.display(p.path), changed: p.pending!.changed })) }
      : {}),
    content,
  };
}

/** The line a non-built-in or shadowed file opens with; null for a built-in
 *  nothing shadows, which reads exactly as it always has. */
function provenance(
  name: string,
  chosen: ProtocolLayer,
  layers: ProtocolLayer[],
  display: DisplayPath,
): string | null {
  const inForce = layers[0];
  const where = `\`${display(chosen.path)}\``;
  if (chosen !== inForce) {
    return `> This is /${chosen.from}.${name} (${where}), for reference: the /${name} in force is /${inForce.from}.${name}.`;
  }
  const others = layers.slice(1).map((l) => `/${l.from}.${name}`);
  if (chosen.from === "brane" && others.length === 0) return null;
  const whose = chosen.from === "fold" ? "this project's" : chosen.from === "home" ? "this operator's" : "brane's built-in";
  const shadows = others.length > 0 ? ` It shadows ${others.join(", ")}, readable by that name.` : "";
  return `> /${name} here is ${whose} protocol, ${where}.${shadows}`;
}

/** The page a bare namespace name returns: its protocols with descriptions,
 *  what each shadows or is shadowed by, and the files it ignored and why. */
function renderIndex(
  lib: ProtocolLibrary,
  namespace: ProtocolNamespace | "folds",
  display: DisplayPath,
  installDir?: string,
): string {
  if (namespace === "folds") {
    const fold = lib.namespaces.find((n) => n.from === "fold");
    return [
      "# /folds",
      "",
      "Every fold's protocols, by fold. For now two resolve:",
      "",
      `- /folds.self is /fold, this session's own fold${fold ? ` (\`${display(fold.dir)}\`)` : " (this session has none)"}.`,
      "- /folds.brane is /brane, the built-ins brane ships.",
      "",
      "Reaching another fold's shared protocols, as /folds.<label>.<name>, is not available yet.",
    ].join("\n");
  }

  const ns = lib.namespaces.find((n) => n.from === namespace);
  const title = `# /${namespace}`;
  const what =
    namespace === "fold"
      ? "this project's protocols, searched first"
      : namespace === "home"
        ? "this operator's protocols, searched after /fold and before /brane"
        : "brane's built-in protocols, searched last";
  if (!ns) {
    return [title, "", `This session has no fold, so /${namespace} is empty.`].join("\n");
  }
  const lines = [title, "", `\`${display(ns.dir)}/\`: ${what}.`, ""];

  const mine = [...lib.entries]
    .filter(([, layers]) => layers.some((l) => l.from === namespace))
    .sort(([a], [b]) => a.localeCompare(b));
  if (mine.length === 0) {
    lines.push(
      `No protocols here. A file \`${display(ns.dir)}/<name>.md\` defines /<name> (and /${namespace}.<name>);`,
      "agents don't create or edit protocol files unless the operator asks.",
    );
  } else {
    for (const [name, layers] of mine) {
      const own = layers.find((l) => l.from === namespace)!;
      const desc = readDescription(own.path, "");
      const notes: string[] = [];
      if (layers[0] !== own) notes.push(`shadowed by /${layers[0].from}.${name}`);
      const below = layers.slice(layers.indexOf(own) + 1).map((l) => `/${l.from}.${name}`);
      if (layers[0] === own && below.length > 0) notes.push(`shadows ${below.join(", ")}`);
      const note = notes.length > 0 ? ` (${notes.join("; ")})` : "";
      lines.push(`- /${name}${note}${desc ? `: ${desc}` : ""}`);
    }
  }

  const pending = lib.ignored.filter((i) => i.from === namespace && i.pending);
  if (pending.length > 0) {
    lines.push(
      "",
      "Awaiting the operator's approval, and not in force until then (an agent can't approve; say so to the operator if one matters):",
      "",
    );
    for (const i of pending) lines.push(`- \`${display(i.path)}\`${i.pending!.changed ? " (changed since approved)" : ""}`);
  }
  const skipped = lib.ignored.filter((i) => i.from === namespace && !i.pending);
  if (skipped.length > 0) {
    lines.push("", "Ignored:", "");
    for (const i of skipped) lines.push(`- \`${display(i.path)}\`: ${i.reason}`);
  }
  if (namespace === "brane" && installDir) {
    lines.push(
      "",
      `Brane's own documentation is under \`${display(installDir)}\`: \`AGENTS.md\` is the index, with \`docs/\`, \`SECURITY.md\` and \`DESIGN.md\` beside it.`,
    );
  }
  return lines.join("\n");
}
