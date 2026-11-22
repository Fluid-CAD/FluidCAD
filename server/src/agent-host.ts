// The contract between the engine and the in-app agent runtime (`agent/`).
//
// The engine never imports the runtime statically: `routes/agent.ts` loads
// `agent/dist/index.js` on the first `api/agent` request and hands it these
// dependencies. An engine built without `agent/` answers those routes with
// 404, and the page hides the Agent button.

import type { Router } from 'express';
import type { Preferences } from './preferences.ts';
import type { ParamDefinition } from '../../lib/dist/index.js';

/** What the open model's last render came to, as the agent is told about it. */
export type AgentRenderState = {
  state: 'rendered' | 'build-error' | 'compile-error' | 'none';
  /** The compile error, or the first failed feature's message. */
  message?: string;
};

export type AgentHostDeps = {
  /** The engine's workspace, absolute. */
  workspacePath: string;
  /** This engine's own port: the agent's MCP endpoint is reached on loopback through it. */
  port: number;
  /** The engine's package version. */
  version: string;
  /** When this engine started (ISO), as the instance registry records it. */
  startedAt: string;
  /** The model file on screen, absolute; null when none is open. */
  currentFile(): string | null;
  renderState(): AgentRenderState;
  /** The project's length unit (`mm`, `in`, …). */
  unit(): string;
  loadPreferences(): Promise<Preferences>;
  /**
   * The parameters the model on screen declared in its last finished render,
   * each with the value it has now (a session override included): what a
   * chat's parameter card may offer. Absent on an engine that cannot say;
   * the agent then has no parameters to offer.
   */
  modelParams?(): ParamDefinition[];
};

export type AgentModule = {
  createAgentRouter(deps: AgentHostDeps): Router;
};
