import type { LeftSlot } from '../left-slot';
import { showPopupMenu, type PopupMenuItem, type PopupMenuOptions } from '../popup-menu';
import { AGENT_INFO, agentChipLabel, authDescription, providerLabel, renderAgentSetup, renderWelcome, type AgentSetupDeps } from './agent-setup';
import type { ChatClient } from './chat-client';
import { ChatComposer } from './chat-composer';
import type { MentionFile } from './file-mentions';
import { ChatIcons } from './chat-icons';
import { ChatSessionsMenu } from './chat-sessions-menu';
import { PERMISSION_MODES } from './permission-modes';
import { ChatState, type AgentReadiness, type ChatChange, type ChatTimers, type RevertOutcome } from './chat-state';
import { ChatTranscript } from './chat-transcript';
import {
  CLAUDE_EFFORTS,
  COMMON_EFFORTS,
  effortLabel,
  isBusy,
  modelPart,
  providerOf,
  type AgentKind,
  type AgentModel,
  type ApiProviderStatus,
  type ApprovalDecision,
  type Effort,
  type PermissionMode,
  type SessionStatus,
  type TurnRecord,
} from './chat-types';
import type { Colorizer } from './code-block';
import { ImageAttachments, type ImagePreparer } from './image-attachments';
import { SceneReferences, blobToBase64, type ChatSceneHost } from './scene-references';
import { resetsText } from './time-format';
import { usageText } from './usage';
import './chat-panel.css';

/** The agent preferences the panel follows (`agent` in the preferences file; Settings → Agent and the chips set them). */
export type ChatPanelSettings = {
  defaultAgent: AgentKind | null;
  /** Each agent's model for new chats (the last picked on the model chip); absent: the CLI's default. */
  claudeModel?: string;
  codexModel?: string;
  /** The `api` agent's last model, with its provider (`anthropic/claude-…`): new `api` chats start on that provider. */
  apiModel?: string;
  /** Each agent's effort for new chats (the last picked on the effort chip); absent: the CLI's default. */
  claudeEffort?: Effort;
  codexEffort?: Effort;
  apiEffort?: Effort;
  /** The older shared effort, read when the agent's own is absent. */
  effort?: Effort;
  permissionMode: PermissionMode;
};

/** The effort picker's row for "no effort flag": the agent's (or model's) own default. */
const DEFAULT_EFFORT = '';
/** More models than this, and the model chip's menu gets a search field and scrolls. */
const MODEL_SEARCH_AT = 12;

/** A confirm in the page's own dialog chrome (main.ts's `confirmDialog`). */
export type ChatConfirmOptions = {
  title: string;
  message: string;
  /** A short list under the message (the files a revert puts back). */
  items?: string[];
  confirmLabel: string;
  danger?: boolean;
  /** What is asked about, for the dialog's icon (absent: a revert). */
  kind?: 'revert' | 'delete';
};

/** The permission modes as the panel names them (§12.1); Settings → Agent uses the same words. */
export { PERMISSION_MODES } from './permission-modes';

export type ChatPanelDeps = {
  /** `#fluidcad-viewer`, the positioning context every overlay shares. */
  container: HTMLElement;
  client: ChatClient;
  /** The left slot it shares with the code editor and the Hub: opening the panel closes whichever holds it. */
  slot: LeftSlot;
  /** The agent settings as applied. */
  settings(): ChatPanelSettings;
  /** Open a web page in the user's browser, through the host (ExternalLinks). */
  openExternal(url: string): void;
  /** Settings → Agent; absent where the page has no Settings. */
  openSettings?(): void;
  /** Show a source location in the editor (a render error's line). */
  openSource?(filePath: string, line: number, column: number): void;
  /** Colours closed code blocks like the editor (Monaco's colorize), once the editor is loaded. */
  colorizer?(): Colorizer | null;
  /** The user picked the agent for new chats: remember it (§9.1, "the last one used"). */
  onAgentChosen?(kind: AgentKind): void;
  /** The user switched the permission mode from its chip: remember it (`agent.permissionMode`, as Settings → Agent). */
  onPermissionModeChosen?(mode: PermissionMode): void;
  /** The user picked a model on its chip (`default`: the CLI's own): remember it as the agent's default for new chats. */
  onModelChosen?(kind: AgentKind, model: string): void;
  /** The user picked an effort on its chip (`''`: the CLI's own): remember it as the agent's default for new chats. */
  onEffortChosen?(kind: AgentKind, effort: string): void;
  /** Ask the user to confirm (Revert this turn), in the page's dialog; absent: the browser's confirm. */
  confirm?(options: ChatConfirmOptions): Promise<boolean>;
  onOpenChange?(open: boolean): void;
  /**
   * The scene, for attaching the selected geometry to a message (§11): the
   * idle selection, renders, the capture. Absent: no references.
   */
  scene?: ChatSceneHost;
  /** The project's files, for naming one in a message with `@`; absent: no file mentions. */
  listFiles?(): Promise<MentionFile[]>;
  /** Makes an attached image ready to send (tests); absent: the browser's decoder and a canvas. */
  prepareImage?: ImagePreparer;
  /** Timers for reattaching after a refused stream (tests). */
  timers?: ChatTimers;
};

const MIN_WIDTH = 300;
/** The model picker's row that asks for a model by name. */
const OTHER_MODEL = '__other__';

/** One row of the agent picker: Claude Code, Codex, or one provider of the `api` agent. */
type AgentEntry = { kind: AgentKind; provider: ApiProviderStatus | null; label: string };

/**
 * The Agent panel (docs/agent-chat-plan.md §10): a chat with the user's own
 * Claude Code (or Codex), which reads the project through FluidCAD's MCP
 * tools, docked on the left from the rail's Agent button. The `api` agent
 * (§20) runs FluidCAD's own agent loop on a provider the user has a key for,
 * or a local server: each ready provider is an entry of the agent picker,
 * and an `api` chat stays on its provider.
 *
 * **One slot** with the code editor and the Hub ({@link LeftSlot}): opening
 * it closes whichever holds the slot, at the shared width; below 640 px it
 * covers the scene.
 *
 * The header holds the chats menu (the title: switching, renaming and
 * deleting chats, {@link ChatSessionsMenu}), New chat and Close. Under it
 * the transcript ({@link ChatTranscript}) and the composer
 * ({@link ChatComposer}), whose chips under the text pick the agent, the
 * model, the effort and the permission mode (Ask before edits / Apply edits
 * automatically, the `agent.permissionMode` preference), and say how the
 * agent is paid for (subscription or API key). Images go with a message
 * too ({@link ImageAttachments}): picked with the composer's Attach button,
 * pasted into the message box, or dropped anywhere on the panel. The session's status drives what shows: Stop while
 * a turn runs, the approval cards while it waits, Continue after the engine
 * restarted mid-turn, the errors. Under each user message, Revert this turn
 * while the turn has changes to put back (§12.2). Until the agent can run,
 * the panel says what is missing instead (§9.1, {@link renderAgentSetup}).
 */
