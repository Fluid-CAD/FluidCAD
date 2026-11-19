// What a CLI backend provides (docs/agent-chat-plan.md §6.3). One driver per
// CLI; the session talks to this interface only.

import type { AgentKind, ApiProviderStatus, AttachmentMediaType } from './types.ts';

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
  /**
   * Starts signing the user in from the app (Codex: the ChatGPT login of its
   * app server, §5.2). Absent: the user signs in in a terminal.
   */
  login?(install: AgentInstall, env: NodeJS.ProcessEnv): Promise<BackendLogin>;
}

/**
 * A sign-in in progress: the page the user signs in on (opened in their
 * browser), and how it ends. Nothing about the account is kept or shown.
 */
export interface BackendLogin {
  readonly id: string;
  /** An https URL to open in the user's browser. */
  readonly url: string;
  /** Settles once the user finished, or the login failed, timed out or was cancelled. */
  readonly done: Promise<{ success: boolean; error?: string }>;
  cancel(): Promise<void>;
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
  /** Codex, API agent: whether the model accepts images (the references capture). */
  acceptsImages?: boolean;
  /** API agent: the provider the model belongs to (the `<providerId>` of its id). */
  provider?: string;
  /** API agent: the model's context window in tokens, when its provider says. */
  contextWindow?: number;
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
  /**
   * The session's own folder (where `session.json` is), for a backend that
   * keeps the conversation itself: the API agent stores its model history
   * there, under the name `ref` gives.
   */
  sessionDir?: string;
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
   * How the CLI authenticates, as it reports it (Claude Code: `claude.ai`
   * for the subscription, `api_key`, `none`). Claude Code runs on a Claude
   * subscription only: any other method is reported as not signed in.
   */
  authMethod?: string | null;
  /**
   * The account the CLI is signed in with, as it reports it: the email of
   * the Claude subscription or the ChatGPT account. Shown to the user next
   * to the agent's name; absent when signed in with an API key or when it
   * could not be told. Only the email is read, never credentials.
   */
  account?: string;
  /** API agent: every model provider and whether it is ready (`loggedIn`: any is). */
  providers?: ApiProviderStatus[];
  /** What to tell the user when it is not ready. */
  problem?: string;
};

/** An image of a turn's message, on disk (under the session's `files/`). */
export type TurnImage = { path: string; mediaType: AttachmentMediaType };

export interface AgentRun {
  /** Store this to resume later. */
  readonly ref: string;
  /**
   * Start a turn. `images` go with the text in this order: the user's
   * attachments, then the references capture.
   */
  send(input: { text: string; images?: TurnImage[] }): void;
  /** Ends when the CLI process exits. */
  readonly events: AsyncIterable<BackendEvent>;
  /** Ends the current turn; resolves once it has ended (or the process was killed). */
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

/** `resetsAt`: when a plan limit resets (ISO); `message` never carries it, the page words it in local time. */
export type TurnError = { kind: 'auth' | 'rate-limit' | 'other'; message: string; resetsAt?: string };

/**
 * `open()` could not start the run for a reason the user should see as
 * such (the API agent: no key for the chosen provider is `auth`); the
 * session ends the turn with `error` instead of a generic failure.
 */
export class TurnFailure extends Error {
  readonly error: TurnError;
  constructor(error: TurnError) {
    super(error.message);
    this.error = error;
  }
}

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
