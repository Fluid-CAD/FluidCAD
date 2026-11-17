import type { AgentPreferences } from '../../api';
import { CLAUDE_EFFORTS, COMMON_EFFORTS, effortLabel, type AgentInstall, type AgentModel } from '../chat/chat-types';
import { agentSettings, EFFORT_WORD } from './agent-settings';
import {
  FIELD_HINT,
  FIELD_LABEL,
  SELECT,
  field,
  textField,
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
   * detection that follows reads the new paths. Absent: the dialog's
   * fire-and-forget persist.
   */
  save?(value: AgentPreferences): Promise<void>;
  /** The preference is saved: an open Agent panel reads detection again. */
  onSaved?(): void;
  /** The models an agent offers (Codex lists each model's efforts); null when they cannot be read. */
  models?(kind: AgentInstall['kind']): Promise<AgentModel[] | null>;
};

const NAMES: Record<AgentInstall['kind'], string> = { claude: 'Claude Code', codex: 'Codex' };
const CLAUDE_MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];
/** A model alias or full name: what the engine accepts (`AGENT_MODEL_PATTERN`). */
const MODEL_PATTERN = /^[A-Za-z0-9][\w.:@/[\]-]*$/;
/** "Use my Claude subscription even if ANTHROPIC_API_KEY is set" (§19, the owner's wording). */
export const IGNORE_API_KEY_LABEL = 'Use my Claude subscription even if ANTHROPIC_API_KEY is set';

/**
 * Settings → Agent (docs/agent-chat-plan.md §9.3, §10.3): the agent a new
 * chat starts with, where each CLI is when detection misses it, the models,
 * effort, whether edits are asked about, and whether Claude Code may use an
 * inherited ANTHROPIC_API_KEY; under them, what detection found.
 */
export class AgentTab implements SettingsTab {
  readonly id = 'agent';
  readonly label = 'Agent';
  private draft: AgentPreferences = { ...agentSettings.current };
  private defaultAgent!: HTMLSelectElement;
  private claudePath!: HTMLInputElement;
  private codexPath!: HTMLInputElement;
  private claudeModel!: HTMLInputElement;
  private codexModel!: HTMLInputElement;
  private modelHint!: HTMLParagraphElement;
  private claudeEffort!: HTMLSelectElement;
  private codexEffort!: HTMLSelectElement;
  /** Every effort a Codex model lists, once read. */
  private codexEfforts: string[] | null = null;
  private permission!: HTMLSelectElement;
  private ignoreApiKey!: HTMLInputElement;
  private found!: HTMLDivElement;
  private installs: AgentInstall[] | null = null;
  private detecting = false;

  constructor(private readonly deps: AgentTabDeps | null) {}

  mount(root: HTMLElement, ctx: SettingsContext): void {
    const changed = () => {
      this.paintValidity();
      ctx.changed();
    };

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

    this.claudeModel = textField((value) => {
      this.draft.claudeModel = value.trim() || undefined;
      changed();
    }, { placeholder: 'Default', mono: true });
    this.claudeModel.dataset.ref = 'claude-model';
    const aliases = document.createElement('datalist');
    aliases.id = 'fluidcad-agent-claude-models';
    for (const alias of CLAUDE_MODEL_ALIASES) {
      const option = document.createElement('option');
      option.value = alias;
      aliases.appendChild(option);
    }
    this.claudeModel.setAttribute('list', aliases.id);
    const claudeModelField = field('Claude Code model', this.claudeModel, 'An alias (opus, sonnet, haiku, fable) or a full model name. Empty: Claude Code’s own default.');
    claudeModelField.appendChild(aliases);
    this.modelHint = document.createElement('p');
    this.modelHint.className = `${FIELD_HINT} text-error hidden`;
    this.modelHint.dataset.ref = 'model-error';
    claudeModelField.appendChild(this.modelHint);
    root.appendChild(claudeModelField);

    this.codexModel = textField((value) => {
      this.draft.codexModel = value.trim() || undefined;
      changed();
    }, { placeholder: 'Default', mono: true });
    this.codexModel.dataset.ref = 'codex-model';
    root.appendChild(field('Codex model', this.codexModel, 'Empty: Codex’s own default.'));

    this.claudeEffort = select([['', 'Claude Code’s default'], ...CLAUDE_EFFORTS.map((e): [string, string] => [e, effortLabel(e)])]);
    this.claudeEffort.dataset.ref = 'claude-effort';
    this.claudeEffort.addEventListener('change', () => {
      this.draft.claudeEffort = this.claudeEffort.value || undefined;
      changed();
    });
    root.appendChild(field('Claude Code effort', this.claudeEffort, 'How hard the model thinks before it answers. Max is for the hardest questions, and uses your plan fastest.'));

    this.codexEffort = select([]);
    this.codexEffort.dataset.ref = 'codex-effort';
    this.codexEffort.addEventListener('change', () => {
      this.draft.codexEffort = this.codexEffort.value || undefined;
      changed();
    });
    root.appendChild(field('Codex effort', this.codexEffort, 'Each Codex model offers its own levels; a level the chosen model lacks falls back to its default.'));

    this.permission = select([
      ['ask', 'Ask before every change'],
      ['auto-edits', 'Change project files without asking'],
    ]);
    this.permission.dataset.ref = 'permission-mode';
    this.permission.addEventListener('change', () => {
      this.draft.permissionMode = this.permission.value === 'auto-edits' ? 'auto-edits' : 'ask';
      changed();
    });
    root.appendChild(field('Changes to the project', this.permission, 'This version only reads the project; the choice applies once the agent can edit.'));

    const ignore = toggleRow(IGNORE_API_KEY_LABEL, (checked) => {
      this.draft.claudeIgnoreApiKey = checked;
      changed();
    });
    this.ignoreApiKey = ignore.input;
    this.ignoreApiKey.dataset.ref = 'ignore-api-key';
    root.appendChild(ignore.row);
    const ignoreHint = document.createElement('p');
    ignoreHint.className = `${FIELD_HINT} -mt-3 mb-4`;
    ignoreHint.textContent = 'When ANTHROPIC_API_KEY is set, Claude Code uses it (and bills it) over your subscription. On: FluidCAD leaves the key out of Claude Code’s environment.';
    root.appendChild(ignoreHint);

    this.claudePath = textField((value) => {
      this.draft.claudePath = value.trim() || undefined;
      changed();
    }, { placeholder: 'Found automatically', mono: true });
    this.claudePath.dataset.ref = 'claude-path';
    root.appendChild(field('Claude Code program', this.claudePath, 'The absolute path to `claude`, when FluidCAD does not find it by itself.'));

    this.codexPath = textField((value) => {
      this.draft.codexPath = value.trim() || undefined;
      changed();
    }, { placeholder: 'Found automatically', mono: true });
    this.codexPath.dataset.ref = 'codex-path';
    root.appendChild(field('Codex program', this.codexPath, 'The absolute path to `codex`.'));

    const foundHeader = document.createElement('div');
    foundHeader.className = 'flex items-center justify-between gap-2 mb-1.5';
    const foundLabel = document.createElement('span');
    foundLabel.className = FIELD_LABEL;
    foundLabel.textContent = 'What FluidCAD found';
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
    this.claudePath.value = this.draft.claudePath ?? '';
    this.codexPath.value = this.draft.codexPath ?? '';
    this.claudeModel.value = this.draft.claudeModel ?? '';
    this.codexModel.value = this.draft.codexModel ?? '';
    this.claudeEffort.value = this.draft.claudeEffort ?? '';
    this.paintCodexEfforts();
    this.permission.value = this.draft.permissionMode;
    this.ignoreApiKey.checked = this.draft.claudeIgnoreApiKey === true;
    this.paintValidity();
    // Each open reads detection (cached by the engine until something changes).
    void this.detect(false);
    void this.loadCodexEfforts();
  }

