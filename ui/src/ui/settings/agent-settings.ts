import type { AgentPreferences, UserPreferences } from '../../api';
import { CLAUDE_EFFORTS } from '../chat/chat-types';

/** A Codex reasoning effort word (the engine's `AGENT_EFFORT_PATTERN`). */
export const EFFORT_WORD = /^[a-z][a-z0-9-]{0,23}$/;

/**
 * Settings → Agent as applied (the `agent` preference, docs/agent-chat-plan.md
 * §9.3 and §19). The engine acts on the paths and the API-key choice
 * (detection, the CLI's environment); the panel reads the rest (the agent a
 * new chat starts with, the models, effort, the permission mode). Listeners
 * hear every update, so an open panel follows a save or a reset.
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
    if (stored.defaultAgent === 'claude' || stored.defaultAgent === 'codex') {
      next.defaultAgent = stored.defaultAgent;
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
