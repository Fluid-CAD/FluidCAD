import type { AgentPreferences, AgentProviderConfig } from '../../api';
import type { AgentInstall, ApiProviderStatus } from '../chat/chat-types';
import { PERMISSION_MODES } from '../chat/permission-modes';
import { ICON_TRASH } from '../icons';
import { BUILT_IN_PROVIDERS, PROVIDER_ID, agentSettings, isServerUrl } from './agent-settings';
import {
  FIELD_HINT,
  FIELD_LABEL,
  SELECT,
  TEXT_INPUT,
  TOGGLE,
  field,
  toggleRow,
  type PersistPreference,
  type SettingsContext,
  type SettingsTab,
} from './settings-tab';

export type AgentTabDeps = {
  /** What detection found (`fresh`: detect again); null when the engine has no agent runtime. */
  agents(fresh: boolean): Promise<AgentInstall[] | null>;
  /**
   * Persist the `agent` preference and resolve once the engine has it, so
   * detection that follows reads the new API-key choice; false when the
   * engine refused it. Absent: the dialog's fire-and-forget persist.
   */
  save?(value: AgentPreferences): Promise<boolean | void>;
  /** The preference or a key is saved: an open Agent panel reads detection again. */
  onSaved?(): void;
  /** The `api` agent's providers as they stand (`GET api/agent/providers`); null when the engine did not answer. */
  providers?(): Promise<ApiProviderStatus[] | null>;
  /**
   * Store a provider's API key on the engine (`PUT …/providers/:id/key`).
   * Resolves to an error to show, or null once stored. The page keeps no copy.
   */
  setKey?(id: string, apiKey: string): Promise<string | null>;
  /** Delete a provider's stored key; resolves to an error to show, or null. */
  removeKey?(id: string): Promise<string | null>;
};

const NAMES: Record<AgentInstall['kind'], string> = { claude: 'Claude Code', codex: 'Codex', api: 'API' };
/** "Use my Claude subscription even if ANTHROPIC_API_KEY is set" (§19, the owner's wording). */
export const IGNORE_API_KEY_LABEL = 'Use my Claude subscription even if ANTHROPIC_API_KEY is set';

/** The servers "Add" offers (§20.2): Ollama and LM Studio at their usual addresses, or any other. */
export const SERVER_PRESETS = [
  { ref: 'ollama', id: 'ollama', label: 'Ollama', baseURL: 'http://localhost:11434/v1', button: 'Add Ollama' },
  { ref: 'lm-studio', id: 'lm-studio', label: 'LM Studio', baseURL: 'http://localhost:1234/v1', button: 'Add LM Studio' },
  { ref: 'custom', id: 'server', label: 'Server', baseURL: '', button: 'Add other server' },
] as const;

/** A context window the server field takes, in tokens. */
const CONTEXT_MIN = 1024;
const CONTEXT_MAX = 10_000_000;

const GHOST_BUTTON = 'btn btn-xs btn-ghost';
const KEY_INPUT = 'input input-sm input-bordered flex-1 min-w-0 font-mono text-xs';

/**
 * Settings → Agent (docs/agent-chat-plan.md §9.3, §10.3, §20): the agent a
 * new chat starts with, whether edits are asked about, and whether Claude
 * Code may use an inherited ANTHROPIC_API_KEY; the API keys and local
 * servers of the `api` agent; under them, Detected Agents. The model and
 * effort are picked with the Agent panel's chips; the program paths
 * (`claudePath`, `codexPath`) are still read but not edited here.
 *
 * **Keys** never go through the dialog's Save or the preferences: each is
 * stored by its own PUT and the field is emptied once it is, so the page
 * only ever learns whether a provider has one and where from. A key typed
 * for a server not saved yet is stored right after the dialog's Save has
 * saved the server (the engine does not know it before).
 */
