import type { AgentPreferences, AgentProviderConfig, UserPreferences } from '../../api';
import { BUILT_IN_PROVIDERS, CLAUDE_EFFORTS, providerOf, type AgentKind } from '../chat/chat-types';

export { BUILT_IN_PROVIDERS } from '../chat/chat-types';

/** A Codex reasoning effort word (the engine's `AGENT_EFFORT_PATTERN`). */
export const EFFORT_WORD = /^[a-z][a-z0-9-]{0,23}$/;

/** A custom provider's id (§20.2): also the first part of its models' ids. */
export const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Whether `url` is a base URL the engine takes for a custom server: http or https. */
export function isServerUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The custom servers of a stored `agent.providers`, read defensively; anything malformed is left out. */
export function readProviders(stored: unknown): AgentProviderConfig[] {
  if (!Array.isArray(stored)) {
    return [];
  }
  const out: AgentProviderConfig[] = [];
  const ids = new Set<string>(BUILT_IN_PROVIDERS);
  for (const entry of stored) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const e = entry as Record<string, unknown>;
    // A slug, not a built-in's id and not one seen before.
    if (typeof e.id !== 'string' || !PROVIDER_ID.test(e.id) || ids.has(e.id) || e.kind !== 'openai-compatible') {
      continue;
    }
    ids.add(e.id);
    const config: AgentProviderConfig = {
      id: e.id,
      kind: 'openai-compatible',
      label: typeof e.label === 'string' && e.label.trim() !== '' ? e.label : e.id,
    };
    if (typeof e.baseURL === 'string') {
      config.baseURL = e.baseURL;
    }
    if (Array.isArray(e.models) && e.models.every((m) => typeof m === 'string')) {
      config.models = [...(e.models as string[])];
    }
    if (typeof e.contextWindow === 'number' && Number.isFinite(e.contextWindow) && e.contextWindow > 0) {
      config.contextWindow = Math.round(e.contextWindow);
    }
    if (typeof e.images === 'boolean') {
      config.images = e.images;
    }
    out.push(config);
  }
  return out;
}

/**
 * The `agent` preference as applied (docs/agent-chat-plan.md §9.3, §19 and
 * §20.4). The engine acts on the paths, the API-key choice and the custom
 * servers (detection, the CLI's environment, the `api` agent's providers);
 * the panel reads the rest (the agent a new chat starts with, the models,
 * effort, the permission mode). Settings → Agent edits the agent, the
 * permission mode, the API-key choice and the servers; the panel's chips set
 * the model and effort ({@link rememberModel}, {@link rememberEffort}). No
 * API key is ever here. Listeners hear every update, so an open panel follows
 * a save or a reset.
 */
export const DEFAULT_AGENT_PREFERENCES: AgentPreferences = { defaultAgent: null, permissionMode: 'ask' };

class AgentSettingsStore {
  current: AgentPreferences = { ...DEFAULT_AGENT_PREFERENCES };
  private readonly listeners = new Set<(settings: AgentPreferences) => void>();

  update(next: AgentPreferences): void {
    this.current = { ...next };
    for (const listener of [...this.listeners]) {
      listener(this.current);
    }
  }

  subscribe(listener: (settings: AgentPreferences) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const agentSettings = new AgentSettingsStore();

/** The stored `agent` preference, read defensively (an older file has none). */
export function applyAgentPreferences(prefs: UserPreferences): void {
  const stored = prefs.agent;
  const next: AgentPreferences = { ...DEFAULT_AGENT_PREFERENCES };
  if (stored && typeof stored === 'object') {
    if (stored.defaultAgent === 'claude' || stored.defaultAgent === 'codex' || stored.defaultAgent === 'api') {
      next.defaultAgent = stored.defaultAgent;
    }
    if (typeof stored.apiModel === 'string' && providerOf(stored.apiModel)) {
      next.apiModel = stored.apiModel;
    }
    if (typeof stored.apiEffort === 'string' && EFFORT_WORD.test(stored.apiEffort)) {
      next.apiEffort = stored.apiEffort;
    }
    const providers = readProviders(stored.providers);
    if (providers.length > 0) {
      next.providers = providers;
    }
    for (const key of ['claudePath', 'codexPath', 'claudeModel', 'codexModel'] as const) {
      if (typeof stored[key] === 'string' && stored[key] !== '') {
        next[key] = stored[key];
      }
    }
    // Each agent's own effort; the older shared one stands in for both.
    const legacy = stored.effort === 'low' || stored.effort === 'medium' || stored.effort === 'high' ? stored.effort : undefined;
    const claudeEffort = typeof stored.claudeEffort === 'string' && CLAUDE_EFFORTS.includes(stored.claudeEffort) ? stored.claudeEffort : legacy;
    const codexEffort = typeof stored.codexEffort === 'string' && EFFORT_WORD.test(stored.codexEffort) ? stored.codexEffort : legacy;
    if (claudeEffort) {
      next.claudeEffort = claudeEffort;
    }
    if (codexEffort) {
      next.codexEffort = codexEffort;
    }
    if (stored.permissionMode === 'auto-edits') {
      next.permissionMode = 'auto-edits';
    }
    // On, off, or (absent) automatic: an explicit off is not the same as none.
    if (typeof stored.claudeIgnoreApiKey === 'boolean') {
      next.claudeIgnoreApiKey = stored.claudeIgnoreApiKey;
    }
  }
  agentSettings.update(next);
}

/** The fields of the `agent` preference to send; an empty string clears one (the engine merges field by field). */
export type AgentPreferencePatch = Partial<Record<'claudeModel' | 'codexModel' | 'apiModel' | 'claudeEffort' | 'codexEffort' | 'apiEffort' | 'effort', string>>;

const MODEL_KEY = { claude: 'claudeModel', codex: 'codexModel', api: 'apiModel' } as const;
const EFFORT_KEY = { claude: 'claudeEffort', codex: 'codexEffort', api: 'apiEffort' } as const;

/**
 * The model picked on the Agent panel's chip, kept as `kind`'s default for
 * new chats (`default`: the program's own). For `api` it carries the
 * provider, so new chats also start on that provider. Updates the store and
 * returns what to persist.
 */
export function rememberModel(kind: AgentKind, model: string): AgentPreferencePatch {
  const key = MODEL_KEY[kind];
  const next: AgentPreferences = { ...agentSettings.current };
  if (model === 'default' || model === '') {
    delete next[key];
  } else {
    next[key] = model;
  }
  agentSettings.update(next);
  return { [key]: next[key] ?? '' };
}

/**
 * The effort picked on the Agent panel's chip, kept as `kind`'s default for
 * new chats (`''`: the program's own). Updates the store and returns what to
 * persist: for Claude Code and Codex both their own efforts, so the older
 * shared `effort` they were read from can go without changing the other's.
 */
export function rememberEffort(kind: AgentKind, effort: string): AgentPreferencePatch {
  const key = EFFORT_KEY[kind];
  const next: AgentPreferences = { ...agentSettings.current };
  if (effort === '') {
    delete next[key];
  } else {
    next[key] = effort;
  }
  agentSettings.update(next);
  if (kind === 'api') {
    return { apiEffort: next.apiEffort ?? '' };
  }
  return { claudeEffort: next.claudeEffort ?? '', codexEffort: next.codexEffort ?? '', effort: '' };
}
