import type { LeftSlot } from '../left-slot';
import { showPopupMenu, type PopupMenuItem } from '../popup-menu';
import { AGENT_INFO, authDescription, renderAgentSetup, renderWelcome, type AgentSetupDeps } from './agent-setup';
import type { ChatClient } from './chat-client';
import { ChatComposer } from './chat-composer';
import { ChatIcons } from './chat-icons';
import { ChatSessionsMenu } from './chat-sessions-menu';
import { PERMISSION_MODES } from './permission-modes';
import { ChatState, type ChatChange, type ChatTimers, type RevertOutcome } from './chat-state';
import { ChatTranscript } from './chat-transcript';
import {
  CLAUDE_EFFORTS,
  COMMON_EFFORTS,
  effortLabel,
  isBusy,
  type AgentKind,
  type AgentModel,
  type ApprovalDecision,
  type Effort,
  type PermissionMode,
  type SessionStatus,
  type TurnRecord,
} from './chat-types';
import type { Colorizer } from './code-block';
import { SceneReferences, blobToBase64, type ChatSceneHost } from './scene-references';
import { resetsText } from './time-format';
import { usageText } from './usage';
import './chat-panel.css';

/** The agent preferences the panel follows (Settings → Agent, `agent` in the preferences file). */
export type ChatPanelSettings = {
  defaultAgent: AgentKind | null;
  claudeModel?: string;
  codexModel?: string;
  /** Each agent's effort (Settings → Agent); absent: the CLI's default. */
  claudeEffort?: Effort;
  codexEffort?: Effort;
  /** The older shared effort, read when the agent's own is absent. */
  effort?: Effort;
  permissionMode: PermissionMode;
};

/** The effort picker's row for "no effort flag": the agent's (or model's) own default. */
const DEFAULT_EFFORT = '';

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
  /** The user switched the permission mode in the header: remember it (`agent.permissionMode`, as Settings → Agent). */
  onPermissionModeChosen?(mode: PermissionMode): void;
  /** Ask the user to confirm (Revert this turn), in the page's dialog; absent: the browser's confirm. */
  confirm?(options: ChatConfirmOptions): Promise<boolean>;
  onOpenChange?(open: boolean): void;
  /**
   * The scene, for attaching the selected geometry to a message (§11): the
   * idle selection, renders, the capture. Absent: no references.
   */
  scene?: ChatSceneHost;
  /** Timers for reattaching after a refused stream (tests). */
  timers?: ChatTimers;
};

const MIN_WIDTH = 300;
/** The model picker's row that asks for a model by name. */
const OTHER_MODEL = '__other__';