export class AgentTab implements SettingsTab {
  readonly id = 'agent';
  readonly label = 'Agent';
  private draft: AgentPreferences = { ...agentSettings.current };
  private ctx!: SettingsContext;
  private defaultAgent!: HTMLSelectElement;
  private permission!: HTMLSelectElement;
  private ignoreApiKey!: HTMLInputElement;
  private keysSection!: HTMLDivElement;
  private keys!: HTMLDivElement;
  private serversSection!: HTMLDivElement;
  private servers!: HTMLDivElement;
  private serversError!: HTMLParagraphElement;
  private readonly serverViews = new Map<string, ServerView>();
  private found!: HTMLDivElement;
  private installs: AgentInstall[] | null = null;
  private detecting = false;

  constructor(private readonly deps: AgentTabDeps | null) {}

  mount(root: HTMLElement, ctx: SettingsContext): void {
    this.ctx = ctx;
    const changed = () => ctx.changed();

    this.defaultAgent = select([
      ['', 'The first one ready'],
      ['claude', 'Claude Code'],
      ['codex', 'Codex'],
      ['api', 'API key or local model'],
    ]);
    this.defaultAgent.dataset.ref = 'default-agent';
    this.defaultAgent.addEventListener('change', () => {
      const value = this.defaultAgent.value;
      this.draft.defaultAgent = value === 'claude' || value === 'codex' || value === 'api' ? value : null;
      changed();
    });
    root.appendChild(field('Agent for new chats', this.defaultAgent));

    this.permission = select(PERMISSION_MODES.map((m): [string, string] => [m.mode, m.label]));
    this.permission.dataset.ref = 'permission-mode';
    this.permission.addEventListener('change', () => {
      this.draft.permissionMode = this.permission.value === 'auto-edits' ? 'auto-edits' : 'ask';
      changed();
    });
    root.appendChild(
      field(
        'Edits',
        this.permission,
        'The same switch as the mode chip under the Agent panel’s message box. Ask before edits shows each change for you to allow; ' +
          'Apply edits automatically changes project files without asking, and still asks before anything outside the project.',
      ),
    );

    const ignore = toggleRow(IGNORE_API_KEY_LABEL, (checked) => {
      // Touching the switch makes it the user's choice; untouched, it follows detection.
      this.draft.claudeIgnoreApiKey = checked;
      this.paintApiKey();
      changed();
    });
    this.ignoreApiKey = ignore.input;
    this.ignoreApiKey.dataset.ref = 'ignore-api-key';
    root.appendChild(ignore.row);
    const ignoreHint = document.createElement('p');
    ignoreHint.className = `${FIELD_HINT} -mt-3 mb-4`;
    ignoreHint.dataset.ref = 'ignore-api-key-hint';
    ignoreHint.textContent =
      'When ANTHROPIC_API_KEY is set, Claude Code bills that key instead of your subscription. ' +
      'Turn this on to hide the key from Claude Code. On by default when you are signed in to a Claude subscription.';
    root.appendChild(ignoreHint);

    // The `api` agent's keys and servers: shown once detection says the engine has it.
    this.keysSection = document.createElement('div');
    this.keysSection.dataset.ref = 'api-keys';
    this.keysSection.className = 'mb-4 hidden';
    const keysHint = document.createElement('p');
    keysHint.className = `${FIELD_HINT} mb-2`;
    keysHint.textContent = 'Used only by the agent on an API key, never by Claude Code or Codex.';
    this.keys = document.createElement('div');
    this.keys.className = 'flex flex-col gap-2';
    this.keysSection.append(sectionLabel('API keys'), keysHint, this.keys);
    root.appendChild(this.keysSection);

    this.serversSection = document.createElement('div');
    this.serversSection.dataset.ref = 'servers';
    this.serversSection.className = 'mb-4 hidden';
    this.servers = document.createElement('div');
    this.servers.className = 'flex flex-col gap-2';
    const add = document.createElement('div');
    add.className = 'flex flex-wrap gap-1 mt-2';
    for (const preset of SERVER_PRESETS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.ref = `add-${preset.ref}`;
      button.className = `${GHOST_BUTTON} border border-base-content/15`;
      button.textContent = preset.button;
      button.addEventListener('click', () => this.addServer(preset));
      add.appendChild(button);
    }
    this.serversError = document.createElement('p');
    this.serversError.dataset.ref = 'servers-error';
    this.serversError.className = `${FIELD_HINT} text-error mt-1 hidden`;
    this.serversSection.append(sectionLabel('Local models'), this.servers, add, this.serversError);
    root.appendChild(this.serversSection);

    const foundHeader = document.createElement('div');
    foundHeader.className = 'flex items-center justify-between gap-2 mb-1.5';
    const foundLabel = document.createElement('span');
    foundLabel.className = FIELD_LABEL;
    foundLabel.textContent = 'Detected Agents';
    const recheck = document.createElement('button');
    recheck.type = 'button';
    recheck.dataset.ref = 'recheck';
    recheck.className = GHOST_BUTTON;
    recheck.textContent = 'Check again';
    recheck.addEventListener('click', () => void this.detect(true));
    foundHeader.append(foundLabel, recheck);
    this.found = document.createElement('div');
    this.found.dataset.ref = 'found';
    this.found.className = 'flex flex-col gap-2 mb-2';
    root.append(foundHeader, this.found);

    this.sync();
  }

