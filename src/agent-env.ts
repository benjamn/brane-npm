/**
 * The environment variables that identify one agent session, which nothing
 * the daemon starts may inherit.
 *
 * A daemon restarted from an agent's shell (as /rrr does) inherits that
 * agent's environment, and so does every tmux server and session it then
 * starts. Brane's own pair would let another session act as that agent
 * (claude-jrjh1e8w:10). The harness's session variables do damage too: the
 * MCP bridge forwards `CLAUDE_CODE_SESSION_ID` as its author's session, so a
 * crush agent spawned by such a daemon stamped every narration with the
 * restarting Claude session's id (claude-eiuzl79r:33), and carried a copy of
 * that session's `CLAUDE_CODE_MESSAGING_TOKEN`. Claude overrides these for
 * its own children; other harnesses do not.
 *
 * Only session-scoped names belong here. User configuration that happens to
 * share a prefix (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`)
 * is the operator's and passes through.
 */
export const INHERITED_AGENT_ENV = [
  "BRANE_NARRATIVE_ID",
  "BRANE_NARRATIVE_SECRET",
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_PID",
] as const;

/** `env` without any inherited agent-session variable. */
export function withoutAgentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of INHERITED_AGENT_ENV) delete out[name];
  return out;
}

/** A shell prefix that runs a command with every inherited agent-session
 *  variable unset, for commands tmux starts from its global env. */
export function unsetAgentEnvPrefix(): string {
  return `env ${INHERITED_AGENT_ENV.map((name) => `-u ${name}`).join(" ")}`;
}
