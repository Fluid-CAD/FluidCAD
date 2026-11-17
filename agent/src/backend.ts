// What a CLI backend provides (docs/agent-chat-plan.md §6.3). One driver per
// CLI; the session talks to this interface only.

import type { AgentKind } from './types.ts';

export type { AgentKind } from './types.ts';

export type DetectOptions = {
  /** The user's override path (preferences); must be an absolute path to the program. */
  pathOverride?: string;
  /** The environment the CLI will run with (PATH for the lookup, the auth variables). */
  env: NodeJS.ProcessEnv;
};

export interface AgentBackend {
  readonly kind: AgentKind;
  /** Locate the binary, read its version and login state. No model request. */
  detect(options: DetectOptions): Promise<AgentInstall>;
  /** Models to offer; empty when the CLI cannot list them. `env` is what the CLI would run with. */
  models(install: AgentInstall, env?: NodeJS.ProcessEnv): Promise<AgentModel[]>;
  /** Spawn (or attach to) the CLI for one chat session. */
  open(options: OpenOptions): Promise<AgentRun>;
  /** Ends whatever the backend keeps running beyond its runs (Codex's shared app server). */
  dispose?(): Promise<void>;
}

export type AgentModel = {
  /** What goes to the CLI; `default` means no model flag (the CLI's own setting). */
  id: string;
  label?: string;
  /** Codex (`model/list`): a one-line description. */
  description?: string;
  /** Codex: the model Codex uses when none is chosen. */
  isDefault?: boolean;
  /** Codex: the reasoning efforts the model accepts, and the one it uses by default. */
  efforts?: string[];
  defaultEffort?: string;
  /** Codex: whether the model accepts images (the references capture). */
  acceptsImages?: boolean;
};

export type OpenOptions = {
  install: AgentInstall;
  /**
   * Claude session UUID or Codex thread id to continue; null starts a new
   * conversation. A backend that cannot find the conversation may start a
   * new one instead (Codex does, and says so): its `ref` then differs.
   */
  resume: string | null;
  cwd: string;
  mcpUrl: string;
  instructions: string;
  model?: string;
  effort?: string;
  env: NodeJS.ProcessEnv;
};

export type AgentInstall = {
  kind: AgentKind;
  path: string | null;
  version: string | null;
  /** The oldest version the driver supports. */
  minVersion: string;
  /** Found and at least `minVersion`. */
  supported: boolean;
  /** null: could not tell. */
  loggedIn: boolean | null;
  /**
   * How the CLI will authenticate, as it reports it (Claude Code:
   * `claude.ai` for the subscription, `api_key`, `none`). Account fields
   * are never read into this.
   */
  authMethod?: string | null;
  /** What to tell the user when it is not ready. */
  problem?: string;
};

export interface AgentRun {
  /** Store this to resume later. */
  readonly ref: string;
  /** Start a turn. `imagePath` is a PNG on disk. */
  send(input: { text: string; imagePath?: string }): void;
  /** Ends when the CLI process exits. */
  readonly events: AsyncIterable<BackendEvent>;
  /** Ends the current turn; resolves once it has ended (or the process was killed). */
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

/** `resetsAt`: when a plan limit resets (ISO); `message` never carries it, the page words it in local time. */
export type TurnError = { kind: 'auth' | 'rate-limit' | 'other'; message: string; resetsAt?: string };

export type BackendEvent =
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'block-end'; id: string }
  /** The CLI's OWN tools only (Read, Glob, Grep, …). FluidCAD tools come from the gate. */
  | {
      type: 'tool';
      id: string;
      name: string;
      title: string;
      state: 'running' | 'done' | 'error';
      input?: unknown;
      output?: string;
      error?: string;
    }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  /** `resetsAt`: when a plan limit resets (ISO); the words never carry it. */
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; text: string; resetsAt?: string }
  | { type: 'turn-end'; reason: 'done' | 'interrupted' | 'error'; error?: TurnError };