  sync(): void {
    this.draft = { ...agentSettings.current, providers: cloneProviders(agentSettings.current.providers) };
    this.defaultAgent.value = this.draft.defaultAgent ?? '';
    this.permission.value = this.draft.permissionMode;
    this.paintApiKey();
    // Typed keys go with the fields: every open (and Cancel) starts them empty.
    this.paintKeys();
    this.paintServers();
    this.serversError.classList.add('hidden');
    // Each open reads detection (cached by the engine until something changes).
    void this.detect(false);
  }

  isDirty(): boolean {
    return !sameSettings(this.draft, agentSettings.current);
  }

  save(persist: PersistPreference): void {
    // Only the tab's own fields: the model, effort and paths stay as stored
    // (the panel's chips set the first two, perhaps while this tab was open).
    const previous = agentSettings.current;
    const providers = this.draft.providers ?? [];
    const providersChanged = !sameProviders(providers, previous.providers ?? []);
    // A server with no name or a base URL the engine refuses is not saved: its field says why, and the tab stays unsaved.
    const serversValid = providersChanged ? this.validateServers() : true;
    const sendProviders = providersChanged && serversValid;
    const next: AgentPreferences = {
      ...previous,
      defaultAgent: this.draft.defaultAgent,
      permissionMode: this.draft.permissionMode,
    };
    delete next.claudeIgnoreApiKey;
    if (typeof this.draft.claudeIgnoreApiKey === 'boolean') {
      next.claudeIgnoreApiKey = this.draft.claudeIgnoreApiKey;
    }
    if (sendProviders) {
      next.providers = cloneProviders(providers);
      if (next.providers.length === 0) {
        delete next.providers;
      }
    }
    agentSettings.update(next);
    this.draft = { ...next, providers: cloneProviders(sendProviders || !providersChanged ? next.providers : providers) };
    // The engine merges field by field: what is not sent is kept.
    const payload = {
      defaultAgent: next.defaultAgent,
      permissionMode: next.permissionMode,
      // The user's on or off; null goes back to automatic.
      claudeIgnoreApiKey: typeof next.claudeIgnoreApiKey === 'boolean' ? next.claudeIgnoreApiKey : null,
      ...(sendProviders ? { providers: cloneProviders(providers) } : {}),
    } as unknown as AgentPreferences;
    // Keys typed for servers the engine does not know yet: stored once the servers are saved.
    const known = new Set(this.apiProviders().map((p) => p.id));
    const pendingKeys = sendProviders
      ? [...this.serverViews.values()].filter((view) => !known.has(view.id) && view.key.input.value.trim() !== '' && providers.some((p) => p.id === view.id))
      : [];
    const saved = this.deps?.save ? this.deps.save(payload) : Promise.resolve(persist('agent', payload));
    void saved.then(async (ok) => {
      if (ok === false && sendProviders) {
        // The engine refused the servers: they stay as typed, unsaved.
        const current: AgentPreferences = { ...agentSettings.current };
        if (previous.providers?.length) {
          current.providers = cloneProviders(previous.providers);
        } else {
          delete current.providers;
        }
        agentSettings.update(current);
        this.draft.providers = cloneProviders(providers);
        this.showServersError('FluidCAD did not save the local models. Check their base URLs.');
        this.ctx.changed();
        return;
      }
      for (const view of pendingKeys) {
        await view.key.store();
      }
      this.deps?.onSaved?.();
      await this.detect(false);
    });
  }

