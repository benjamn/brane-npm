#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand, runMain } from "citty";
import { foldCommand } from "./commands/fold.js";
import { daemonCommand } from "./commands/daemon.js";
import { spawnCommand } from "./commands/spawn.js";
import { listCommand } from "./commands/list.js";
import { attachCommand } from "./commands/attach.js";
import { reviveCommand } from "./commands/revive.js";
import { costCommand } from "./commands/cost.js";
import { tokenCommand } from "./commands/token.js";
import { memoryCommand } from "./commands/memory.js";
import { mcpCommand } from "./commands/mcp.js";
import { meldCommand } from "./commands/meld.js";
import { configCommand } from "./commands/config.js";
import { certifyCommand } from "./commands/certify.js";
import { absorbCommand } from "./commands/absorb.js";
import { doctorCommand } from "./commands/doctor.js";
import { protocolCommand } from "./commands/protocol.js";

// dist/cli.js sits one level below package.json both in the checkout and in
// the published tarball, so the version the CLI reports is the version that
// was published rather than a string that has to be bumped by hand.
const packageJson = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
) as { version: string; description: string };

const main = defineCommand({
  meta: {
    name: "brane",
    version: packageJson.version,
    description: packageJson.description,
  },
  subCommands: {
    fold: foldCommand,
    daemon: daemonCommand,
    spawn: spawnCommand,
    list: listCommand,
    attach: attachCommand,
    revive: reviveCommand,
    cost: costCommand,
    token: tokenCommand,
    memory: memoryCommand,
    mcp: mcpCommand,
    meld: meldCommand,
    config: configCommand,
    certify: certifyCommand,
    doctor: doctorCommand,
    protocol: protocolCommand,
    absorb: absorbCommand,
  },
});

runMain(main);
