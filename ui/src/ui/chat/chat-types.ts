// The wire types of the agent API (docs/agent-chat-plan.md §7), mirrored by
// hand from `agent/src/types.ts` and `agent/src/backend.ts` (`AgentInstall`,
// `AgentModel`), as `screenshot-overlays.ts` mirrors `ws-protocol.ts`. The
// page never imports the agent package; change both together.

export type AgentKind = 'claude' | 'codex';

export type PermissionMode = 'ask' | 'auto-edits';

export type Effort = 'low' | 'medium' | 'high';

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
  /** Unified diff, for file edits (phase 4). */
  diff?: string;
  /** `images` are file names under the session's `files/`. */
  output?: { text?: string; images?: string[] };
  error?: string;
  approval?: { id: string; decision?: 'allow' | 'allow-session' | 'deny' };
};

export type TextPart = { type: 'text'; id: string; text: string };
export type ReasoningPart = { type: 'reasoning'; id: string; text: string };
export type ImagePart = { type: 'image'; id: string; file: string };
export type ReferencesPart = { type: 'references'; id: string; references: SceneReference[] };
export type NoticePart = { type: 'notice'; id: string; level: 'info' | 'warning' | 'error'; text: string };

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
  endedAt?: string;
  endReason?: 'done' | 'interrupted' | 'error';
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
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: 'checkpoint'; turnId: string; files: string[] }
  | { type: 'title'; title: string }
  | { type: 'resync' };

/** One SSE `data:` payload. */
export type ChatEventEnvelope = { epoch: string; seq: number; event: ChatEvent };

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
};

/** Whether a status means a turn is in flight. */
export function isBusy(status: SessionStatus): boolean {
  return status.state === 'starting' || status.state === 'running' || status.state === 'awaiting-approval';
}
