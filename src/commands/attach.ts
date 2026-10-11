import { defineCommand } from "citty";
import { execFileSync } from "node:child_process";
import { resolveTmux } from "../tmux.js";

export const attachCommand = defineCommand({
  meta: {
    name: "attach",
    description: "Attach to a tmux session",
  },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "Session/narrative ID to attach to",
    },
  },
  run({ args }) {
    // Check session exists
    try {
      execFileSync(resolveTmux(), ["has-session", "-t", args.id], { stdio: "ignore" });
    } catch {
      console.error(`No tmux session found: ${args.id}`);
      process.exit(1);
    }

    // Replace current process with tmux attach
    execFileSync(resolveTmux(), ["attach-session", "-t", args.id], {
      stdio: "inherit",
    });
  },
});
