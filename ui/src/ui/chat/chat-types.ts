// The wire types of the agent API (docs/agent-chat-plan.md §7), mirrored by
// hand from `agent/src/types.ts` and `agent/src/backend.ts` (`AgentInstall`,
// `AgentModel`), as `screenshot-overlays.ts` mirrors `ws-protocol.ts`. The
// page never imports the agent package; change both together.

/**
 * `api`: FluidCAD's own agent loop on a model provider the user has a key
 * for, or a local server (§20). Its models carry the provider:
 * `<providerId>/<model>`.
 */
export type AgentKind = 'claude' | 'codex' | 'api';

/** What drives a provider of the `api` agent (§20.2). */
export type ApiProviderKind = 'anthropic' | 'openai' | 'openrouter' | 'openai-compatible';

/**
 * One provider of the `api` agent as the engine reports it (§20.3): a
 * built-in (Anthropic, OpenAI, OpenRouter) or a custom OpenAI-compatible
 * server. The page learns whether it has a key and where from, never the key.
 */
export type ApiProviderStatus = {
  id: string;
  kind: ApiProviderKind;
  label: string;
  builtIn: boolean;
  /** Custom entries. */
  baseURL?: string;
  hasKey: boolean;
  /** `env`: the key comes from the environment, and no field is offered. */
  keySource: 'env' | 'stored' | null;
  /** The key's first characters and "…" (`sk-or-v1-a…`); absent without a key. */
  keyPreview?: string;
  /** Built-ins: the variable that wins over a stored key. */
  envVar?: string;
  ready: boolean;
  /** Whether images are sent. */
  images: boolean;
  contextWindow?: number;
  /** Why it is not ready ("No API key."). */
  problem?: string;
};

/** The `api` agent's built-in providers, always present, in the order the pickers list them. */
export const BUILT_IN_PROVIDERS: readonly string[] = ['anthropic', 'openai', 'openrouter'];

/** The provider of an `api` model id (`anthropic/claude-…` → `anthropic`): the part before the first `/`. */
export function providerOf(modelId: string | null | undefined): string | null {
  const slash = modelId ? modelId.indexOf('/') : -1;
  return slash > 0 ? modelId!.slice(0, slash) : null;
}

/** An `api` model id without its provider (`openrouter/anthropic/claude-…` → `anthropic/claude-…`). */
export function modelPart(modelId: string): string {
  const slash = modelId.indexOf('/');
  return slash > 0 ? modelId.slice(slash + 1) : modelId;
}

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

/** The image types a message's attachments may be. */
export const ATTACHMENT_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export type AttachmentMediaType = (typeof ATTACHMENT_MEDIA_TYPES)[number];

/** An image the user attached to a message (pasted, dropped or picked from disk); `name` is its file name. */
export type MessageAttachment = { mediaType: AttachmentMediaType; base64: string; name?: string };