export class ChatPanel {
  readonly el: HTMLElement;
  readonly state: ChatState;
  readonly transcript: ChatTranscript;
  readonly composer: ChatComposer;
  /** The selected geometry attached to the next message (§11.1); null without a scene. */
  readonly references: SceneReferences | null;
  /** The images attached to the next message. */
  readonly images: ImageAttachments;
  private readonly sessionButton: HTMLButtonElement;
  private readonly sessionTitle: HTMLSpanElement;
  private readonly agentSlot: HTMLSpanElement;
  private readonly modelSlot: HTMLSpanElement;
  private readonly modeButton: HTMLButtonElement;
  private readonly center: HTMLDivElement;
  private readonly statusBar: HTMLDivElement;
  private readonly footerSetup: HTMLDivElement;
  private readonly sessionsMenu: ChatSessionsMenu;
  private readonly leaveSlot: () => void;
  private readonly unsubscribe: () => void;
  private open = false;
  private started = false;
  /** The composer shows and takes messages (the agent is ready, or a turn runs). */
  private composerUsable = false;
  /**
   * The model picked in the panel, per agent (per provider for `api`:
   * `api:<providerId>`); holds over the chat's own until the page reloads
   * (and is remembered for new chats).
   */
  private readonly modelChoices = new Map<string, string>();
  /** The provider a new `api` chat starts on, picked on the agent chip; null: the last used, else the first ready. */
  private draftProvider: string | null = null;
  /** The effort picked in the panel, per agent (`DEFAULT_EFFORT`: the default); holds until the page reloads (and is remembered for new chats). */
  private readonly effortChoices = new Map<AgentKind, string>();
  private readonly effortSlot: HTMLSpanElement;
  /** The model picker shows a text field for a model by name. */
  private typingModel = false;
  /** The text "Other model…" starts with: what the search found nothing for. */
  private typedModelSeed: string | null = null;
  /** The mode switched from its chip, until Settings → Agent is saved again. */
  private modeChoice: PermissionMode | null = null;

  constructor(private readonly deps: ChatPanelDeps) {
    this.leaveSlot = deps.slot.register(this);
    this.state = new ChatState(deps.client, deps.timers);
    this.state.draftAgent = deps.settings().defaultAgent ?? 'claude';

    this.el = document.createElement('aside');
    this.el.dataset.role = 'chat-panel';
    this.el.setAttribute('aria-label', 'Agent');
    this.el.className =
      'absolute left-[var(--fluidcad-rail-width,0px)] top-[var(--fluidcad-chrome-top,104px)] bottom-0 z-[115] '
      + 'flex flex-col bg-base-100 text-base-content border-r border-base-content/10 text-hub-md hidden';

    // Header: the session menu, New chat, Close.
    const header = document.createElement('div');
    header.className = 'flex items-center gap-1 h-11 shrink-0 pl-1.5 pr-1.5 border-b border-base-content/10';
    this.sessionButton = document.createElement('button');
    this.sessionButton.type = 'button';
    this.sessionButton.dataset.ref = 'sessions';
    this.sessionButton.className = 'btn btn-ghost btn-sm min-w-0 flex-1 justify-start gap-1.5 px-1.5 font-medium text-base-content/90';
    this.sessionButton.title = 'Chats';
    this.sessionButton.setAttribute('aria-haspopup', 'menu');
    this.sessionTitle = document.createElement('span');
    this.sessionTitle.dataset.ref = 'title';
    this.sessionTitle.className = 'truncate';
    this.sessionButton.append(
      ChatIcons.span(ChatIcons.AGENT, '[&>svg]:size-4 text-base-content/60'),
      this.sessionTitle,
      ChatIcons.span(ChatIcons.CHEVRON_DOWN, '[&>svg]:size-3.5 text-base-content/50'),
    );
    this.sessionButton.addEventListener('click', () => void this.toggleSessionMenu());
    this.sessionsMenu = new ChatSessionsMenu({
      host: deps.container,
      sessions: () => this.state.sessions,
      current: () => this.state.session?.id ?? null,
      agentName: (session) =>
        session.agent === 'api'
          ? providerLabel(this.state.install('api'), providerOf(session.model))
          : (AGENT_INFO[session.agent]?.name ?? session.agent),
      onNewChat: () => this.newChat(),
      onOpen: (id) => void this.state.openSession(id),
      onRename: (id, title) => this.state.renameSession(id, title),
      onDelete: (id) => void this.deleteSession(id),
    });
    const newChat = iconButton(ChatIcons.NEW, 'New chat', 'new-chat');
    newChat.addEventListener('click', () => this.newChat());
    const close = iconButton(ChatIcons.CLOSE, 'Close the Agent panel', 'close');
    close.title = 'Close';
    close.addEventListener('click', () => this.close());
    header.append(this.sessionButton, newChat, close);

    // The chips under the message box: which agent, which model and effort,
    // the edit mode, how the agent is paid for.
    this.agentSlot = chipSlot('agent');
    this.modelSlot = chipSlot('model');
    this.effortSlot = chipSlot('effort');
    this.modeButton = chipButton('mode');
    this.modeButton.addEventListener('click', () => this.showModeMenu());

    // Body: the transcript, or the welcome / setup when there is nothing yet.
    const body = document.createElement('div');
    body.className = 'relative flex flex-col flex-1 min-h-0';
    this.center = document.createElement('div');
    this.center.className = 'chat-center hidden';
    this.center.dataset.ref = 'center';
    const partContext = {
      openLink: (url: string) => deps.openExternal(url),
      colorizer: () => deps.colorizer?.() ?? null,
      fileUrl: (name: string) => (this.state.session ? deps.client.fileUrl(this.state.session.id, name) : ''),
      ...(deps.openSource ? { openSource: deps.openSource } : {}),
      decideApproval: (approvalId: string, decision: ApprovalDecision) => this.state.decideApproval(approvalId, decision),
    };
    this.transcript = new ChatTranscript(partContext);
    body.append(this.center, this.transcript.el);

    // Footer: the status line, the setup when a chat's agent stopped being ready, the composer.
    this.statusBar = document.createElement('div');
    this.statusBar.dataset.ref = 'status';
    this.statusBar.className = 'chat-status hidden';
    this.footerSetup = document.createElement('div');
    this.footerSetup.className = 'shrink-0 border-t border-base-content/10 hidden';
    this.composer = new ChatComposer({
      onSubmit: (text) => this.send(text),
      onStop: () => void this.state.stop(),
      onAttach: (files) => this.images.add(files),
      ...(deps.listFiles ? { listFiles: deps.listFiles } : {}),
    });
    this.composer.controls.append(this.agentSlot, this.modelSlot, this.effortSlot, this.modeButton);
    this.references = deps.scene ? new SceneReferences(deps.scene, this.composer) : null;
    this.images = new ImageAttachments({
      ...(deps.prepareImage ? { prepare: deps.prepareImage } : {}),
      onChange: () => this.composer.setSendsWithoutText(this.images.size > 0),
    });
    this.composer.setAttachments(this.images.el, ...(this.references ? [this.references.el] : []));

    this.el.append(header, body, this.statusBar, this.footerSetup, this.composer.el, deps.slot.resizeHandle());
    // A file dragged over the panel is an image for the message, wherever it is let go.
    this.el.addEventListener('dragover', this.onDragOver);
    this.el.addEventListener('dragleave', this.onDragLeave);
    this.el.addEventListener('drop', this.onDrop);
    deps.container.appendChild(this.el);

    this.unsubscribe = this.state.subscribe((change) => this.onChange(change));
    window.addEventListener('resize', this.onResize);
    this.paintAll();
  }

  isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) {
      this.close();
    } else {
      this.show();
    }
  }

  /** Open the panel; the first open reads detection and the chats, and shows the latest. */
  show(): void {
    if (!this.open) {
      this.deps.slot.take(this, { el: this.el, minWidth: MIN_WIDTH });
      this.open = true;
      this.el.classList.remove('hidden');
      this.deps.onOpenChange?.(true);
      this.syncReferences();
    }
    if (!this.started) {
      this.started = true;
      void this.start();
    } else {
      void this.state.loadAgents();
    }
    this.composer.focus();
  }

  close(): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    this.el.classList.add('hidden');
    this.deps.slot.release(this);
    this.deps.onOpenChange?.(false);
    this.syncReferences();
  }

  /** Settings → Agent was saved: detection may answer differently (the API-key choice). */
  settingsChanged(): void {
    const settings = this.deps.settings();
    if (!this.state.session && settings.defaultAgent) {
      this.state.setDraftAgent(settings.defaultAgent);
    }
    // Settings → Agent now says which mode holds.
    this.modeChoice = null;
    if (this.started) {
      void this.state.loadAgents();
    }
    this.paintToolbar();
  }

  /** Start an empty chat (the session is created by its first message). */
  newChat(): void {
    this.state.newChat();
    this.composer.focus();
  }

  destroy(): void {
    this.sessionsMenu.close();
    window.removeEventListener('resize', this.onResize);
    this.unsubscribe();
    this.references?.destroy();
    this.images.destroy();
    this.state.dispose();
    this.transcript.destroy();
    this.leaveSlot();
    this.el.remove();
  }

  /**
   * The model a message goes with: the panel's pick, the session's, the last
   * one picked for new chats, else the CLI's own. For `api`, of the chat's
   * provider only, else that provider's suggested model: '' until its models
   * are read, or when it lists none.
   */
  get model(): string {
    const settings = this.deps.settings();
    if (this.state.agent === 'api') {
      return this.apiModel() ?? '';
    }
    const preferred = this.state.agent === 'codex' ? settings.codexModel : settings.claudeModel;
    const session = this.state.session;
    return this.modelChoices.get(this.state.agent) ?? session?.model ?? preferred ?? 'default';
  }

  /**
   * The provider of an `api` chat (null for Claude Code and Codex): the
   * session's, from its model; for a new chat the one picked on the agent
   * chip, else the last used, else the first ready.
   */
  get provider(): string | null {
    if (this.state.agent !== 'api') {
      return null;
    }
    const session = this.state.session;
    const own = providerOf(session?.model);
    if (own) {
      return own;
    }
    const ready = this.state.apiProviders;
    if (this.draftProvider && ready.some((p) => p.id === this.draftProvider)) {
      return this.draftProvider;
    }
    const last = providerOf(this.deps.settings().apiModel);
    const fallback = ready.find((p) => p.id === last)?.id ?? ready[0]?.id ?? null;
    // A chat that has not run yet keeps naming its provider, so its setup says which is missing.
    return fallback ?? (session ? this.draftProvider ?? last : null);
  }

  /** The `api` chat's model: picked, the session's, the last used on this provider, else the provider's suggested one. */
  private apiModel(): string | null {
    const provider = this.provider;
    if (!provider) {
      return null;
    }
    const candidates = [this.modelChoices.get(`api:${provider}`), this.state.session?.model, this.deps.settings().apiModel];
    const found = candidates.find((id) => id && providerOf(id) === provider);
    if (found) {
      return found;
    }
    const models = this.providerModels(provider);
    return (models.find((m) => m.isDefault) ?? models[0])?.id ?? null;
  }

  /**
   * Whether images reach the model a message goes with. Claude Code and
   * Codex are sent them as they are. The `api` agent leaves them out for a
   * model its provider lists as taking none, and for a model typed by name
   * on a server whose **Send images** is off: the strip then says so.
   */
  private modelTakesImages(): boolean {
    if (this.state.agent !== 'api') {
      return true;
    }
    const id = this.model;
    const listed = (this.state.models.get('api') ?? []).find((m) => m.id === id);
    if (listed) {
      return listed.acceptsImages !== false;
    }
    return this.state.apiProviders.find((p) => p.id === this.provider)?.images !== false;
  }

  /** The models of one `api` provider (`<providerId>/<model>`). */
  private providerModels(provider: string): AgentModel[] {
    return (this.state.models.get('api') ?? []).filter((m) => (m.provider ?? providerOf(m.id)) === provider);
  }

  /** Where the panel keeps a model picked on the chip: per agent, and per provider for `api`. */
  private modelKey(): string {
    return this.state.agent === 'api' ? `api:${this.provider}` : this.state.agent;
  }

  /**
   * The effort a message goes with (`DEFAULT_EFFORT`: none, the CLI's own):
   * the panel's pick, the session's, the last one picked for new chats — whichever is first and
   * is a level of the agent and model; else the default.
   */
  get effort(): string {
    const settings = this.deps.settings();
    const kind = this.state.agent;
    const levels = this.effortLevels();
    const preferred = kind === 'api'
      ? settings.apiEffort
      : (kind === 'codex' ? settings.codexEffort : settings.claudeEffort) ?? settings.effort;
    const candidates = [
      this.effortChoices.get(kind),
      this.state.session?.effort ?? undefined,
      preferred,
    ];
    for (const candidate of candidates) {
      if (candidate === DEFAULT_EFFORT) {
        return DEFAULT_EFFORT;
      }
      if (candidate !== undefined && levels.includes(candidate)) {
        return candidate;
      }
    }
    return DEFAULT_EFFORT;
  }

  /**
   * The levels the agent and model take: Claude Code's `--effort` choices;
   * for Codex, those the model lists (the default model's for "Default"),
   * else the three every model takes; for `api`, those the model lists, if
   * any (none: the model takes no effort).
   */
  effortLevels(): readonly string[] {
    const kind = this.state.agent;
    if (kind === 'claude') {
      return CLAUDE_EFFORTS;
    }
    const models = this.state.models.get(kind) ?? [];
    const id = this.model;
    if (kind === 'api') {
      return models.find((m) => m.id === id)?.efforts ?? [];
    }
    const model = id === 'default' ? models.find((m) => m.isDefault) : models.find((m) => m.id === id);
    return model?.efforts && model.efforts.length > 0 ? model.efforts : COMMON_EFFORTS;
  }

  /** The permission mode messages go with: its chip's pick, else Settings → Agent. */
  get mode(): PermissionMode {
    return this.modeChoice ?? this.deps.settings().permissionMode;
  }

  /** Switch the permission mode (its chip's menu); it holds for the next messages and is remembered. */
  setMode(mode: PermissionMode): void {
    this.modeChoice = mode;
    this.deps.onPermissionModeChosen?.(mode);
    this.paintMode();
  }

  // ---------------------------------------------------------------------------

  private async start(): Promise<void> {
    await Promise.all([this.state.loadAgents(), this.state.loadSessions()]);
    this.pickDraftAgent();
    void this.state.loadModels(this.state.agent);
    const latest = this.state.sessions[0];
    if (latest && !this.state.session) {
      await this.state.openSession(latest.id);
    }
  }

  /** A new chat starts with the default agent when it can run, else the first that can (the programs before the API agent, as the picker lists them). */
  private pickDraftAgent(): void {
    const all = this.state.offeredAgents;
    if (all.length === 0) {
      return;
    }
    const offered = [...all.filter((a) => a.kind !== 'api'), ...all.filter((a) => a.kind === 'api')];
    const preferred = this.deps.settings().defaultAgent;
    const ready = offered.filter((a) => ChatState.readinessOf(a).state === 'ready');
    const pick = offered.find((a) => a.kind === preferred && ChatState.readinessOf(a).state === 'ready')
      ?? ready[0]
      ?? offered.find((a) => a.kind === preferred)
      ?? offered[0];
    this.state.setDraftAgent(pick.kind);
  }

  private async send(text: string): Promise<boolean> {
    // The images as the strip shows them; one still being sized is waited for.
    const images = await this.images.forSend();
    if (text.trim() === '' && images.attachments.length === 0) {
      return false;
    }
    // The message carries what the chips show: a selection still resolving
    // is waited for. The references go with one capture of the model, each
    // in its colour (§11.2), taken while their picks still hold.
    await this.references?.settle();
    const attached = this.references?.forSend() ?? null;
    let image: { mediaType: 'image/png'; base64: string } | undefined;
    if (attached && this.deps.scene) {
      try {
        image = { mediaType: 'image/png', base64: await blobToBase64(await this.deps.scene.capture(attached.highlight)) };
      } catch (err) {
        console.warn('FluidCAD: the references capture failed:', err);
      }
      if (!this.references!.isCurrent(attached.generation)) {
        return false;
      }
    }
    if (this.state.agent === 'api') {
      // An `api` message names its model, with the provider: there is no program default.
      await this.state.loadModels('api');
      if (!this.model) {
        this.state.fail('Choose a model on the model chip first.');
        return false;
      }
    }
    this.transcript.scrollToBottom();
    const effort = this.effort;
    const sent = await this.state.send(text, {
      model: this.model,
      mode: this.mode,
      ...(effort !== DEFAULT_EFFORT ? { effort } : {}),
      ...(images.attachments.length > 0 ? { attachments: images.attachments } : {}),
      ...(attached ? { references: attached.references } : {}),
      ...(image ? { image } : {}),
    });
    if (sent) {
      this.images.clearSent(images.ids);
      if (attached) {
        this.references!.clearSent();
      }
    }
    return sent;
  }

  /** Whether a drag carries files (the only thing the panel takes). */
  private static carriesFiles(event: DragEvent): boolean {
    return [...(event.dataTransfer?.types ?? [])].includes('Files');
  }

  private readonly onDragOver = (event: DragEvent): void => {
    if (!ChatPanel.carriesFiles(event)) {
      return;
    }
    // Taken either way: left to the browser, a dropped file replaces the page.
    event.preventDefault();
    event.dataTransfer!.dropEffect = this.composerUsable ? 'copy' : 'none';
    this.el.toggleAttribute('data-dropping', this.composerUsable);
  };

  private readonly onDragLeave = (event: DragEvent): void => {
    if (!(event.relatedTarget instanceof Node) || !this.el.contains(event.relatedTarget)) {
      this.el.removeAttribute('data-dropping');
    }
  };

  private readonly onDrop = (event: DragEvent): void => {
    if (!ChatPanel.carriesFiles(event)) {
      return;
    }
    event.preventDefault();
    this.el.removeAttribute('data-dropping');
    if (this.composerUsable) {
      this.images.add([...(event.dataTransfer?.files ?? [])]);
      this.composer.focus();
    }
  };

  private onChange(change: ChatChange): void {
    switch (change.kind) {
      case 'session':
        this.renderSession();
        return;
      case 'event': {
        const session = this.state.session;
        if (!session) {
          return;
        }
        this.transcript.apply(change.event, session.messages);
        if (change.event.type === 'status') {
          if (!isBusy(change.event.status)) {
            this.transcript.settleAll();
          }
          this.paintStatus();
          this.paintBody();
          this.paintTurns();
        } else if (change.event.type === 'title') {
          this.paintTitle();
        } else if (change.event.type === 'message-start') {
          this.paintBody();
          this.paintTurns();
        } else if (change.event.type === 'checkpoint' || change.event.type === 'reverted' || change.event.type === 'usage') {
          this.paintTurns();
        }
        return;
      }
      case 'revert':
        this.paintTurns();
        this.paintStatus();
        return;
      case 'agents':
        this.agentsChanged();
        this.paintToolbar();
        this.paintBody();
        this.paintStatus();
        this.paintTurns();
        return;
      case 'sessions':
        this.paintTitle();
        this.sessionsMenu.refresh();
        return;
      case 'activity':
        this.paintStatus();
        return;
    }
  }

  /**
   * Detection answered again: a new chat whose agent cannot run moves to one
   * that can (a key was just added), and an `api` chat reads its models
   * (again, once a provider changed).
   */
  private agentsChanged(): void {
    if (this.started && !this.state.session) {
      const install = this.state.install(this.state.draftAgent);
      if (!install || ChatState.readinessOf(install).state !== 'ready') {
        this.pickDraftAgent();
      }
    }
    if (this.state.agent === 'api' && this.state.readiness('api').state === 'ready') {
      void this.state.loadModels('api');
    }
  }

  private renderSession(): void {
    const session = this.state.session;
    const messages = session?.messages ?? [];
    const last = messages[messages.length - 1];
    const live = session && isBusy(session.status) && last?.role === 'assistant' ? last.id : null;
    this.transcript.render(messages, live);
    void this.state.loadModels(this.state.agent);
    this.paintAll();
  }

  private paintAll(): void {
    this.paintTitle();
    this.paintToolbar();
    this.paintBody();
    this.paintStatus();
    this.paintTurns();
  }

  private paintTitle(): void {
    this.sessionTitle.textContent = this.state.session?.title ?? 'New chat';
  }

  /**
   * The chips under the message box: the agent (a picker when a new chat can
   * take more than one that is ready, its name in a chat when there is a
   * choice at all, else nothing: one agent needs no saying), the model, the
   * effort, the edit mode, how it is paid for.
   */
  private paintToolbar(): void {
    const kind = this.state.agent;
    const provider = this.provider;
    this.agentSlot.replaceChildren();
    const entries = this.agentEntries();
    const install = this.state.install(kind);
    const text = agentChipLabel(install, kind, provider);
    const auth = authDescription(install);
    const isCurrent = (entry: AgentEntry) => entry.kind === kind && (kind !== 'api' || entry.provider?.id === provider);
    let chip: HTMLElement | null = null;
    const openSettings = this.deps.openSettings;
    // A new chat picks its agent here; Manage (keys, local models, what is installed) is in the same menu.
    if (!this.state.session && (entries.length > 1 || (entries.length === 1 && openSettings))) {
      const picker = chipButton('agent-picker');
      fillChip(picker, text);
      picker.setAttribute('aria-label', `Agent: ${text}`);
      picker.addEventListener('click', () => {
        const items: PopupMenuItem[] = entries.map((entry) => ({
          icon: isCurrent(entry) ? ChatIcons.CHECK : '',
          label: entry.label,
          className: isCurrent(entry) ? 'font-medium' : undefined,
          onSelect: () => this.chooseAgent(entry),
        }));
        if (openSettings) {
          items.push({ icon: ChatIcons.SETTINGS, label: 'Manage', separated: true, onSelect: () => openSettings() });
        }
        this.showChipMenu(picker, 'agent-menu', items);
      });
      chip = picker;
    } else if (entries.length > 1 || auth || kind === 'api') {
      // One agent needs no picker, but how Claude is paid for, or which
      // provider an `api` chat runs on, is still worth showing.
      const name = document.createElement('span');
      name.dataset.ref = 'agent-name';
      name.className = 'chat-chip';
      name.append(chipLabel(text));
      chip = name;
    }
    if (chip) {
      if (auth?.apiKey) {
        chip.dataset.tone = 'warning';
      }
      const runs = `This chat runs on ${kind === 'api' ? text : AGENT_INFO[kind].name}.`;
      chip.title = auth ? `${auth.long}${auth.hint ? ` ${auth.hint.text}` : ''}` : runs;
      this.agentSlot.append(chip);
    }
    this.paintModelPicker();
    this.paintMode();
  }

  /**
   * What a new chat can start with (§20.1): each ready CLI, then each ready
   * provider of the `api` agent as its own entry ("Anthropic API",
   * "OpenAI API", "OpenRouter", then the local servers by their name).
   */
  private agentEntries(): AgentEntry[] {
    const ready = this.state.offeredAgents.filter((a) => ChatState.readinessOf(a).state === 'ready');
    const entries: AgentEntry[] = ready
      .filter((a) => a.kind !== 'api')
      .map((a) => ({ kind: a.kind, provider: null, label: agentChipLabel(a, a.kind) }));
    if (ready.some((a) => a.kind === 'api')) {
      for (const provider of this.state.apiProviders) {
        entries.push({ kind: 'api', provider, label: provider.label });
      }
    }
    return entries;
  }

  /** A new chat starts with `entry`; for a provider, on its last-used (else suggested) model, which new chats then keep. */
  private chooseAgent(entry: AgentEntry): void {
    if (entry.provider) {
      this.draftProvider = entry.provider.id;
    }
    this.state.setDraftAgent(entry.kind);
    this.deps.onAgentChosen?.(entry.kind);
    if (entry.kind === 'api') {
      void this.state.loadModels('api').then(() => {
        const model = this.state.agent === 'api' && !this.state.session ? this.apiModel() : null;
        if (model) {
          // The provider is part of the model: remembering it is what starts the next chat there too.
          this.chooseModel(model);
        }
        this.paintToolbar();
      });
    } else {
      void this.state.loadModels(entry.kind);
    }
    this.paintToolbar();
    this.paintBody();
  }

  /** The model chip: Default, the agent's models, and any model by name ("Other model…" types it in place). */
  private paintModelPicker(): void {
    this.modelSlot.replaceChildren();
    const current = this.model;
    this.images.setModelTakesImages(this.modelTakesImages());
    if (this.typingModel) {
      const input = document.createElement('input');
      input.type = 'text';
      input.dataset.ref = 'model-input';
      input.className = 'chat-chip-input';
      input.placeholder = 'Model name';
      input.setAttribute('aria-label', 'Model name');
      const api = this.state.agent === 'api';
      const provider = api ? this.provider : null;
      // An `api` model is typed without its provider: the chat already has one.
      input.value = this.typedModelSeed ?? (current === 'default' ? '' : api ? modelPart(current) : current);
      this.typedModelSeed = null;
      input.spellcheck = false;
      const commit = (save: boolean) => {
        const value = input.value.trim();
        this.typingModel = false;
        if (save && /^[A-Za-z0-9][\w.:@/[\]-]*$/.test(value) && (!api || provider)) {
          this.chooseModel(api ? `${provider}/${value}` : value);
        }
        this.paintModelPicker();
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          commit(false);
        }
      });
      input.addEventListener('blur', () => {
        if (this.typingModel) {
          commit(true);
        }
      });
      this.modelSlot.append(input);
      queueMicrotask(() => input.focus());
      return;
    }
    const api = this.state.agent === 'api';
    const provider = this.provider;
    // An `api` chat offers its provider's models only, named without the provider.
    const models: AgentModel[] = api
      ? (provider ? this.providerModels(provider) : [])
      : this.state.models.get(this.state.agent) ?? [{ id: 'default', label: 'Default' }];
    const name = (model: AgentModel) => model.label ?? (api ? modelPart(model.id) : model.id);
    const options = [...models];
    if (current !== '' && !options.some((m) => m.id === current)) {
      options.push({ id: current });
    }
    const shown = options.find((m) => m.id === current);
    const label = shown ? name(shown) : 'Model';
    const chip = chipButton('model-picker');
    chip.dataset.value = current;
    fillChip(chip, label);
    chip.title = current === 'default'
      ? `Model: ${AGENT_INFO[this.state.agent].name}'s own default`
      : current === '' ? 'Model: choose one' : `Model: ${api ? modelPart(current) : current}`;
    chip.setAttribute('aria-label', `Model: ${label}`);
    chip.addEventListener('click', () => {
      // A long list (OpenRouter has hundreds) gets a search field and scrolls.
      const searchable = options.length > MODEL_SEARCH_AT;
      let menu: HTMLElement | null = null;
      menu = this.showChipMenu(chip, 'model-menu', [
        ...options.map((model): PopupMenuItem => ({
          icon: model.id === current ? ChatIcons.CHECK : '',
          label: name(model),
          keywords: model.id,
          selected: model.id === current,
          className: model.id === current ? 'font-medium' : undefined,
          onSelect: () => {
            this.chooseModel(model.id);
            this.paintModelPicker();
          },
        })),
        {
          icon: '',
          label: 'Other model…',
          separated: true,
          pinned: true,
          title: 'Any model name the program accepts',
          onSelect: () => {
            // What was searched for, and not found, is where typing starts.
            const searched = menu?.querySelector<HTMLInputElement>('[data-ref="menu-search"]')?.value.trim() ?? '';
            this.typingModel = true;
            this.typedModelSeed = searched || null;
            this.paintModelPicker();
          },
        },
      ], searchable ? { search: { placeholder: 'Search models', empty: 'No model matches' } } : {});
    });
    this.modelSlot.append(chip);
    // Codex's levels depend on the model.
    this.paintEffortPicker();
  }

  /** A model picked on the chip: it goes with the next messages, and new chats of this agent start with it. */
  private chooseModel(model: string): void {
    this.modelChoices.set(this.modelKey(), model);
    this.deps.onModelChosen?.(this.state.agent, model);
  }

  /** The effort chip: the default, then the levels of the agent and model (none for an `api` model that takes no effort). */
  private paintEffortPicker(): void {
    this.effortSlot.replaceChildren();
    if (this.state.agent === 'api' && this.effortLevels().length === 0) {
      return;
    }
    const current = this.effort;
    const label = (value: string) => (value === DEFAULT_EFFORT ? 'Default effort' : `${effortLabel(value)} effort`);
    const chip = chipButton('effort-picker');
    chip.dataset.value = current;
    // The default needs no "Default": the chip just says what it sets.
    fillChip(chip, current === DEFAULT_EFFORT ? 'Effort' : label(current));
    const owner = this.state.agent === 'api' ? 'the model' : AGENT_INFO[this.state.agent].name;
    chip.title = `Effort: how hard the model thinks before it answers${current === DEFAULT_EFFORT ? ` (${owner}'s own default)` : ''}.`;
    chip.setAttribute('aria-label', `Effort: ${label(current)}`);
    chip.addEventListener('click', () => this.showChipMenu(chip, 'effort-menu',
      [DEFAULT_EFFORT, ...this.effortLevels()].map((value) => ({
        icon: value === current ? ChatIcons.CHECK : '',
        // The menu is already about effort: "Default", "Low", "High"…
        label: value === DEFAULT_EFFORT ? 'Default' : effortLabel(value),
        className: value === current ? 'font-medium' : undefined,
        onSelect: () => {
          this.effortChoices.set(this.state.agent, value);
          this.deps.onEffortChosen?.(this.state.agent, value);
          this.paintEffortPicker();
        },
      }))));
    this.effortSlot.append(chip);
  }

  /** The permission-mode chip: the mode's icon and short name; the full name as its tooltip. */
  private paintMode(): void {
    const current = PERMISSION_MODES.find((m) => m.mode === this.mode) ?? PERMISSION_MODES[0];
    this.modeButton.dataset.mode = current.mode;
    this.modeButton.title = `${current.label}. ${current.description}`;
    this.modeButton.setAttribute('aria-label', `Permission mode: ${current.label}`);
    fillChip(this.modeButton, current.short, {
      svg: current.mode === 'ask' ? ChatIcons.ASK : ChatIcons.AUTO,
      className: current.mode === 'ask' ? '' : 'text-warning',
    });
  }

  private showModeMenu(): void {
    const current = this.mode;
    this.showChipMenu(this.modeButton, 'mode-menu', PERMISSION_MODES.map((m) => ({
      icon: m.mode === current ? ChatIcons.CHECK : m.mode === 'ask' ? ChatIcons.ASK : ChatIcons.AUTO,
      label: m.label,
      title: m.description,
      className: m.mode === current ? 'font-medium' : undefined,
      onSelect: () => this.setMode(m.mode),
    })));
  }

  /** A chip's menu, opening upwards from it (the chips sit at the panel's bottom). */
  private showChipMenu(chip: HTMLElement, ref: string, items: PopupMenuItem[], options: Pick<PopupMenuOptions, 'search'> = {}): HTMLElement {
    const rect = chip.getBoundingClientRect();
    const menu = showPopupMenu(this.deps.container, { clientX: rect.left, clientY: rect.top - 4 }, items, { focusFirst: true, placement: 'above', ...options });
    menu.dataset.ref = ref;
    return menu;
  }

  /**
   * Each turn's actions under its user message (§12.2): Revert this turn
   * while it has changes to put back (disabled while a turn or a revert
   * runs), the Reverted marker once reverted, and the outcome of the last
   * revert asked on it.
   */
  private paintTurns(): void {
    const session = this.state.session;
    if (!session) {
      return;
    }
    for (const turn of session.turns) {
      this.transcript.messageView(turn.userMessageId)?.actions.replaceChildren(...this.turnActions(turn));
      this.paintUsage(turn);
    }
  }

  /** What the turn used, small under its last answer (§12.3: "show usage"). */
  private paintUsage(turn: TurnRecord): void {
    const messages = this.state.session?.messages ?? [];
    let answer: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].turnId === turn.id && messages[i].role === 'assistant') {
        answer = messages[i].id;
        break;
      }
    }
    const view = answer ? this.transcript.messageView(answer) : undefined;
    if (!view) {
      return;
    }
    const words = turn.usage ? usageText(turn.usage, { billed: this.billedPerUse() }) : null;
    if (!words) {
      view.actions.replaceChildren();
      return;
    }
    const line = document.createElement('span');
    line.className = 'chat-turn-usage';
    line.dataset.ref = 'usage';
    line.textContent = words.short;
    line.title = words.long;
    view.actions.replaceChildren(line);
  }

  /** Whether the session's agent bills each use (an API key), so a cost is worth showing. */
  private billedPerUse(): boolean {
    if (this.state.agent === 'api') {
      // A built-in provider bills the key; a local server costs nothing.
      return this.state.install('api')?.providers?.find((p) => p.id === this.provider)?.builtIn === true;
    }
    return authDescription(this.state.install(this.state.agent))?.apiKey === true;
  }

  private turnActions(turn: TurnRecord): HTMLElement[] {
    const out: HTMLElement[] = [];
    if (this.state.reverting === turn.id) {
      const working = document.createElement('span');
      working.dataset.ref = 'reverting';
      working.className = 'chat-turn-reverted';
      const spinner = document.createElement('span');
      spinner.className = 'loading loading-spinner loading-xs';
      working.append(spinner, document.createTextNode('Reverting…'));
      out.push(working);
    } else if (turn.revertible) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.ref = 'revert';
      button.className = 'chat-turn-revert';
      button.append(ChatIcons.span(ChatIcons.REVERT, '[&>svg]:size-3.5'), document.createTextNode('Revert this turn'));
      const enabled = this.state.canRevert(turn.id);
      button.disabled = !enabled;
      const files = turn.files ?? [];
      button.title = enabled
        ? `Put back ${files.length === 1 ? files[0] : `${files.length} files`} as before this turn`
        : this.state.reverting
          ? 'A revert is running.'
          : 'Stop the running turn first.';
      button.addEventListener('click', () => void this.revertTurn(turn.id));
      out.push(button);
    } else if (turn.revertedAt) {
      const marker = document.createElement('span');
      marker.dataset.ref = 'reverted';
      marker.className = 'chat-turn-reverted';
      marker.title = `The files this turn changed were put back${turn.files?.length ? `: ${turn.files.join(', ')}` : ''}.`;
      marker.append(ChatIcons.span(ChatIcons.REVERT, '[&>svg]:size-3'), document.createTextNode('Reverted'));
      out.push(marker);
    }
    const outcome = this.state.revertOutcome;
    if (outcome && outcome.turnId === turn.id) {
      out.push(this.revertOutcomeView(outcome));
    }
    return out;
  }

  /** Confirm, then revert `turnId` and the later turns that changed files. */
  private async revertTurn(turnId: string): Promise<void> {
    if (!this.state.canRevert(turnId)) {
      return;
    }
    const scope = this.state.revertScope(turnId);
    const later = scope.turns.length - 1;
    const laterText = later <= 0
      ? ''
      : later === 1
        ? ' The later turn that changed files is reverted too.'
        : ` The ${later} later turns that changed files are reverted too.`;
    const options: ChatConfirmOptions = {
      title: 'Revert this turn',
      message: `These files go back to how they were before this turn.${laterText} The conversation stays as it is.`,
      items: scope.files,
      confirmLabel: later > 0 ? `Revert ${later + 1} turns` : 'Revert',
      danger: true,
    };
    const confirmed = this.deps.confirm
      ? await this.deps.confirm(options)
      : window.confirm(`${options.message}\n\n${scope.files.join('\n')}`);
    if (!confirmed) {
      return;
    }
    await this.state.revert(turnId);
  }

  private revertOutcomeView(outcome: RevertOutcome): HTMLElement {
    const box = document.createElement('div');
    box.className = 'chat-revert-outcome';
    box.dataset.ref = 'revert-outcome';
    box.setAttribute('role', 'status');
    const words = document.createElement('div');
    words.className = 'min-w-0 flex-1';
    let failed = false;
    if ('error' in outcome) {
      failed = true;
      words.textContent = `Not reverted: ${outcome.error}`;
    } else {
      const { restored, failed: notRestored = [] } = outcome.result;
      failed = notRestored.length > 0;
      if (restored.length > 0) {
        const line = document.createElement('div');
        line.dataset.ref = 'restored';
        line.append(document.createTextNode(`Put back ${restored.length === 1 ? '' : `${restored.length} files: `}`));
        restored.forEach((file, i) => {
          if (i > 0) {
            line.append(document.createTextNode(', '));
          }
          const code = document.createElement('code');
          code.textContent = file;
          line.append(code);
        });
        line.append(document.createTextNode('.'));
        words.append(line);
      } else if (!failed) {
        words.append(document.createTextNode('Nothing needed putting back.'));
      }
      if (failed) {
        const heading = document.createElement('div');
        heading.textContent = notRestored.length === 1 ? 'Could not put back:' : `Could not put back ${notRestored.length} files:`;
        const list = document.createElement('ul');
        list.dataset.ref = 'failed';
        for (const item of notRestored) {
          const li = document.createElement('li');
          const code = document.createElement('code');
          code.textContent = item.path;
          li.append(code, document.createTextNode(` — ${item.error}`));
          list.append(li);
        }
        words.append(heading, list);
      }
    }
    box.dataset.outcome = failed ? 'failed' : 'done';
    const dismiss = iconButton(ChatIcons.CLOSE, 'Dismiss', 'dismiss-revert');
    dismiss.classList.add('-my-0.5');
    dismiss.addEventListener('click', () => this.state.clearRevertOutcome());
    box.append(ChatIcons.span(failed ? ChatIcons.ERROR : ChatIcons.CHECK, '[&>svg]:size-3.5 mt-0.5'), words, dismiss);
    return box;
  }

  /** Transcript, welcome or setup; the composer when the agent can run. */
  private paintBody(): void {
    const readiness = this.readiness();
    const ready = readiness.state === 'ready';
    const empty = (this.state.session?.messages.length ?? 0) === 0;
    const kind = this.state.agent;
    const signIn = this.state.signIn?.kind === kind ? this.state.signIn : null;
    const setupDeps: AgentSetupDeps = {
      openLink: (url) => this.deps.openExternal(url),
      ...(this.deps.openSettings ? { openSettings: () => this.deps.openSettings!() } : {}),
      recheck: () => this.state.loadAgents(true),
      signIn: {
        current: signIn,
        start: () => void this.signIn(kind),
        reopen: () => {
          if (signIn?.url) {
            this.deps.openExternal(signIn.url);
          }
        },
        cancel: () => void this.state.cancelSignIn(),
      },
      apiOption: this.offersApi(),
    };

    this.center.replaceChildren();
    this.center.classList.toggle('hidden', !empty);
    this.transcript.el.classList.toggle('hidden', empty);
    if (empty) {
      this.center.append(ready ? renderWelcome(readiness.install, setupDeps) : renderAgentSetup(readiness, setupDeps));
    }

    this.footerSetup.replaceChildren();
    const showFooterSetup = !empty && !ready && readiness.state !== 'loading';
    this.footerSetup.classList.toggle('hidden', !showFooterSetup);
    if (showFooterSetup) {
      this.footerSetup.append(renderAgentSetup(readiness, setupDeps));
    }
    // The composer stays while detection loads (disabled), and while a turn runs.
    const composerShown = ready || readiness.state === 'loading' || isBusy(this.state.status);
    this.composer.el.classList.toggle('hidden', !composerShown);
    this.composerUsable = composerShown && (ready || isBusy(this.state.status));
    this.composer.setEnabled(this.composerUsable);
    this.syncReferences();
  }

  /**
   * Where the agent on screen stands. An `api` chat is ready only when its
   * own provider is: another one being ready does not run this chat.
   */
  private readiness(): AgentReadiness {
    const readiness = this.state.readiness();
    if (readiness.state !== 'ready' || readiness.install.kind !== 'api') {
      return readiness;
    }
    const id = this.provider;
    if (id && readiness.install.providers?.find((p) => p.id === id)?.ready) {
      return readiness;
    }
    return { state: 'signed-out', install: readiness.install, ...(id ? { providerId: id } : {}) };
  }

  /** Neither CLI is installed but the engine has the `api` agent: the not-found screen offers it too (§20.1). */
  private offersApi(): boolean {
    const agents = this.state.agents ?? [];
    return agents.some((a) => a.kind === 'api') &&
      agents.filter((a) => a.kind !== 'api').every((a) => a.minVersion === '' || ChatState.readinessOf(a).state === 'not-found');
  }

  /** The selection attaches only while the panel is open and its composer usable (§11.1). */
  private syncReferences(): void {
    this.references?.setActive(this.open && this.composerUsable);
  }

  /** Sign in to `kind` from the app: the sign-in page opens in the browser, the panel waits for it. */
  private async signIn(kind: AgentKind): Promise<void> {
    const url = await this.state.startSignIn(kind);
    if (url) {
      this.deps.openExternal(url);
    }
  }

  /** The status line above the composer, the activity line, Stop. */
  private paintStatus(): void {
    const status = this.state.status;
    const busy = this.state.busy;
    this.composer.setBusy(isBusy(status));
    this.transcript.setActivity(this.activityText(status));

    this.statusBar.replaceChildren();
    const line = this.statusLine(status);
    this.statusBar.classList.toggle('hidden', line === null);
    if (line) {
      this.statusBar.append(line);
    }
    this.el.dataset.status = status.state;
    this.el.dataset.busy = String(busy);
  }

  private activityText(status: SessionStatus): string | null {
    if (this.state.sending && !isBusy(status)) {
      return 'Sending…';
    }
    switch (status.state) {
      case 'starting':
        return `Starting ${this.state.agent === 'api' ? 'the agent' : AGENT_INFO[this.state.agent].name}…`;
      case 'running':
        return 'Working…';
      case 'awaiting-approval':
        return 'Waiting for your approval…';
      default:
        return null;
    }
  }

  private statusLine(status: SessionStatus): HTMLElement | null {
    if (this.state.error) {
      const row = statusRow('error', this.state.error);
      const dismiss = iconButton(ChatIcons.CLOSE, 'Dismiss', 'dismiss');
      dismiss.addEventListener('click', () => this.state.clearError());
      row.append(dismiss);
      return row;
    }
    if (!this.state.connected && this.state.session && this.started) {
      return statusRow('warning', 'Reconnecting to FluidCAD…');
    }
    switch (status.state) {
      case 'interrupted': {
        const row = statusRow('warning', status.reason);
        const resume = document.createElement('button');
        resume.type = 'button';
        resume.dataset.ref = 'continue';
        resume.className = 'btn btn-xs btn-primary gap-1 shrink-0';
        resume.append(ChatIcons.span(ChatIcons.CONTINUE, '[&>svg]:size-3'), document.createTextNode('Continue'));
        resume.addEventListener('click', () => void this.state.continueTurn(this.mode));
        row.append(resume);
        return row;
      }
      case 'error': {
        if (status.kind === 'other') {
          // The transcript's notice says it.
          return null;
        }
        const resets = status.kind === 'rate-limit' && status.resetsAt ? resetsText(status.resetsAt) : null;
        const text = resets ? `${status.message} It ${resets}.` : status.message;
        const row = statusRow(status.kind === 'rate-limit' ? 'warning' : 'error', text);
        if (status.kind === 'auth' || status.kind === 'not-installed') {
          const check = document.createElement('button');
          check.type = 'button';
          check.dataset.ref = 'status-check-again';
          check.className = 'btn btn-xs btn-ghost border border-base-content/15 shrink-0';
          check.textContent = 'Check again';
          check.addEventListener('click', () => void this.state.loadAgents(true));
          row.append(check);
        }
        return row;
      }
      default:
        return null;
    }
  }

  /** The chats menu under the title: open it with the list read again, or close it. */
  private async toggleSessionMenu(): Promise<void> {
    if (this.sessionsMenu.isOpen) {
      this.sessionsMenu.close();
      return;
    }
    await this.state.loadSessions();
    const rect = this.sessionButton.getBoundingClientRect();
    this.sessionsMenu.show({ left: rect.left, bottom: rect.bottom });
  }

  /** Ask, then delete a chat; the chat on screen gives way to a new one. */
  private async deleteSession(id: string): Promise<void> {
    const row = this.state.sessions.find((s) => s.id === id);
    const title = row?.title ?? 'this chat';
    const running = row ? isBusy(row.status) : false;
    const options: ChatConfirmOptions = {
      title: 'Delete chat',
      message:
        `“${title}” and its conversation are removed from this project.` +
        `${running ? ' Its running turn stops.' : ''} Changes the agent made to files stay as they are.`,
      confirmLabel: 'Delete',
      danger: true,
      kind: 'delete',
    };
    const confirmed = this.deps.confirm ? await this.deps.confirm(options) : window.confirm(options.message);
    if (!confirmed) {
      return;
    }
    await this.state.deleteSession(id);
    if (!this.state.session) {
      this.composer.focus();
    }
  }

  /** The window changed size: cover the scene below 640 px, or stop covering it. */
  private readonly onResize = (): void => {
    if (this.open) {
      this.deps.slot.layout();
    }
  };
}

