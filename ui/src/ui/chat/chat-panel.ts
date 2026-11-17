import type { LeftSlot } from '../left-slot';
import { showPopupMenu, type PopupMenuItem } from '../popup-menu';
import { AGENT_INFO, authDescription, renderAgentSetup, renderWelcome, type AgentSetupDeps } from './agent-setup';
import type { ChatClient } from './chat-client';
import { ChatComposer } from './chat-composer';
import { ChatIcons } from './chat-icons';
import { ChatState, type ChatChange, type ChatTimers } from './chat-state';
import { ChatTranscript } from './chat-transcript';
import { isBusy, type AgentKind, type AgentModel, type Effort, type PermissionMode, type SessionStatus } from './chat-types';
import type { Colorizer } from './code-block';
import './chat-panel.css';

/** The agent preferences the panel follows (Settings → Agent, `agent` in the preferences file). */
export type ChatPanelSettings = {
  defaultAgent: AgentKind | null;
  claudeModel?: string;
  codexModel?: string;
  effort?: Effort;
  permissionMode: PermissionMode;
};

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
  onOpenChange?(open: boolean): void;
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
 * The header holds the session menu (the title; switching chats), New chat
 * and Close, and a row with the agent, the model and how the agent is paid
 * for (subscription or API key). Under it the transcript
 * ({@link ChatTranscript}) and the composer ({@link ChatComposer}). The
 * session's status drives what shows: Stop while a turn runs, Continue after
 * the engine restarted mid-turn, the errors. Until the agent can run, the
 * panel says what is missing instead (§9.1, {@link renderAgentSetup}).
 */
export class ChatPanel {
  readonly el: HTMLElement;
  readonly state: ChatState;
  readonly transcript: ChatTranscript;
  readonly composer: ChatComposer;
  private readonly sessionButton: HTMLButtonElement;
  private readonly sessionTitle: HTMLSpanElement;
  private readonly agentSlot: HTMLDivElement;
  private readonly modelSlot: HTMLDivElement;
  private readonly authBadge: HTMLSpanElement;
  private readonly center: HTMLDivElement;
  private readonly statusBar: HTMLDivElement;
  private readonly footerSetup: HTMLDivElement;
  private readonly leaveSlot: () => void;
  private readonly unsubscribe: () => void;
  private open = false;
  private started = false;
  /** A model the user picked in the panel; holds for new chats until the page reloads. */
  private modelChoice: string | null = null;
  /** The model picker shows a text field for a model by name. */
  private typingModel = false;

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
    this.sessionButton.addEventListener('click', () => void this.showSessionMenu());
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
    this.authBadge = document.createElement('span');
    this.authBadge.dataset.ref = 'auth-badge';
    this.authBadge.className = 'ml-auto badge badge-sm badge-ghost shrink-0 hidden';
    toolbar.append(this.agentSlot, this.modelSlot, this.authBadge);

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
    window.removeEventListener('resize', this.onResize);
    this.unsubscribe();
    this.state.dispose();
    this.transcript.destroy();
    this.leaveSlot();
    this.el.remove();
  }

  /** The model a message goes with: the panel's pick, the session's, the setting's, else the CLI's own. */
  get model(): string {
    const settings = this.deps.settings();
    const preferred = this.state.agent === 'codex' ? settings.codexModel : settings.claudeModel;
    return this.modelChoice ?? this.state.session?.model ?? preferred ?? 'default';
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
    this.transcript.scrollToBottom();
    return this.state.send(text, {
      model: this.model,
      mode: settings.permissionMode,
      ...(settings.effort ? { effort: settings.effort } : {}),
    });
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
        } else if (change.event.type === 'title') {
          this.paintTitle();
        } else if (change.event.type === 'message-start') {
          this.paintBody();
        }
        return;
      }
      case 'agents':
        this.paintToolbar();
        this.paintBody();
        this.paintStatus();
        return;
      case 'sessions':
        this.paintTitle();
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
          this.modelChoice = value;
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
        this.modelChoice = select.value;
      }
      this.paintModelPicker();
    });
    this.modelSlot.append(select);
  }

  /** Transcript, welcome or setup; the composer when the agent can run. */
  private paintBody(): void {
    const readiness = this.state.readiness();
    const ready = readiness.state === 'ready';
    const empty = (this.state.session?.messages.length ?? 0) === 0;
    const setupDeps: AgentSetupDeps = {
      openLink: (url) => this.deps.openExternal(url),
      ...(this.deps.openSettings ? { openSettings: () => this.deps.openSettings!() } : {}),
      recheck: () => this.state.loadAgents(true),
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
        resume.addEventListener('click', () => void this.state.continueTurn());
        row.append(resume);
        return row;
      }
      case 'error': {
        if (status.kind === 'other') {
          // The transcript's notice says it.
          return null;
        }
        const text = status.kind === 'rate-limit' && status.resetsAt ? `${status.message} ${resetsAtText(status.resetsAt)}` : status.message;
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

  private async showSessionMenu(): Promise<void> {
    await this.state.loadSessions();
    const items: PopupMenuItem[] = [{ icon: ChatIcons.NEW, label: 'New chat', onSelect: () => this.newChat() }];
    const current = this.state.session?.id;
    this.state.sessions.slice(0, 30).forEach((session, index) => {
      items.push({
        icon: session.id === current ? ChatIcons.CHECK : ChatIcons.SESSION,
        label: session.title,
        title: `${AGENT_INFO[session.agent]?.name ?? session.agent} · ${new Date(session.updatedAt).toLocaleString()}`,
        separated: index === 0,
        className: session.id === current ? 'font-medium' : undefined,
        onSelect: () => {
          if (session.id !== current) {
            void this.state.openSession(session.id);
          }
        },
      });
    });
    const rect = this.sessionButton.getBoundingClientRect();
    const menu = showPopupMenu(this.deps.container, { clientX: rect.left, clientY: rect.bottom + 4 }, items, { focusFirst: true });
    menu.dataset.ref = 'session-menu';
    menu.classList.add('max-w-[320px]', 'max-h-[60vh]', 'overflow-y-auto');
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

function resetsAtText(resetsAt: string): string {
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const sameDay = date.toDateString() === new Date().toDateString();
  const when = sameDay
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return `It resets at ${when}.`;
}
