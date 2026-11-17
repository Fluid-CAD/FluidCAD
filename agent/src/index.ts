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

export { AgentRuntime, AGENT_KINDS, AGENT_NAMES, LoginError, UnsupportedAgentError, type AgentRuntimeOptions, type LoginStatus } from './runtime.ts';
export { createRuntimeRouter, parseSendMessage, streamEvents, HEARTBEAT_MS } from './router.ts';
export { AgentSession, SessionBusyError, RevertError, DEFAULT_IDLE_MS, type SessionDeps, type TurnSetup, type RevertResult } from './session.ts';
export { SessionStore, type SessionRecord, type Checkpoint } from './session-store.ts';
export { EventLog, type ReplayResult } from './event-log.ts';
export {
  ToolGate,
  toolClass,
  toolKind,
  toolTitle,
  needsApproval,
  canAllowForSession,
  unifiedDiff,
  APPROVAL_TIMEOUT_MS,
  DECLINED_MESSAGE,
  FORCE_REFUSED_MESSAGE,
  type ToolGateHost,
  type ToolGateOptions,
  type GateTimers,
} from './tool-gate.ts';
export { McpEndpoint, McpEndpoints, SharedMcpIndexes } from './mcp-endpoint.ts';
export { ClaudeBackend, ClaudeRun, claudeChildEnv, CLAUDE_MIN_VERSION, CLAUDE_MODELS } from './claude/claude-backend.ts';
export { ClaudeStreamMapper } from './claude/stream-json.ts';
export { CodexBackend, CodexRun, CODEX_MIN_VERSION, codexTargetTriples, resolveCodexProgram } from './codex/codex-backend.ts';
export { CodexAppServer } from './codex/app-server.ts';
export { CodexEventMapper, mapCodexError } from './codex/notifications.ts';
export { buildThreadConfig, buildThreadStartParams, buildThreadResumeParams, userServerNames } from './codex/thread-config.ts';
export { declineServerRequest } from './codex/server-requests.ts';
export { composeInstructions, inAppPreamble, buildCliText, workspaceStateTag, revertedChangesNote, IN_APP_PREAMBLE } from './instructions.ts';
export { applyChatEvent } from './transcript.ts';
export { killAllChildren } from './children.ts';
export type * from './backend.ts';
export type * from './types.ts';
