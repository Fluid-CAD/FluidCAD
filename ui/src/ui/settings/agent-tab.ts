import type { AgentPreferences } from '../../api';
import type { AgentInstall } from '../chat/chat-types';
import { PERMISSION_MODES } from '../chat/permission-modes';
import { agentSettings } from './agent-settings';
import {
  FIELD_HINT,
  FIELD_LABEL,
  SELECT,
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
   * detection that follows reads the new API-key choice. Absent: the dialog's
   * fire-and-forget persist.
   */
  save?(value: AgentPreferences): Promise<void>;
  /** The preference is saved: an open Agent panel reads detection again. */
  onSaved?(): void;
};

const NAMES: Record<AgentInstall['kind'], string> = { claude: 'Claude Code', codex: 'Codex', api: 'API' };
/** "Use my Claude subscription even if ANTHROPIC_API_KEY is set" (§19, the owner's wording). */
export const IGNORE_API_KEY_LABEL = 'Use my Claude subscription even if ANTHROPIC_API_KEY is set';

/**
 * Settings → Agent (docs/agent-chat-plan.md §9.3, §10.3): the agent a new
 * chat starts with, whether edits are asked about, and whether Claude Code
 * may use an inherited ANTHROPIC_API_KEY; under them, Detected Agents. The
 * model and effort are picked with the Agent panel's chips; the program
 * paths (`claudePath`, `codexPath`) are still read but not edited here.
 */
export class AgentTab implements SettingsTab {
  readonly id = 'agent';
  readonly label = 'Agent';
  private draft: AgentPreferences = { ...agentSettings.current };
  private defaultAgent!: HTMLSelectElement;
  private permission!: HTMLSelectElement;
  private ignoreApiKey!: HTMLInputElement;
  private found!: HTMLDivElement;
  private installs: AgentInstall[] | null = null;
  private detecting = false;

  constructor(private readonly deps: AgentTabDeps | null) {}

  mount(root: HTMLElement, ctx: SettingsContext): void {
    const changed = () => ctx.changed();

    this.defaultAgent = select([
      ['', 'The first one ready'],
      ['claude', 'Claude Code'],
      ['codex', 'Codex'],
    ]);
    this.defaultAgent.dataset.ref = 'default-agent';
    this.defaultAgent.addEventListener('change', () => {
      const value = this.defaultAgent.value;
      this.draft.defaultAgent = value === 'claude' || value === 'codex' ? value : null;
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

    const foundHeader = document.createElement('div');
    foundHeader.className = 'flex items-center justify-between gap-2 mb-1.5';
    const foundLabel = document.createElement('span');
    foundLabel.className = FIELD_LABEL;
    foundLabel.textContent = 'Detected Agents';
    const recheck = document.createElement('button');
    recheck.type = 'button';
    recheck.dataset.ref = 'recheck';
    recheck.className = 'btn btn-xs btn-ghost';
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
    this.draft = { ...agentSettings.current };
    this.defaultAgent.value = this.draft.defaultAgent ?? '';
    this.permission.value = this.draft.permissionMode;
    this.paintApiKey();
    // Each open reads detection (cached by the engine until something changes).
    void this.detect(false);
  }

  isDirty(): boolean {
    return !sameSettings(this.draft, agentSettings.current);
  }

  save(persist: PersistPreference): void {
    // Only the tab's own fields: the model, effort and paths stay as stored
    // (the panel's chips set the first two, perhaps while this tab was open).
    const next: AgentPreferences = {
      ...agentSettings.current,
      defaultAgent: this.draft.defaultAgent,
      permissionMode: this.draft.permissionMode,
    };
    delete next.claudeIgnoreApiKey;
    if (typeof this.draft.claudeIgnoreApiKey === 'boolean') {
      next.claudeIgnoreApiKey = this.draft.claudeIgnoreApiKey;
    }
    agentSettings.update(next);
    this.draft = { ...next };
    // The engine merges field by field: what is not sent is kept.
    const payload = {
      defaultAgent: next.defaultAgent,
      permissionMode: next.permissionMode,
      // The user's on or off; null goes back to automatic.
      claudeIgnoreApiKey: typeof next.claudeIgnoreApiKey === 'boolean' ? next.claudeIgnoreApiKey : null,
    } as unknown as AgentPreferences;
    const saved = this.deps?.save ? this.deps.save(payload) : Promise.resolve(persist('agent', payload));
    void saved.then(() => {
      this.deps?.onSaved?.();
      void this.detect(false);
    });
  }

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
      this.found.appendChild(foundRow(install));
    }
  }
}

function foundRow(install: AgentInstall): HTMLElement {
  const row = document.createElement('div');
  row.className = 'rounded border border-base-content/10 px-3 py-2 text-xs';
  row.dataset.agent = install.kind;
  const top = document.createElement('div');
  top.className = 'flex items-center gap-2';
  const name = document.createElement('span');
  name.className = 'font-medium text-base-content/90';
  name.textContent = NAMES[install.kind];
  const badge = document.createElement('span');
  const verdict = verdictOf(install);
  badge.className = `badge badge-xs ${verdict.tone}`;
  badge.dataset.ref = 'verdict';
  badge.textContent = verdict.text;
  top.append(name, badge);
  row.appendChild(top);

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
  for (const text of lines) {
    const p = document.createElement('p');
    p.className = 'text-base-content/60 mt-0.5 break-all';
    p.textContent = text;
    row.appendChild(p);
  }
  return row;
}

function verdictOf(install: AgentInstall): { text: string; tone: string } {
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

function sameSettings(a: AgentPreferences, b: AgentPreferences): boolean {
  return (
    (a.defaultAgent ?? null) === (b.defaultAgent ?? null) &&
    a.permissionMode === b.permissionMode &&
    (a.claudeIgnoreApiKey ?? null) === (b.claudeIgnoreApiKey ?? null)
  );
}