  // ---------------------------------------------------------------------------
  // API keys
  // ---------------------------------------------------------------------------

  /** The `api` agent's providers as detection last reported them; empty when the engine has no `api` agent. */
  private apiProviders(): ApiProviderStatus[] {
    return this.installs?.find((i) => i.kind === 'api')?.providers ?? [];
  }

  /** One row per built-in provider: where its key comes from, a field to set it, Remove. */
  private paintKeys(): void {
    const api = this.installs?.find((i) => i.kind === 'api') ?? null;
    this.keysSection.classList.toggle('hidden', !api);
    this.keys.replaceChildren();
    const builtIns = this.apiProviders()
      .filter((p) => p.builtIn)
      .sort((a, b) => BUILT_IN_PROVIDERS.indexOf(a.id) - BUILT_IN_PROVIDERS.indexOf(b.id));
    for (const provider of builtIns) {
      const row = document.createElement('div');
      row.dataset.provider = provider.id;
      row.className = 'grid grid-cols-[7rem_1fr] items-center gap-x-2';
      const name = document.createElement('span');
      name.className = 'text-xs text-base-content/80 truncate';
      name.textContent = provider.label;
      const key = this.keyControls(provider.id, provider, false);
      row.append(name, key.el, key.error);
      key.error.classList.add('col-start-2');
      this.keys.appendChild(row);
    }
  }

