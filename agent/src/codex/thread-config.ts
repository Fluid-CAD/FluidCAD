// What a chat session's Codex thread is started (and resumed) with
// (docs/agent-chat-plan.md §5.2 as corrected in §19).
//
// Codex runs read-only, never asks for approval, has no shell, plugins, apps,
// skills or sub-agents, keeps its web search, and sees exactly one MCP
// server: FluidCAD's endpoint for the session, named `fluidcad_app`. The user's own
// MCP servers (the `mcp_servers` of their config.toml) start in every thread
// unless disabled one by one, so each is disabled by name. Plugin servers are
// not listed there; `features.plugins` and `features.apps` turn them off.
// None of this touches `~/.codex/config.toml`: `config` is a per-thread
// overlay. `thread/resume` must carry all of it again, or the user's servers
// come back and FluidCAD's is dropped.

import { FLUIDCAD_MCP_SERVER } from '../claude/stream-json.ts';

export { FLUIDCAD_MCP_SERVER };

/** Per-request timeout Codex applies to our tools: an approval may take this long (default 60 s). */
export const CODEX_TOOL_TIMEOUT_SEC = 3600;

/** A model id that means "no model parameter": Codex's own configured default. */
export const DEFAULT_MODEL_ID = 'default';

export type ThreadConfigInput = {
  mcpUrl: string;
  /** The names under `mcp_servers` in the user's Codex config (`config/read`). */
  userServers: string[];
};

/** The dotted `config` overrides of a thread. */
export function buildThreadConfig(input: ThreadConfigInput): Record<string, unknown> {
  const config: Record<string, unknown> = {
    [`mcp_servers.${FLUIDCAD_MCP_SERVER}.url`]: input.mcpUrl,
    [`mcp_servers.${FLUIDCAD_MCP_SERVER}.tool_timeout_sec`]: CODEX_TOOL_TIMEOUT_SEC,
    [`mcp_servers.${FLUIDCAD_MCP_SERVER}.default_tools_approval_mode`]: 'approve',
  };
  for (const name of input.userServers) {
    if (name === FLUIDCAD_MCP_SERVER) {
      // A server of the user's that happens to share the name is replaced by ours above.
      continue;
    }
    config[`mcp_servers.${name}.enabled`] = false;
  }
  Object.assign(config, {
    'features.plugins': false,
    'features.apps': false,
    'features.shell_tool': false,
    web_search: 'live',
    'features.image_generation': false,
    'features.multi_agent': false,
    'features.goals': false,
    'features.view_image': false,
    'skills.include_instructions': false,
    'tools.experimental_request_user_input.enabled': false,
    'tools.update_plan.enabled': false,
  });
  return config;
}

export type ThreadParamsInput = ThreadConfigInput & {
  cwd: string;
  instructions: string;
  model?: string | null;
};

/** The params of `thread/start`; `thread/resume` takes the same plus `threadId`. */
export function buildThreadStartParams(input: ThreadParamsInput): Record<string, unknown> {
  return {
    cwd: input.cwd,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    developerInstructions: input.instructions,
    // Passed here too, not only on turn/start: otherwise Codex injects a
    // `<model_switch>` note into the conversation (§19).
    ...(modelParam(input.model) ? { model: modelParam(input.model) } : {}),
    config: buildThreadConfig(input),
  };
}

/** The params of `thread/resume`: everything again (§19), plus the thread. */
export function buildThreadResumeParams(threadId: string, input: ThreadParamsInput): Record<string, unknown> {
  return { threadId, ...buildThreadStartParams(input) };
}

/** The model to send, or null for Codex's default. */
export function modelParam(model: string | null | undefined): string | null {
  return model && model !== DEFAULT_MODEL_ID ? model : null;
}

/**
 * The user's MCP server names from a `config/read` result. `config.mcp_servers`
 * is a table of name → settings; an array of names is accepted too.
 */
export function userServerNames(configRead: unknown): string[] {
  const servers = (configRead as any)?.config?.mcp_servers;
  let names: unknown[] = [];
  if (Array.isArray(servers)) {
    names = servers;
  } else if (servers && typeof servers === 'object') {
    names = Object.keys(servers);
  }
  // Only names a dotted config key can carry; anything else could not be
  // addressed (and could not have been started from config.toml either).
  return [...new Set(names.filter((n): n is string => typeof n === 'string' && /^[A-Za-z0-9_-]+$/.test(n)))];
}