/** Body of `POST api/agent/sessions/:id/messages`. */
export type SendMessage = {
  /** May be empty when the message has `attachments`. */
  text: string;
  /** The user's images, in the order they attached them. */
  attachments?: MessageAttachment[];
  references?: SceneReference[];
  /** The references capture. */
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
  /**
   * The agent asked the user something and waits: a question (`ask_user`)
   * or a choice between variants (`propose_variants`, once both are built).
   * `questionIds` are the ids of those cards. An approval waiting at the
   * same time wins.
   */
  | { state: 'awaiting-answer'; turnId: string; questionIds: string[] }
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

/**
 * One choice of a question. `svg` is a drawing of it, written by the model:
 * untrusted markup, shown only as an image (an `<img>` runs no script and
 * loads nothing), never put into the page's own DOM.
 */
export type QuestionOption = { label: string; description?: string; svg?: string };

/**
 * One question of an `ask_user` call. Without `options` the user answers in
 * their own words. `svg` is a figure the question refers to, untrusted as an
 * option's is.
 */
export type QuestionItem = { question: string; svg?: string; options?: QuestionOption[]; multiSelect?: boolean };

/**
 * The user's answer to one question: the labels they picked and what they
 * wrote. Neither (`selected` empty, no `text`) means they left it open.
 */
export type QuestionAnswer = { selected: string[]; text?: string };

/**
 * `unanswered`: it ended with nobody answering (the turn was stopped, the
 * wait timed out, the app closed); `reason` says which.
 */
export type QuestionPartState = 'awaiting-answer' | 'answered' | 'skipped' | 'unanswered';

/**
 * What the agent asked through `ask_user`, as one card. `id` is also what
 * the answer is posted to. `answers` is set once the user answered: one per
 * question, in order.
 */
export type QuestionPart = {
  type: 'question';
  id: string;
  state: QuestionPartState;
  questions: QuestionItem[];
  answers?: QuestionAnswer[];
  reason?: string;
};

/** Body of `POST api/agent/sessions/:id/questions/:questionId`: the answers, one per question in order, or a skip. */
export type QuestionReply = { answers: QuestionAnswer[] } | { skip: true };

/** The longest answer the user may write to one question. */
export const MAX_ANSWER_CHARS = 2000;

/** What a built variant produces: the numbers its tile shows. */
export type VariantFacts = {
  /** How many solids it renders; in an assembly, counted once per instance showing them. */
  solidCount: number;
  /** Its overall extents along x, y and z, in `unit`; null when it renders no solid. */
  size: [number, number, number] | null;
  /** The solids' total volume, in `unit` cubed; null when it could not be measured. */
  volume: number | null;
  unit: string;
  /** Assemblies: how many instances it places. */
  instanceCount?: number;
  /** False when the engine's soundness check found a problem in a solid; absent when it did not run. */
  sound?: boolean;
};

/**
 * `queued`: its build has not started; `building`: the engine is building
 * it; `ready`: built, and it can be picked; `failed`: it does not compile,
 * a feature of it does not build, or the engine refused it (`error` says
 * which) — it cannot be picked; `cancelled`: the card ended before its
 * build started or finished.
 */
export type VariantTileState = 'queued' | 'building' | 'ready' | 'failed' | 'cancelled';

/**
 * One variant of a `propose_variants` call, as its tile. `label` and
 * `description` are the model's words: text, never markup.
 */
export type VariantTile = {
  label: string;
  description?: string;
  state: VariantTileState;
  /**
   * The scratch build of it (`GET api/scratch-build/:id/meshes`): what the
   * page draws the tile's picture and the viewport ghost from. The engine
   * keeps a build's meshes for a while only, and not across a restart.
   */
  buildId?: string;
  sceneKind?: 'part' | 'assembly';
  facts?: VariantFacts;
  /**
   * The picture a page drew of the build, a PNG under the session's
   * `files/`: what the tile shows from then on, in every tab, after a
   * reload and after the engine has let the build go.
   */
  image?: string;
  /** `failed`: why. */
  error?: string;
};

/**
 * `building`: the engine builds the variants, one after the other;
 * `awaiting-choice`: built, waiting for the user; `picked`: the user picked
 * `picked`, and its write follows as a tool part of its own; `answered`:
 * they wrote `text` instead; `skipped`; `unanswered`: it ended with nobody
 * choosing (stopped, timed out, the app closed), `reason` says which;
 * `failed`: there was nothing to choose from or the pick could not be
 * applied (neither variant built, the file changed meanwhile), `reason`
 * says which.
 */
export type VariantsPartState = 'building' | 'awaiting-choice' | 'picked' | 'answered' | 'skipped' | 'unanswered' | 'failed';

/**
 * What the agent proposed through `propose_variants`, as one card of tiles.
 * `id` is also what the choice and the tiles' pictures are posted to.
 */
export type VariantsPart = {
  type: 'variants';
  id: string;
  state: VariantsPartState;
  /** The model file the variants are versions of, workspace-relative. */
  file: string;
  question?: string;
  variants: VariantTile[];
  /** `picked`: the label of the variant the user picked. */
  picked?: string;
  /** `answered`: what the user wrote instead of picking. */
  text?: string;
  reason?: string;
};

/** Body of `POST api/agent/sessions/:id/variants/:variantsId`: the pick (a tile's label), the user's own words, or a skip. */
export type VariantsReply = { pick: string } | { text: string } | { skip: true };

/** Body of `POST api/agent/sessions/:id/variants/:variantsId/pictures`: the picture a page drew of the tile `label`. */
export type VariantPicture = { label: string; image: { mediaType: 'image/png'; base64: string } };

export type TextPart = { type: 'text'; id: string; text: string };
export type ReasoningPart = { type: 'reasoning'; id: string; text: string };
/** `name`: set for an image the user attached (its file name); absent: the references capture. */
export type ImagePart = { type: 'image'; id: string; file: string; name?: string };
export type ReferencesPart = { type: 'references'; id: string; references: SceneReference[] };
/**
 * `resetsAt` (ISO): when a plan limit resets, worded in local time by the
 * page. Notices stored before it existed carry the instant in `text`.
 */
export type NoticePart = { type: 'notice'; id: string; level: 'info' | 'warning' | 'error'; text: string; resetsAt?: string };

/** What a turn cost, as the CLI reported it at its end. */
export type TurnUsage = { inputTokens?: number; outputTokens?: number; costUsd?: number };

export type ChatPart = TextPart | ReasoningPart | ImagePart | ReferencesPart | ToolPart | QuestionPart | VariantsPart | NoticePart;

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
  /** The model the chat last ran with; for the `api` agent `<providerId>/<model>`. */
  model?: string | null;
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

/**
 * What detection found for one agent (`GET api/agent/agents`). The `api`
 * agent has no program: no path or version, `minVersion` empty, signed in
 * when a provider is ready — read it by its `kind`.
 */
export type AgentInstall = {
  kind: AgentKind;
  path: string | null;
  version: string | null;
  /** The oldest version the driver supports; empty when FluidCAD has no driver for it (or no program: `api`). */
  minVersion: string;
  /** Found and at least `minVersion`. */
  supported: boolean;
  /** null: could not tell. */
  loggedIn: boolean | null;
  /** Claude Code: `claude.ai` (subscription), `api_key`, `none`; only `claude.ai` counts as signed in. */
  authMethod?: string | null;
  /** The email of the account the CLI is signed in with (Claude subscription, ChatGPT); absent on an API key or when unknown. */
  account?: string;
  /** What to tell the user when it is not ready. */
  problem?: string;
  /** `api`: every provider, ready or not. */
  providers?: ApiProviderStatus[];
};

export type AgentModel = {
  /** What goes to the CLI; `default` means no model flag. `api`: `<providerId>/<model>`. */
  id: string;
  label?: string;
  /** Codex: the model Codex uses when none is chosen. `api`: the provider's suggested model. */
  isDefault?: boolean;
  /** Codex and `api`: the reasoning efforts the model accepts, and the one it uses by default. */
  efforts?: string[];
  defaultEffort?: string;
  /** `api`: the provider the model belongs to. */
  provider?: string;
  /** Codex and `api`: whether the model takes images (absent: it is not known, and they are sent). */
  acceptsImages?: boolean;
};

/** A sign-in from the app (`GET api/agent/agents/:kind/login/:id`); nothing about the account. */
export type LoginStatus = { state: 'pending' | 'done' | 'failed'; error?: string };

/** Whether a status means a turn is in flight. */
export function isBusy(status: SessionStatus): boolean {
  return (
    status.state === 'starting' ||
    status.state === 'running' ||
    status.state === 'awaiting-approval' ||
    status.state === 'awaiting-answer'
  );
}