  /**
   * A provider's key: "Set by VARIABLE" when the environment sets it (no
   * field: it wins anyway); otherwise a password field with Save, and Remove
   * when a key is stored. `status` null: a server the engine does not know
   * yet, whose key the dialog's Save stores after the server. A server's key
   * is optional (a local server needs none).
   */
  private keyControls(id: string, status: ApiProviderStatus | null, server: boolean): KeyControls {
    const el = document.createElement('div');
    el.className = 'flex items-center gap-1.5 min-w-0';
    const error = document.createElement('p');
    error.dataset.ref = 'key-error';
    error.className = `${FIELD_HINT} text-error mt-1 hidden`;
    const input = document.createElement('input');
    const controls: KeyControls = { el, error, input, store: async () => true, refresh: () => undefined };

    if (status?.keySource === 'env') {
      const env = document.createElement('span');
      env.dataset.ref = 'key-env';
      env.className = 'text-xs text-base-content/60';
      env.append(document.createTextNode('Set by '));
      const code = document.createElement('code');
      code.className = 'font-mono';
      code.textContent = status.envVar ?? 'the environment';
      env.appendChild(code);
      el.appendChild(env);
      return controls;
    }

    input.type = 'password';
    input.dataset.ref = 'key-input';
    input.className = KEY_INPUT;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = status?.keySource === 'stored' ? 'Key saved' : server ? 'Optional' : 'Paste a key';
    input.setAttribute('aria-label', `${status?.label ?? 'Server'} API key`);
    el.appendChild(input);

    const fail = (message: string | null) => {
      error.textContent = message ?? '';
      error.classList.toggle('hidden', message === null);
    };
    controls.store = async () => {
      const value = input.value.trim();
      if (value === '' || !this.deps?.setKey) {
        return true;
      }
      setBusy(true);
      const problem = await this.deps.setKey(id, value);
      setBusy(false);
      fail(problem);
      if (problem !== null) {
        return false;
      }
      // Stored: the page keeps no copy.
      input.value = '';
      paintSave();
      await this.keysChanged();
      return true;
    };

    // A server the engine does not know yet has no Save of its own: the dialog's stores it.
    const save = status ? smallButton('Save', 'key-save') : null;
    const remove = status?.keySource === 'stored' ? smallButton('Remove', 'key-remove') : null;
    const setBusy = (busy: boolean) => {
      input.disabled = busy;
      if (remove) {
        remove.disabled = busy;
      }
      if (save) {
        save.disabled = busy || input.value.trim() === '';
      }
    };
    const paintSave = () => {
      if (save) {
        save.disabled = input.value.trim() === '';
      }
    };
    controls.refresh = paintSave;
    input.addEventListener('input', () => {
      paintSave();
      fail(null);
    });
    if (save) {
      paintSave();
      save.addEventListener('click', () => void controls.store());
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void controls.store();
        }
      });
      el.appendChild(save);
    }
    if (remove) {
      remove.addEventListener('click', async () => {
        if (!this.deps?.removeKey) {
          return;
        }
        setBusy(true);
        const problem = await this.deps.removeKey(id);
        setBusy(false);
        fail(problem);
        if (problem === null) {
          await this.keysChanged();
        }
      });
      el.appendChild(remove);
    }
    return controls;
  }

  /** A key was stored or removed: read the providers again, repaint, and let an open panel know. */
  private async keysChanged(): Promise<void> {
    const providers = this.deps?.providers ? await this.deps.providers() : null;
    const api = this.installs?.find((i) => i.kind === 'api');
    if (providers && api) {
      api.providers = providers;
      api.loggedIn = providers.some((p) => p.ready);
      this.paintKeys();
      this.paintServerKeys();
      this.paintFound(this.installs, null);
    } else {
      await this.detect(false);
    }
    this.deps?.onSaved?.();
  }

  // ---------------------------------------------------------------------------
  // Local models (custom OpenAI-compatible servers)
  // ---------------------------------------------------------------------------

  private paintServers(): void {
    this.serverViews.clear();
    this.servers.replaceChildren();
    for (const config of this.draft.providers ?? []) {
      this.mountServer(config);
    }
  }

  /** A server's key controls follow what the engine now says about it (known, key stored). */
  private paintServerKeys(): void {
    for (const view of this.serverViews.values()) {
      const status = this.apiProviders().find((p) => p.id === view.id) ?? null;
      const key = this.keyControls(view.id, status, true);
      // What is typed and a refusal stay through the repaint.
      key.input.value = view.key.input.value;
      key.refresh();
      key.error.textContent = view.key.error.textContent;
      key.error.className = view.key.error.className;
      view.key.el.replaceWith(key.el);
      view.key.error.replaceWith(key.error);
      view.key = key;
    }
  }

  private addServer(preset: (typeof SERVER_PRESETS)[number]): void {
    const taken = new Set([...BUILT_IN_PROVIDERS, ...(this.draft.providers ?? []).map((p) => p.id)]);
    let id: string = preset.id;
    for (let n = 2; taken.has(id); n++) {
      id = `${preset.id}-${n}`;
    }
    const config: AgentProviderConfig = {
      id,
      kind: 'openai-compatible',
      label: id === preset.id ? preset.label : `${preset.label} ${id.slice(preset.id.length + 1)}`,
      baseURL: preset.baseURL,
      images: false,
    };
    this.draft.providers = [...(this.draft.providers ?? []), config];
    const view = this.mountServer(config);
    (preset.baseURL ? view.label : view.url).focus();
    this.ctx.changed();
  }

  /** One server's fields: name, base URL, key, context window, images; and Remove. */
  private mountServer(config: AgentProviderConfig): ServerView {
    const card = document.createElement('div');
    card.dataset.server = config.id;
    card.className = 'rounded border border-base-content/10 px-3 py-2 grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1.5';
    const entry = () => this.draft.providers?.find((p) => p.id === config.id);
    const edit = (apply: (p: AgentProviderConfig) => void) => {
      const current = entry();
      if (current) {
        apply(current);
        this.ctx.changed();
      }
    };

    const label = textInput('server-label', config.label, 'Name');
    label.setAttribute('aria-label', 'Name');
    label.addEventListener('input', () => {
      label.classList.remove('input-error');
      edit((p) => (p.label = label.value));
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.dataset.ref = 'server-remove';
    remove.className = 'btn btn-ghost btn-square btn-xs text-base-content/60 shrink-0 [&>svg]:size-3.5';
    remove.title = 'Remove';
    remove.setAttribute('aria-label', `Remove ${config.label}`);
    remove.innerHTML = ICON_TRASH;
    remove.addEventListener('click', () => {
      this.draft.providers = (this.draft.providers ?? []).filter((p) => p.id !== config.id);
      this.serverViews.delete(config.id);
      card.remove();
      this.ctx.changed();
    });
    const top = document.createElement('div');
    top.className = 'flex items-center gap-1.5 min-w-0';
    top.append(label, remove);

    const url = textInput('server-url', config.baseURL ?? '', 'http://localhost:11434/v1');
    url.setAttribute('aria-label', 'Base URL');
    url.classList.add('font-mono', 'text-xs');
    url.addEventListener('input', () => {
      url.classList.remove('input-error');
      edit((p) => (p.baseURL = url.value.trim()));
    });

    const context = document.createElement('input');
    context.type = 'number';
    context.dataset.ref = 'server-context';
    context.className = 'input input-sm input-bordered w-32';
    context.min = String(CONTEXT_MIN);
    context.max = String(CONTEXT_MAX);
    context.step = '1';
    context.placeholder = 'Tokens';
    context.setAttribute('aria-label', 'Context window');
    context.value = config.contextWindow ? String(config.contextWindow) : '';
    context.addEventListener('input', () => {
      const raw = Number(context.value);
      edit((p) => {
        if (context.value.trim() === '' || !Number.isFinite(raw) || raw <= 0) {
          delete p.contextWindow;
        } else {
          p.contextWindow = Math.round(Math.min(CONTEXT_MAX, Math.max(CONTEXT_MIN, raw)));
        }
      });
    });
    context.addEventListener('change', () => {
      const value = entry()?.contextWindow;
      context.value = value ? String(value) : '';
    });

    const images = document.createElement('input');
    images.type = 'checkbox';
    images.dataset.ref = 'server-images';
    images.className = TOGGLE;
    images.checked = config.images === true;
    images.setAttribute('aria-label', 'Send images');
    images.addEventListener('change', () => edit((p) => (p.images = images.checked)));

    const status = this.apiProviders().find((p) => p.id === config.id) ?? null;
    const key = this.keyControls(config.id, status, true);
    card.append(
      rowLabel('Name'), top,
      rowLabel('Base URL'), url,
      rowLabel('API key'), key.el,
    );
    key.error.classList.add('col-start-2');
    card.append(key.error, rowLabel('Context window'), context, rowLabel('Send images'), images);
    this.servers.appendChild(card);
    const view: ServerView = { id: config.id, card, label, url, key };
    this.serverViews.set(config.id, view);
    return view;
  }

  /** Mark the servers the engine would refuse; true when every one can be saved. */
  private validateServers(): boolean {
    let valid = true;
    for (const config of this.draft.providers ?? []) {
      const view = this.serverViews.get(config.id);
      const badLabel = config.label.trim() === '';
      const badUrl = !isServerUrl(config.baseURL ?? '');
      const badId = !PROVIDER_ID.test(config.id);
      view?.label.classList.toggle('input-error', badLabel);
      view?.url.classList.toggle('input-error', badUrl);
      if (view) {
        view.url.title = badUrl ? 'An http or https address, such as http://localhost:11434/v1' : '';
      }
      valid = valid && !badLabel && !badUrl && !badId;
    }
    this.showServersError(valid ? null : 'Each local model needs a name and an http or https base URL.');
    return valid;
  }

  private showServersError(message: string | null): void {
    this.serversError.textContent = message ?? '';
    this.serversError.classList.toggle('hidden', message === null);
  }

  // ---------------------------------------------------------------------------

  /**
   * The API-key switch as it acts: the user's choice when they made one;
   * otherwise automatic, on when detection found a Claude subscription
   * signed in.
   */
  private paintApiKey(): void {
    const choice = this.draft.claudeIgnoreApiKey;
    const claude = this.installs?.find((i) => i.kind === 'claude') ?? null;
    const explicit = typeof choice === 'boolean';
    this.ignoreApiKey.checked = explicit ? choice : claude?.subscriptionAvailable === true;
  }

  private async detect(fresh: boolean): Promise<void> {
    if (!this.deps) {
      this.paintFound(null, 'This page cannot reach an agent runtime.');
      return;
    }
    if (this.detecting && !fresh) {
      return;
    }
    this.detecting = true;
    if (!this.installs) {
      this.paintFound(null, 'Looking…');
    }
    try {
      const installs = await this.deps.agents(fresh);
      this.installs = installs;
      this.paintFound(installs, installs ? null : 'This engine has no agent runtime.');
      this.paintApiKey();
      this.paintKeys();
      this.serversSection.classList.toggle('hidden', !installs?.some((i) => i.kind === 'api'));
      this.paintServerKeys();
    } finally {
      this.detecting = false;
    }
  }

  private paintFound(installs: AgentInstall[] | null, message: string | null): void {
    this.found.replaceChildren();
    if (!installs) {
      const p = document.createElement('p');
      p.className = FIELD_HINT;
      p.textContent = message ?? '';
      this.found.appendChild(p);
      return;
    }
    for (const install of installs) {
      if (install.kind === 'api') {
        for (const provider of install.providers ?? []) {
          this.found.appendChild(providerRow(provider));
        }
      } else {
        this.found.appendChild(foundRow(install));
      }
    }
  }
}

/** A key's controls: the field (or the variable that sets it), its error line, and storing what is typed. */
type KeyControls = {
  el: HTMLElement;
  error: HTMLParagraphElement;
  input: HTMLInputElement;
  /** PUT the typed key, then empty the field; resolves false when the engine refused it. */
  store(): Promise<boolean>;
  /** Paint Save for what the field holds. */
  refresh(): void;
};

type ServerView = { id: string; card: HTMLElement; label: HTMLInputElement; url: HTMLInputElement; key: KeyControls };

function foundRow(install: AgentInstall): HTMLElement {
  const row = card(NAMES[install.kind], verdictOf(install));
  row.dataset.agent = install.kind;

  const lines: string[] = [];
  if (install.version) {
    lines.push(`Version ${install.version}${install.minVersion ? ` (needs ${install.minVersion} or later)` : ''}`);
  }
  if (install.path) {
    lines.push(install.path);
  }
  if (install.kind === 'claude' && install.authMethod === 'claude.ai') {
    lines.push(install.apiKeyIgnored ? 'Signed in with a Claude subscription; ANTHROPIC_API_KEY is left out.' : 'Signed in with a Claude subscription.');
  } else if (install.kind === 'claude' && install.authMethod === 'api_key') {
    lines.push('Uses the API key in ANTHROPIC_API_KEY.');
  }
  if (install.problem) {
    lines.push(install.problem);
  }
  appendLines(row, lines);
  return row;
}

/** A provider of the `api` agent in Detected Agents: ready or not, and why not. */
function providerRow(provider: ApiProviderStatus): HTMLElement {
  const row = card(provider.label, provider.ready ? { text: 'Ready', tone: 'badge-success' } : { text: 'Not ready', tone: 'badge-ghost' });
  row.dataset.agent = 'api';
  row.dataset.provider = provider.id;
  const lines: string[] = [];
  if (!provider.builtIn && provider.baseURL) {
    lines.push(provider.baseURL);
  }
  if (!provider.ready && provider.problem) {
    lines.push(provider.problem);
  }
  appendLines(row, lines);
  return row;
}

function card(title: string, verdict: { text: string; tone: string }): HTMLElement {
  const row = document.createElement('div');
  row.className = 'rounded border border-base-content/10 px-3 py-2 text-xs';
  const top = document.createElement('div');
  top.className = 'flex items-center gap-2';
  const name = document.createElement('span');
  name.className = 'font-medium text-base-content/90';
  name.textContent = title;
  const badge = document.createElement('span');
  badge.className = `badge badge-xs ${verdict.tone}`;
  badge.dataset.ref = 'verdict';
  badge.textContent = verdict.text;
  top.append(name, badge);
  row.appendChild(top);
  return row;
}

function appendLines(row: HTMLElement, lines: string[]): void {
  for (const text of lines) {
    const p = document.createElement('p');
    p.className = 'text-base-content/60 mt-0.5 break-all';
    p.textContent = text;
    row.appendChild(p);
  }
}

/** Read by its kind: the `api` agent has no program, so no version to judge. */
function verdictOf(install: AgentInstall): { text: string; tone: string } {
  if (install.kind === 'api') {
    return install.loggedIn ? { text: 'Ready', tone: 'badge-success' } : { text: 'Not ready', tone: 'badge-ghost' };
  }
  if (install.minVersion === '') {
    return { text: 'Not supported yet', tone: 'badge-ghost' };
  }
  if (install.supported) {
    return install.loggedIn === false ? { text: 'Not signed in', tone: 'badge-warning' } : { text: 'Ready', tone: 'badge-success' };
  }
  return install.version ? { text: 'Too old', tone: 'badge-warning' } : { text: 'Not found', tone: 'badge-ghost' };
}

function select(options: [string, string][]): HTMLSelectElement {
  const el = document.createElement('select');
  el.className = SELECT;
  for (const [value, label] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    el.appendChild(option);
  }
  return el;
}

function sectionLabel(text: string): HTMLElement {
  const label = document.createElement('div');
  label.className = `${FIELD_LABEL} mb-1.5`;
  label.textContent = text;
  return label;
}

function rowLabel(text: string): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'text-xs text-base-content/70';
  label.textContent = text;
  return label;
}