  /** The Codex effort picker: the default, then every level a Codex model lists (low, medium, high until they are read). */
  private paintCodexEfforts(): void {
    const levels = [...(this.codexEfforts ?? COMMON_EFFORTS)];
    const stored = this.draft.codexEffort;
    if (stored && !levels.includes(stored)) {
      levels.push(stored);
    }
    this.codexEffort.replaceChildren();
    for (const [value, label] of [['', 'The model’s default'], ...levels.map((e): [string, string] => [e, effortLabel(e)])]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      this.codexEffort.appendChild(option);
    }
    this.codexEffort.value = stored ?? '';
  }

  private async loadCodexEfforts(): Promise<void> {
    if (this.codexEfforts || !this.deps?.models) {
      return;
    }
    const models = await this.deps.models('codex');
    const levels: string[] = [];
    for (const model of models ?? []) {
      for (const effort of model.efforts ?? []) {
        if (EFFORT_WORD.test(effort) && !levels.includes(effort)) {
          levels.push(effort);
        }
      }
    }
    if (levels.length === 0) {
      return;
    }
    this.codexEfforts = levels;
    this.paintCodexEfforts();
  }

  isDirty(): boolean {
    return !sameSettings(this.draft, agentSettings.current);
  }

  save(persist: PersistPreference): void {
    const next: AgentPreferences = { ...this.draft };
    for (const key of ['claudeModel', 'codexModel'] as const) {
      if (next[key] !== undefined && !MODEL_PATTERN.test(next[key]!)) {
        // The engine would refuse it: keep what was there.
        if (agentSettings.current[key] !== undefined) {
          next[key] = agentSettings.current[key];
        } else {
          delete next[key];
        }
      }
    }
    agentSettings.update(next);
    this.draft = { ...next };
    // Every field, cleared ones as empty strings: the engine merges field by field.
    const payload = {
      defaultAgent: next.defaultAgent,
      claudePath: next.claudePath ?? '',
      codexPath: next.codexPath ?? '',
      claudeModel: next.claudeModel ?? '',
      codexModel: next.codexModel ?? '',
      claudeEffort: next.claudeEffort ?? '',
      codexEffort: next.codexEffort ?? '',
      // Each agent has its own now; the older shared one goes.
      effort: '',
      permissionMode: next.permissionMode,
      claudeIgnoreApiKey: next.claudeIgnoreApiKey === true,
    } as unknown as AgentPreferences;
    const saved = this.deps?.save ? this.deps.save(payload) : Promise.resolve(persist('agent', payload));
    void saved.then(() => {
      this.deps?.onSaved?.();
      void this.detect(false);
    });
  }

  private paintValidity(): void {
    const bad = this.draft.claudeModel !== undefined && !MODEL_PATTERN.test(this.draft.claudeModel);
    this.modelHint.textContent = bad ? 'Not a model name: use letters, digits and . _ - : / @ [ ], no spaces.' : '';
    this.modelHint.classList.toggle('hidden', !bad);
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
    lines.push('Signed in with a Claude subscription.');
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
    (a.claudePath ?? '') === (b.claudePath ?? '') &&
    (a.codexPath ?? '') === (b.codexPath ?? '') &&
    (a.claudeModel ?? '') === (b.claudeModel ?? '') &&
    (a.codexModel ?? '') === (b.codexModel ?? '') &&
    (a.claudeEffort ?? '') === (b.claudeEffort ?? '') &&
    (a.codexEffort ?? '') === (b.codexEffort ?? '') &&
    a.permissionMode === b.permissionMode &&
    (a.claudeIgnoreApiKey === true) === (b.claudeIgnoreApiKey === true)
  );
}