function iconButton(svg: string, label: string, ref: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.ref = ref;
  button.className = 'btn btn-ghost btn-square btn-xs text-base-content/60 shrink-0';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(ChatIcons.span(svg, '[&>svg]:size-4'));
  return button;
}

function statusRow(level: 'warning' | 'error', text: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = `chat-status-row chat-status-${level}`;
  const words = document.createElement('span');
  words.className = 'min-w-0 flex-1 break-words';
  words.dataset.ref = 'status-text';
  words.textContent = text;
  row.append(ChatIcons.span(level === 'error' ? ChatIcons.ERROR : ChatIcons.WARNING, '[&>svg]:size-3.5 mt-px'), words);
  return row;
}

/** A slot in the chip row that a paint fills (laid out as if its chip were in the row itself). */
function chipSlot(ref: string): HTMLSpanElement {
  const slot = document.createElement('span');
  slot.dataset.ref = ref;
  slot.className = 'contents';
  return slot;
}

/** A chip under the message box that opens a menu. */
function chipButton(ref: string): HTMLButtonElement {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.dataset.ref = ref;
  chip.className = 'chat-chip';
  chip.setAttribute('aria-haspopup', 'menu');
  return chip;
}

function chipLabel(text: string): HTMLSpanElement {
  const label = document.createElement('span');
  label.className = 'chat-chip-label';
  label.textContent = text;
  return label;
}

/** A menu chip's content: an icon, the label (cut short when narrow), a chevron. */
function fillChip(chip: HTMLElement, text: string, icon?: { svg: string; className: string }): void {
  const parts: HTMLElement[] = [];
  if (icon) {
    const el = document.createElement('span');
    el.className = `chat-chip-icon ${icon.className}`;
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = icon.svg;
    parts.push(el);
  }
  parts.push(chipLabel(text));
  const chevron = document.createElement('span');
  chevron.className = 'chat-chip-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.innerHTML = ChatIcons.CHEVRON_DOWN;
  parts.push(chevron);
  chip.replaceChildren(...parts);
}
