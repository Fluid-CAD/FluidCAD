// The wire types of the agent API (docs/agent-chat-plan.md §7).
//
// The page mirrors these by hand in `ui/src/ui/chat/chat-types.ts`; change
// both together.

export type AgentKind = 'claude' | 'codex';

export type PermissionMode = 'ask' | 'auto-edits';

export type Effort = 'low' | 'medium' | 'high';

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
  /** Unified diff, for file edits (phase 4). */
  diff?: string;
  /** `images` are file names under the session's `files/`. */
  output?: { text?: string; images?: string[] };
  error?: string;
  approval?: { id: string; decision?: 'allow' | 'allow-session' | 'deny' };
};

export type ChatPart =
  | { type: 'text'; id: string; text: string }
  | { type: 'reasoning'; id: string; text: string }
  /** `file` is a name under the session's `files/`. */
  | { type: 'image'; id: string; file: string }
  | { type: 'references'; id: string; references: SceneReference[] }
  | ToolPart
  | { type: 'notice'; id: string; level: 'info' | 'warning' | 'error'; text: string };

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
};

export type SessionSummary = {
  id: string;
  title: string;
  agent: AgentKind;
  updatedAt: string;
  status: SessionStatus;
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
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: 'checkpoint'; turnId: string; files: string[] }
  /** Title changed (first message, or a rename). */
  | { type: 'title'; title: string }
  /** The stream cannot continue from where the client is: refetch the snapshot. */
  | { type: 'resync' };

/** One SSE `data:` payload. */
export type ChatEventEnvelope = { epoch: string; seq: number; event: ChatEvent };
