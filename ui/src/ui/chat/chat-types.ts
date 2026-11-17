// The wire types of the agent API (docs/agent-chat-plan.md §7), mirrored by
// hand from `agent/src/types.ts` and `agent/src/backend.ts` (`AgentInstall`,
// `AgentModel`), as `screenshot-overlays.ts` mirrors `ws-protocol.ts`. The
// page never imports the agent package; change both together.

export type AgentKind = 'claude' | 'codex';

export type PermissionMode = 'ask' | 'auto-edits';

/**
 * How hard the model thinks: one of the agent's own levels. Claude Code
 * takes {@link CLAUDE_EFFORTS}; each Codex model lists its own
 * (`AgentModel.efforts`).
 */
export type Effort = string;

/** Claude Code's `--effort` choices (`claude --help`, 2.1.326). */
export const CLAUDE_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The levels every agent takes: what is offered when a model lists none. */
export const COMMON_EFFORTS: readonly string[] = ['low', 'medium', 'high'];

/** An effort as the pickers name it: "Low", "Extra high", "Max". */
export function effortLabel(effort: string): string {
  if (effort === 'xhigh') {
    return 'Extra high';
  }
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** One reference to scene geometry, attached to a user message (§11, phase 6). */
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
  image?: { mediaType: 'image/png'; base64: string };
  /** A model alias or full name; `default` means the CLI's own setting. */
  model?: string;
  effort?: Effort;
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

export type TextPart = { type: 'text'; id: string; text: string };
export type ReasoningPart = { type: 'reasoning'; id: string; text: string };
export type ImagePart = { type: 'image'; id: string; file: string };
export type ReferencesPart = { type: 'references'; id: string; references: SceneReference[] };
/**
 * `resetsAt` (ISO): when a plan limit resets, worded in local time by the
 * page. Notices stored before it existed carry the instant in `text`.
 */
export type NoticePart = { type: 'notice'; id: string; level: 'info' | 'warning' | 'error'; text: string; resetsAt?: string };

/** What a turn cost, as the CLI reported it at its end. */
export type TurnUsage = { inputTokens?: number; outputTokens?: number; costUsd?: number };

export type ChatPart = TextPart | ReasoningPart | ImagePart | ReferencesPart | ToolPart | NoticePart;

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
  /** What the turn used (its `usage` event). */
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
  messages: ChatMessage[];
  turns: TurnRecord[];
  /** The model the session last ran with; null for the CLI's default. */
  model: string | null;
  /** The effort the session last ran with; null (or absent, from an older engine) for the CLI's default. */
  effort?: string | null;
};

export type SessionSummary = {
  id: string;
  title: string;
  agent: AgentKind;
  updatedAt: string;
  status: SessionStatus;
};

export type ChatEvent =
  | { type: 'message-start'; message: { id: string; role: 'user' | 'assistant'; turnId: string; createdAt: string } }
  | { type: 'part-start'; messageId: string; part: ChatPart }
  | { type: 'part-delta'; messageId: string; partId: string; text: string }
  | { type: 'part-update'; messageId: string; partId: string; patch: Partial<ChatPart> }
  | { type: 'message-end'; messageId: string }
  | { type: 'status'; status: SessionStatus }
  /** What the turn `turnId` used; recorded on its turn. */
  | { type: 'usage'; turnId?: string; inputTokens?: number; outputTokens?: number; costUsd?: number }
  /**
   * The turn kept a copy of a file before changing it. `files` is every file
   * the turn has a copy of so far (workspace-relative): the turn is
   * revertible while it is not empty.
   */
  | { type: 'checkpoint'; turnId: string; files: string[] }
  /** The turn's changes were reverted (`POST …/revert`): `files` are back as they were before it. */
  | { type: 'reverted'; turnId: string; files: string[] }
  | { type: 'title'; title: string }
  | { type: 'resync' };

/** One SSE `data:` payload. */
export type ChatEventEnvelope = { epoch: string; seq: number; event: ChatEvent };

/** Answer of `POST api/agent/sessions/:id/revert`: what was put back, and what could not be (with why). */
export type RevertResult = { restored: string[]; failed?: { path: string; error: string }[] };

/** What detection found for one CLI (`GET api/agent/agents`). */
export type AgentInstall = {
  kind: AgentKind;
  path: string | null;
  version: string | null;
  /** The oldest version the driver supports; empty when FluidCAD has no driver for it. */
  minVersion: string;
  /** Found and at least `minVersion`. */
  supported: boolean;
  /** null: could not tell. */
  loggedIn: boolean | null;
  /** Claude Code: `claude.ai` (subscription), `api_key`, `none`. */
  authMethod?: string | null;
  /** What to tell the user when it is not ready. */
  problem?: string;
};

export type AgentModel = {
  /** What goes to the CLI; `default` means no model flag. */
  id: string;
  label?: string;
  /** Codex: the model Codex uses when none is chosen. */
  isDefault?: boolean;
  /** Codex: the reasoning efforts the model accepts, and the one it uses by default. */
  efforts?: string[];
  defaultEffort?: string;
};

/** Whether a status means a turn is in flight. */
export function isBusy(status: SessionStatus): boolean {
  return status.state === 'starting' || status.state === 'running' || status.state === 'awaiting-approval';
}