function smallButton(text: string, ref: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.ref = ref;
  button.className = `${GHOST_BUTTON} border border-base-content/15 shrink-0`;
  button.textContent = text;
  return button;
}

function textInput(ref: string, value: string, placeholder: string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.dataset.ref = ref;
  input.className = `${TEXT_INPUT} min-w-0`;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.placeholder = placeholder;
  input.value = value;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
  });
  return input;
}

function cloneProviders(providers: AgentProviderConfig[] | undefined): AgentProviderConfig[] {
  return (providers ?? []).map((p) => ({ ...p, ...(p.models ? { models: [...p.models] } : {}) }));
}

/** Two server lists alike, field by field (an absent `images` reads as off: the default for these servers). */
function sameProviders(a: AgentProviderConfig[], b: AgentProviderConfig[]): boolean {
  const norm = (list: AgentProviderConfig[]) =>
    JSON.stringify(list.map((p) => [p.id, p.kind, p.label, p.baseURL ?? '', p.models ?? [], p.contextWindow ?? null, p.images === true]));
  return norm(a) === norm(b);
}

function sameSettings(a: AgentPreferences, b: AgentPreferences): boolean {
  return (
    (a.defaultAgent ?? null) === (b.defaultAgent ?? null) &&
    a.permissionMode === b.permissionMode &&
    (a.claudeIgnoreApiKey ?? null) === (b.claudeIgnoreApiKey ?? null) &&
    sameProviders(a.providers ?? [], b.providers ?? [])
  );
}