/**
 * The Agent panel (docs/agent-chat-plan.md §10): a chat with the user's own
 * Claude Code (or Codex), which reads the project through FluidCAD's MCP
 * tools, docked on the left from the rail's Agent button.
 *
 * **One slot** with the code editor and the Hub ({@link LeftSlot}): opening
 * it closes whichever holds the slot, at the shared width; below 640 px it
 * covers the scene.
 *
 * The header holds the chats menu (the title: switching, renaming and
 * deleting chats, {@link ChatSessionsMenu}), New chat and Close, and a row with the agent, the model, the permission mode (Ask
 * before edits / Apply edits automatically, the `agent.permissionMode`
 * preference) and how the agent is paid for (subscription or API key).
 * Under it the transcript ({@link ChatTranscript}) and the composer
 * ({@link ChatComposer}). The session's status drives what shows: Stop while
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
  private readonly sessionButton: HTMLButtonElement;
  private readonly sessionTitle: HTMLSpanElement;
  private readonly agentSlot: HTMLDivElement;
  private readonly modelSlot: HTMLDivElement;
  private readonly modeButton: HTMLButtonElement;
  private readonly authBadge: HTMLSpanElement;
  private readonly center: HTMLDivElement;
  private readonly statusBar: HTMLDivElement;
  private readonly footerSetup: HTMLDivElement;
  private readonly sessionsMenu: ChatSessionsMenu;
  private readonly leaveSlot: () => void;
  private readonly unsubscribe: () => void;
  private open = false;
  private started = false;
  /** The model picked in the panel, per agent; holds for new chats until the page reloads. */
  private readonly modelChoices = new Map<AgentKind, string>();
  /** The effort picked in the panel, per agent (`DEFAULT_EFFORT`: the default); holds until the page reloads. */
  private readonly effortChoices = new Map<AgentKind, string>();
  private readonly effortSlot: HTMLDivElement;
  /** The model picker shows a text field for a model by name. */
  private typingModel = false;
  /** The mode switched in the header, until Settings → Agent is saved again. */
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
      agentName: (kind) => AGENT_INFO[kind]?.name ?? kind,
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

    // The agent row: which agent, which model, how it is paid for.
    const toolbar = document.createElement('div');
    toolbar.className = 'flex items-center gap-1.5 h-9 shrink-0 px-3 border-b border-base-content/10 text-hub-xs text-base-content/70';
    this.agentSlot = document.createElement('div');
    this.agentSlot.dataset.ref = 'agent';
    this.agentSlot.className = 'flex items-center min-w-0';
    this.modelSlot = document.createElement('div');
    this.modelSlot.dataset.ref = 'model';
    this.modelSlot.className = 'flex items-center min-w-0';
    this.effortSlot = document.createElement('div');
    this.effortSlot.dataset.ref = 'effort';
    this.effortSlot.className = 'flex items-center min-w-0';
    this.modeButton = document.createElement('button');
    this.modeButton.type = 'button';
    this.modeButton.dataset.ref = 'mode';
    this.modeButton.className = 'btn btn-ghost btn-xs gap-1 px-1.5 font-normal text-hub-xs text-base-content/75 shrink-0';
    this.modeButton.setAttribute('aria-haspopup', 'menu');
    this.modeButton.addEventListener('click', () => this.showModeMenu());
    const modeSeparator = document.createElement('span');
    modeSeparator.className = 'text-base-content/30 -mx-0.5';
    modeSeparator.textContent = '·';
    this.authBadge = document.createElement('span');
    this.authBadge.dataset.ref = 'auth-badge';
    this.authBadge.className = 'ml-auto badge badge-sm badge-ghost shrink-0 hidden';
    toolbar.append(this.agentSlot, this.modelSlot, this.effortSlot, modeSeparator, this.modeButton, this.authBadge);

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
    });
    this.references = deps.scene ? new SceneReferences(deps.scene, this.composer) : null;
    if (this.references) {
      this.composer.setAttachments(this.references.el);
    }

    this.el.append(header, toolbar, body, this.statusBar, this.footerSetup, this.composer.el, deps.slot.resizeHandle());
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
  }

  /** Settings → Agent was saved: detection may answer differently (a path, the API-key choice). */
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
    this.state.dispose();
    this.transcript.destroy();
    this.leaveSlot();
    this.el.remove();
  }

  /** The model a message goes with: the panel's pick, the session's, the setting's, else the CLI's own. */
  get model(): string {
    const settings = this.deps.settings();
    const preferred = this.state.agent === 'codex' ? settings.codexModel : settings.claudeModel;
    const session = this.state.session;
    return this.modelChoices.get(this.state.agent) ?? session?.model ?? preferred ?? 'default';
  }

  /**
   * The effort a message goes with (`DEFAULT_EFFORT`: none, the CLI's own):
   * the panel's pick, the session's, the setting's — whichever is first and
   * is a level of the agent and model; else the default.
   */
  get effort(): string {
    const settings = this.deps.settings();
    const kind = this.state.agent;
    const levels = this.effortLevels();
    const candidates = [
      this.effortChoices.get(kind),
      this.state.session?.effort ?? undefined,
      (kind === 'codex' ? settings.codexEffort : settings.claudeEffort) ?? settings.effort,
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
   * else the three every model takes.
   */
  effortLevels(): readonly string[] {
    const kind = this.state.agent;
    if (kind === 'claude') {
      return CLAUDE_EFFORTS;
    }
    const models = this.state.models.get(kind) ?? [];
    const id = this.model;
    const model = id === 'default' ? models.find((m) => m.isDefault) : models.find((m) => m.id === id);
    return model?.efforts && model.efforts.length > 0 ? model.efforts : COMMON_EFFORTS;
  }

  /** The permission mode messages go with: the header's switch, else Settings → Agent. */
  get mode(): PermissionMode {
    return this.modeChoice ?? this.deps.settings().permissionMode;
  }

  /** Switch the permission mode (the header's menu); it holds for the next messages and is remembered. */
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

  /** A new chat starts with the default agent when it can run, else the first that can. */
  private pickDraftAgent(): void {
    const offered = this.state.offeredAgents;
    if (offered.length === 0) {
      return;
    }
    const preferred = this.deps.settings().defaultAgent;
    const ready = offered.filter((a) => ChatState.readinessOf(a).state === 'ready');
    const pick = offered.find((a) => a.kind === preferred && ChatState.readinessOf(a).state === 'ready')
      ?? ready[0]
      ?? offered.find((a) => a.kind === preferred)
      ?? offered[0];
    this.state.setDraftAgent(pick.kind);
  }

  private async send(text: string): Promise<boolean> {
    const settings = this.deps.settings();
    // The references go with one capture of the model, each in its colour
    // (§11.2), taken while their picks still hold.
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
    this.transcript.scrollToBottom();
    const effort = this.effort;
    const sent = await this.state.send(text, {
      model: this.model,
      mode: this.mode,
      ...(effort !== DEFAULT_EFFORT ? { effort } : {}),
      ...(attached ? { references: attached.references } : {}),
      ...(image ? { image } : {}),
    });
    if (sent && attached) {
      this.references!.clearSent();
    }
    return sent;
  }

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

  /** The agent row: a picker when more than one agent can run, else its name; the model; the auth badge. */
  private paintToolbar(): void {
    const kind = this.state.agent;
    const info = AGENT_INFO[kind];
    this.agentSlot.replaceChildren();
    const ready = this.state.offeredAgents.filter((a) => ChatState.readinessOf(a).state === 'ready');
    if (!this.state.session && ready.length > 1) {
      const select = document.createElement('select');
      select.dataset.ref = 'agent-picker';
      select.className = 'select select-ghost select-xs w-auto font-medium';
      select.setAttribute('aria-label', 'Agent');
      for (const install of ready) {
        const option = document.createElement('option');
        option.value = install.kind;
        option.textContent = AGENT_INFO[install.kind].name;
        select.append(option);
      }
      select.value = kind;
      select.addEventListener('change', () => {
        const picked = select.value as AgentKind;
        this.state.setDraftAgent(picked);
        this.deps.onAgentChosen?.(picked);
        void this.state.loadModels(picked);
        this.paintToolbar();
      });
      this.agentSlot.append(select);
    } else {
      const name = document.createElement('span');
      name.dataset.ref = 'agent-name';
      name.className = 'font-medium text-base-content/80 truncate';
      name.textContent = info.name;
      this.agentSlot.append(name);
    }
    this.paintModelPicker();
    this.paintMode();

    const auth = authDescription(this.state.install(kind));
    this.authBadge.classList.toggle('hidden', !auth);
    this.authBadge.classList.toggle('badge-warning', auth?.apiKey === true);
    this.authBadge.textContent = auth?.short ?? '';
    this.authBadge.title = auth
      ? auth.apiKey
        ? `${auth.long} To use your Claude subscription instead, turn on “Use my Claude subscription even if ANTHROPIC_API_KEY is set” in Settings → Agent.`
        : auth.long
      : '';
  }

  private paintModelPicker(): void {
    this.modelSlot.replaceChildren();
    const separator = document.createElement('span');
    separator.className = 'text-base-content/30 px-0.5';
    separator.textContent = '·';
    this.modelSlot.append(separator);
    const current = this.model;
    if (this.typingModel) {
      const input = document.createElement('input');
      input.type = 'text';
      input.dataset.ref = 'model-input';
      input.className = 'input input-xs w-36 font-mono';
      input.placeholder = 'Model name';
      input.value = current === 'default' ? '' : current;
      input.spellcheck = false;
      const commit = (save: boolean) => {
        const value = input.value.trim();
        this.typingModel = false;
        if (save && /^[A-Za-z0-9][\w.:@/[\]-]*$/.test(value)) {
          this.modelChoices.set(this.state.agent, value);
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
    const select = document.createElement('select');
    select.dataset.ref = 'model-picker';
    select.className = 'select select-ghost select-xs w-auto';
    select.setAttribute('aria-label', 'Model');
    select.title = 'Model';
    const models: AgentModel[] = this.state.models.get(this.state.agent) ?? [{ id: 'default', label: 'Default' }];
    const options = [...models];
    if (!options.some((m) => m.id === current)) {
      options.push({ id: current, label: current });
    }
    for (const model of options) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.label ?? model.id;
      select.append(option);
    }
    const other = document.createElement('option');
    other.value = OTHER_MODEL;
    other.textContent = 'Other model…';
    select.append(other);
    select.value = current;
    select.addEventListener('change', () => {
      if (select.value === OTHER_MODEL) {
        this.typingModel = true;
      } else {
        this.modelChoices.set(this.state.agent, select.value);
      }
      this.paintModelPicker();
    });
    this.modelSlot.append(select);
    // Codex's levels depend on the model.
    this.paintEffortPicker();
  }

  /** The effort picker: the default, then the levels of the agent and model. */
  private paintEffortPicker(): void {
    this.effortSlot.replaceChildren();
    const separator = document.createElement('span');
    separator.className = 'text-base-content/30 px-0.5';
    separator.textContent = '·';
    this.effortSlot.append(separator);
    const select = document.createElement('select');
    select.dataset.ref = 'effort-picker';
    select.className = 'select select-ghost select-xs w-auto';
    select.setAttribute('aria-label', 'Effort');
    const current = this.effort;
    const add = (value: string, label: string) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    };
    add(DEFAULT_EFFORT, 'Default effort');
    for (const level of this.effortLevels()) {
      add(level, `${effortLabel(level)} effort`);
    }
    select.value = current;
    select.title = `Effort: how hard the model thinks before it answers${current === DEFAULT_EFFORT ? ` (${AGENT_INFO[this.state.agent].name}'s own default)` : ''}.`;
    select.addEventListener('change', () => {
      this.effortChoices.set(this.state.agent, select.value);
      this.paintEffortPicker();
    });
    this.effortSlot.append(select);
  }

  /** The permission-mode switch: the mode's icon and short name; the full name as its tooltip. */
  private paintMode(): void {
    const current = PERMISSION_MODES.find((m) => m.mode === this.mode) ?? PERMISSION_MODES[0];
    this.modeButton.dataset.mode = current.mode;
    this.modeButton.title = `${current.label}. ${current.description}`;
    this.modeButton.setAttribute('aria-label', `Permission mode: ${current.label}`);
    this.modeButton.replaceChildren(
      ChatIcons.span(current.mode === 'ask' ? ChatIcons.ASK : ChatIcons.AUTO, `[&>svg]:size-3.5 ${current.mode === 'ask' ? '' : 'text-warning'}`),
      document.createTextNode(current.short),
      ChatIcons.span(ChatIcons.CHEVRON_DOWN, '[&>svg]:size-3 text-base-content/50'),
    );
  }

  private showModeMenu(): void {
    const current = this.mode;
    const items: PopupMenuItem[] = PERMISSION_MODES.map((m) => ({
      icon: m.mode === current ? ChatIcons.CHECK : m.mode === 'ask' ? ChatIcons.ASK : ChatIcons.AUTO,
      label: m.label,
      title: m.description,
      className: m.mode === current ? 'font-medium' : undefined,
      onSelect: () => this.setMode(m.mode),
    }));
    const rect = this.modeButton.getBoundingClientRect();
    const menu = showPopupMenu(this.deps.container, { clientX: rect.left, clientY: rect.bottom + 4 }, items, { focusFirst: true });
    menu.dataset.ref = 'mode-menu';
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
    const readiness = this.state.readiness();
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
    this.composer.setEnabled(ready || isBusy(this.state.status));
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
        return `Starting ${AGENT_INFO[this.state.agent].name}…`;
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

