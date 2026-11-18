// The wire types of the agent API (docs/agent-chat-plan.md §7).
//
// The page mirrors these by hand in `ui/src/ui/chat/chat-types.ts`; change
// both together.

/**
 * `api`: FluidCAD's own agent loop on a model provider the user has a key
 * for, or a local server (§20). Its sessions' model ids are provider-qualified:
 * `<providerId>/<model>`.
 */
export type AgentKind = 'claude' | 'codex' | 'api';

export type ApiProviderKind = 'anthropic' | 'openai' | 'openrouter' | 'openai-compatible';

/** A model provider of the API agent, as Settings and the panel see it (§20.3). Never carries a key. */
export type ApiProviderStatus = {
  id: string;
  kind: ApiProviderKind;
  label: string;
  builtIn: boolean;
  /** Custom entries. */
  baseURL?: string;
  hasKey: boolean;
  /** `env`: the key comes from the environment, and Settings offers no field for it. */
  keySource: 'env' | 'stored' | null;
  /**
   * The key's first characters and "…" (`sk-or-v1-a…`), so Settings can say
   * which key it is: at most 10 characters and a quarter of the key. Absent
   * without a key. Never more of the key than that.
   */
  keyPreview?: string;
  /** Built-ins: the environment variable that wins over a stored key. */
  envVar?: string;
  /** Built-ins: has a key. Custom entries: has a base URL (the key is optional). */
  ready: boolean;
  /** Whether images (the references capture, screenshots) are sent to its models. */
  images: boolean;
  contextWindow?: number;
  /** e.g. "No API key.", or that its key was refused when its models were listed. */
  problem?: string;
};

export type PermissionMode = 'ask' | 'auto-edits';

/**
 * How hard the model thinks: one of the agent's own levels. Claude Code
 * takes {@link CLAUDE_EFFORTS}; Codex types it as a string and each model
 * lists its own (`AgentModel.efforts`).
 */
export type Effort = string;

/** Claude Code's `--effort` choices (`claude --help`, 2.1.326). */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** A Codex reasoning effort word (`low` … `max`, `ultra`, as `model/list` names them). */
export const EFFORT_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;

/** Whether `effort` is a level agent `kind` takes (Codex and the API agent: whatever the model lists). */
export function isEffortFor(kind: AgentKind, effort: unknown): effort is string {
  if (typeof effort !== 'string') {
    return false;
  }
  return kind === 'claude' ? (CLAUDE_EFFORTS as readonly string[]).includes(effort) : EFFORT_PATTERN.test(effort);
}

/** A provider id of the API agent: a built-in name or a custom entry's slug. */
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * An API agent model id split at the first `/`: `ollama/qwen3-vl:4b` →
 * `{ providerId: 'ollama', model: 'qwen3-vl:4b' }`. Null when it has no
 * provider part.
 */
export function splitApiModelId(id: string): { providerId: string; model: string } | null {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) {
    return null;
  }
  const providerId = id.slice(0, slash);
  return PROVIDER_ID_PATTERN.test(providerId) ? { providerId, model: id.slice(slash + 1) } : null;
}

/**
 * One reference to scene geometry, attached to a user message (§11). Built
 * by the page from `api/resolve-selection`; carried as is. The text the CLI
 * gets for it comes in phase 6 (`formatSceneReferences`).
 */
export type SceneReference = {
  n: number;
  color: { name: string; hex: string };
  kind: 'face' | 'edge' | 'mixed';
  count: number;
  file: string;
  selector: {
    source: string;
    producers: { variable: string; feature: string; featureType: string; line: number | null; bound: boolean }[];
    imports: string[];
    alternatives: string[];
  };
  geometry: unknown[];
  unit: string;
};

/** Body of `POST api/agent/sessions/:id/messages`. */
export type SendMessage = {
  text: string;
  references?: SceneReference[];
  /** The references capture, PNG. */
  image?: { mediaType: 'image/png'; base64: string };
  /** A model alias or full name; absent: the preference, else the CLI's default. */
  model?: string;
  effort?: Effort;
  /** Absent means 'ask'. */
  mode?: PermissionMode;
};

export type SessionStatus =
  | { state: 'idle' }
  /** Spawning the CLI. */
  | { state: 'starting'; turnId: string }
  | { state: 'running'; turnId: string }
  | { state: 'awaiting-approval'; turnId: string; approvalIds: string[] }
  /** The engine restarted while a turn was running. */
  | { state: 'interrupted'; reason: string }
  | { state: 'error'; kind: 'auth' | 'rate-limit' | 'not-installed' | 'other'; message: string; resetsAt?: string };

export type ToolPartState = 'running' | 'awaiting-approval' | 'done' | 'error' | 'denied';

