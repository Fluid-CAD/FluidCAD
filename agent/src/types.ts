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

/** The image types a message's attachments may be. */
export const ATTACHMENT_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export type AttachmentMediaType = (typeof ATTACHMENT_MEDIA_TYPES)[number];

/**
 * An image the user attached to a message: pasted, dropped or picked from
 * disk (a drawing, a photo, a screenshot). The page sizes it first
 * (`ui/src/ui/chat/image-attachments.ts`); `name` is its file name.
 */
export type MessageAttachment = { mediaType: AttachmentMediaType; base64: string; name?: string };

/** Body of `POST api/agent/sessions/:id/messages`. */
export type SendMessage = {
  /** May be empty when the message has `attachments`. */
  text: string;
  /** The user's images, in the order they attached them. */
  attachments?: MessageAttachment[];
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
  /** `fluidcad`: a FluidCAD MCP tool, reported by the gate. `agent`: the CLI's own tool (Read, Glob, Grep, web search). */
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
  /**
   * What the change does to the model, built without writing it: set for a
   * `write_file` or `edit_range` on a model file that waits for approval
   * (§25). Absent for every other call, and on an engine that cannot build
   * a candidate.
   */
  preview?: ChangePreview;
};

/** One reason a side of a change does not build: a compile error, or a feature that failed. `line` is 1-based. */
export type ChangePreviewProblem = { title: string; message: string; line?: number };

/**
 * One side of a change, built: the file as it is (`before`) or with the
 * change (`after`). `failed`: it does not compile, a feature of it does not
 * build, or the engine refused it — `problems` says which; a side with
 * failed features still has its build, of what did build.
 */
export type ChangePreviewSide = {
  state: 'built' | 'failed';
  /** The scratch build of it (`GET api/scratch-build/:id/meshes`), while the engine keeps it. */
  buildId?: string;
  sceneKind?: 'part' | 'assembly';
  facts?: VariantFacts;
  /** The exact bounds of what it renders: the two sides are drawn framed on the union of theirs. */
  bounds?: { min: [number, number, number]; max: [number, number, number] };
  /** The picture a page drew of the build, a PNG under the session's `files/`. */
  image?: string;
  /** `failed`: why, the first few. */
  problems?: ChangePreviewProblem[];
  /** How many more problems there are than `problems` lists. */
  moreProblems?: number;
};

/**
 * `offered`: not built, because the file's last build took `estimateMs` —
 * the card has a button that builds it; `building`: the engine builds the
 * sides it does not already keep, `before` then `after`, each set as it
 * ends; `ready`: both are known; `cancelled`: the approval was settled (a
 * decision, Stop, the end of the turn, a restart) before it was built.
 */
export type ChangePreviewState = 'offered' | 'building' | 'ready' | 'cancelled';

/** The before and after of a change waiting for approval (§25). */
export type ChangePreview = {
  state: ChangePreviewState;
  /** `offered`: how long the file's last build took, in ms. */
  estimateMs?: number;
  /** The file as it is now; null when the change creates it. */
  before?: ChangePreviewSide | null;
  /** The file with the change. */
  after?: ChangePreviewSide;
  /** `ready`: both sides draw the same meshes — the change moves no geometry. */
  same?: boolean;
};

/**
 * Body of `POST api/agent/sessions/:id/approvals/:approvalId/preview/pictures`:
 * the pictures a page drew of the two sides, from one camera.
 */
export type ChangePreviewPictures = {
  before?: { mediaType: 'image/png'; base64: string };
  after?: { mediaType: 'image/png'; base64: string };
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

/** The largest picture of a tile, decoded. */
export const MAX_VARIANT_PICTURE_BYTES = 2_000_000;

/** A value a parameter holds: what `param()` takes as its default. */
export type ParamCardValue = string | number | boolean | (string | number)[];

/**
 * One parameter of a parameter card: which parameter, and no more. Its
 * control, range and value are the model's on screen, read when the card is
 * drawn, so a card never shows a value the file has moved on from. `label`
 * and `part` are the model file's words: text, never markup.
 */
export type ParamCardItem = {
  label: string;
  /** The `part()` or `assembly()` that declares it, by name (the definition's `body`). */
  part?: string;
};

/**
 * A value the user kept from a card: written into the source as the
 * parameter's default, or as the cell of `configuration` when a row of the
 * file's `configurations()` table was on screen.
 */
export type ParamKeptValue = { label: string; part?: string; value: ParamCardValue; configuration?: string };

/**
 * What the agent offered through `offer_params`, as one card of live
 * controls (§26). It has no state of its own: a control sets a session
 * override in the engine, which every page reads back from the render, so
 * the card is a view of the model on screen and stays usable after its turn.
 * `id` is also what the kept values are posted to.
 */
export type ParamsPart = {
  type: 'params';
  id: string;
  /** The model file the parameters belong to, workspace-relative. */
  file: string;
  /** The same file as the engine names the model on screen (absolute): what a page compares with the file it shows. */
  absPath: string;
  /** One line from the agent: text, never markup. */
  note?: string;
  params: ParamCardItem[];
  /** What Keep last wrote, one entry per parameter kept so far. */
  kept?: ParamKeptValue[];
};

/** Body of `POST api/agent/sessions/:id/params/:paramsId`: the values the page wrote into the source on Keep. */
export type ParamsKept = { kept: ParamKeptValue[] };

/**
 * A kept value the agent has not been told about yet: the next user message
 * carries it in `<param_changes>`. `file` is where it was written,
 * workspace-relative.
 */
export type ParamChange = ParamKeptValue & { file: string };

export type ChatPart =
  | { type: 'text'; id: string; text: string }
  | { type: 'reasoning'; id: string; text: string }
  /**
   * `file` is a name under the session's `files/`. `name`: set for an image
   * the user attached (its file name, `image` when it had none); absent: the
   * references capture.
   */
  | { type: 'image'; id: string; file: string; name?: string }
  | { type: 'references'; id: string; references: SceneReference[] }
  | ToolPart
  | QuestionPart
  | VariantsPart
  | ParamsPart
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
