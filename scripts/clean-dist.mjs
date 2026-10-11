// Sweep dist/ before tsc writes into it. tsc only ever adds files, so a
// long-lived checkout accumulates outputs whose source is gone (two
// `dist/wiki-*.mjs` shipped in the first tarball that way) and `npm pack`
// takes the directory as it finds it. Node's own rmSync is cross-platform and
// `force` makes a missing dist/ a no-op, so this needs no dependency.
//
// The running daemon loads from dist/: what it has imported is in memory, but
// the embedding worker and each new MCP bridge are loaded by path, so a search
// or a spawn landing in the few seconds between this sweep and tsc finishing
// can miss once. /rrr builds and then restarts, so that window is the cost.
import { rmSync } from "node:fs";

rmSync(new URL("../dist/", import.meta.url), { recursive: true, force: true });
