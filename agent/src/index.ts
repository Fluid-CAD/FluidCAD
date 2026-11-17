// The in-engine agent runtime (docs/agent-chat-plan.md §6). The engine loads
// this file lazily (`server/src/routes/agent.ts`) and mounts the router it
// returns under `api/agent`.

import type { Router } from 'express';
import type { AgentHostDeps } from '../../server/dist/agent-host.js';
import { createRuntimeRouter } from './router.ts';
import { AgentRuntime } from './runtime.ts';

export function createAgentRouter(deps: AgentHostDeps): Router {
  return createRuntimeRouter(new AgentRuntime(deps));
}

export { AgentRuntime, AGENT_KINDS, UnsupportedAgentError, type AgentRuntimeOptions } from './runtime.ts';
export { createRuntimeRouter, parseSendMessage, streamEvents, HEARTBEAT_MS } from './router.ts';
export { AgentSession, SessionBusyError, DEFAULT_IDLE_MS, type SessionDeps, type TurnSetup } from './session.ts';
export { SessionStore, type SessionRecord } from './session-store.ts';
export { EventLog, type ReplayResult } from './event-log.ts';
export { ToolGate, toolClass, toolKind, toolTitle, editsUnavailableMessage, type ToolGateHost } from './tool-gate.ts';
export { McpEndpoint, McpEndpoints, SharedMcpIndexes } from './mcp-endpoint.ts';
export { ClaudeBackend, ClaudeRun, claudeChildEnv, CLAUDE_MIN_VERSION, CLAUDE_MODELS } from './claude/claude-backend.ts';
export { ClaudeStreamMapper } from './claude/stream-json.ts';
export { composeInstructions, buildCliText, workspaceStateTag, IN_APP_PREAMBLE } from './instructions.ts';
export { applyChatEvent } from './transcript.ts';
export { killAllChildren } from './children.ts';
export type * from './backend.ts';
export type * from './types.ts';