export type ToolPart = {
  type: 'tool';
  id: string;
  /** `fluidcad`: a FluidCAD MCP tool, reported by the gate. `agent`: the CLI's own tool (Read, Glob, Grep). */
  source: 'fluidcad' | 'agent';
  name: string;
  title: string;
  kind: 'read' | 'edit' | 'outside' | 'other';
  state: ToolPartState;
  input: unknown;
  /** Unified diff of the file now against the result, for `write_file` and `edit_range`. */
  diff?: string;
  /** `images` are file names under the session's `files/`. */
  output?: { text?: string; images?: string[] };
  error?: string;
  /**
   * `dirty-buffer`: the write was refused because the file has unsaved
   * changes in an editor; `error` names the file.
   */
  errorCode?: 'dirty-buffer';
  /**
   * Set when the call needed the user's approval. `canAllowSession` says
   * whether "Allow for this session" is offered (never for actions outside
   * the workspace). `decision` is set once the user answered.
   */
  approval?: { id: string; canAllowSession: boolean; decision?: ApprovalDecision };
};

/** Body of `POST api/agent/sessions/:id/approvals/:approvalId`. */
export type ApprovalDecision = 'allow' | 'allow-session' | 'deny';

export type ChatPart =
  | { type: 'text'; id: string; text: string }
  | { type: 'reasoning'; id: string; text: string }
  /** `file` is a name under the session's `files/`. */
  | { type: 'image'; id: string; file: string }
  | { type: 'references'; id: string; references: SceneReference[] }
  | ToolPart
  | NoticePart;

/**
 * A line from the runtime: stopped, a plan limit, a sign-in problem, a
 * restart. `resetsAt` (an ISO instant) is when a plan limit resets: the page
 * words it in the user's local time ("resets in 3 h, at 17:00"); `text`
 * never carries it. (Notices stored before it existed may have the instant
 * in `text`.)
 */
export type NoticePart = { type: 'notice'; id: string; level: 'info' | 'warning' | 'error'; text: string; resetsAt?: string };

/** What a turn cost, as the CLI reported it at its end. */
export type TurnUsage = { inputTokens?: number; outputTokens?: number; costUsd?: number };

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  turnId: string;
  createdAt: string;
  parts: ChatPart[];
};

export type TurnRecord = {
  id: string;
  userMessageId: string;
  revertible: boolean;
  /** Set when the turn ended; a turn without it was cut off by an engine restart. */
  endedAt?: string;
  endReason?: 'done' | 'interrupted' | 'error';
  /** Workspace-relative paths the turn changed (has checkpoints for), in order. */
  files?: string[];
  /** Set when the turn's changes were reverted. */
  revertedAt?: string;
  /** What the turn used, from its `usage` event (tokens; the cost when the CLI gives one). */
  usage?: TurnUsage;
};

export type SessionSnapshot = {
  id: string;
  title: string;
  agent: AgentKind;
  createdAt: string;
  updatedAt: string;
  /** Random per engine process. */
  epoch: string;
  /** Sequence number of the last event already folded into `messages`. */
  seq: number;
  status: SessionStatus;
  /** Completed messages plus the one in flight. */
  messages: ChatMessage[];
  turns: TurnRecord[];
  /** The model the session last ran with; null for the CLI's default. */
  model: string | null;
  /** The effort the session last ran with; null for the CLI's default. */
  effort: string | null;
};

export type SessionSummary = {
  id: string;
  title: string;
  agent: AgentKind;
  updatedAt: string;
  status: SessionStatus;
  /** The model the session last ran with (provider-qualified for the API agent); null for the CLI's default. */
  model: string | null;
};

export type ChatEvent =
  /** A message begins. User messages are streamed too, so every open tab sees them. */
  | { type: 'message-start'; message: { id: string; role: 'user' | 'assistant'; turnId: string; createdAt: string } }
  | { type: 'part-start'; messageId: string; part: ChatPart }
  /** Appends to a text or reasoning part. */
  | { type: 'part-delta'; messageId: string; partId: string; text: string }
  /** Merges into a part (tool cards). */
  | { type: 'part-update'; messageId: string; partId: string; patch: Partial<ChatPart> }
  | { type: 'message-end'; messageId: string }
  | { type: 'status'; status: SessionStatus }
  /** What the turn `turnId` used; recorded on its turn (`TurnRecord.usage`). */
  | { type: 'usage'; turnId?: string; inputTokens?: number; outputTokens?: number; costUsd?: number }
  /**
   * The turn kept a copy of a file before changing it. `files` is every file
   * the turn has a copy of so far (workspace-relative): the turn is
   * revertible while it is not empty.
   */
  | { type: 'checkpoint'; turnId: string; files: string[] }
  /** The turn's changes were reverted (`POST …/revert`): `files` are back as they were before it. */
  | { type: 'reverted'; turnId: string; files: string[] }
  /** Title changed (first message, or a rename). */
  | { type: 'title'; title: string }
  /** The stream cannot continue from where the client is: refetch the snapshot. */
  | { type: 'resync' };

/** One SSE `data:` payload. */
export type ChatEventEnvelope = { epoch: string; seq: number; event: ChatEvent };
