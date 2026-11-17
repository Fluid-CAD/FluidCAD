// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from '../src/ui/settings/settings-modal';
import { agentSettings, applyAgentPreferences, DEFAULT_AGENT_PREFERENCES } from '../src/ui/settings/agent-settings';
import { IGNORE_API_KEY_LABEL } from '../src/ui/settings/agent-tab';
import type { AgentInstall, AgentModel } from '../src/ui/chat/chat-types';
import type { AgentPreferences, UserPreferences } from '../src/api';
import { settle } from './fixtures/fake-packages-client';

// Settings → Agent (docs/agent-chat-plan.md §9.3, §19): the agent for new
// chats, the program paths, the models, effort, the permission mode and the
// subscription-over-API-key choice, saved as the one `agent` preference with
// cleared fields sent empty (the engine merges field by field); under them,
// what detection found.

const CLAUDE: AgentInstall = {
  kind: 'claude', path: '/home/u/.local/bin/claude', version: '2.1.326', minVersion: '2.1.259',
  supported: true, loggedIn: true, authMethod: 'api_key',
};
const CODEX: AgentInstall = {
  kind: 'codex', path: null, version: null, minVersion: '', supported: false, loggedIn: null, authMethod: null,
  problem: 'Codex is not supported by this version of FluidCAD yet.',
};

afterEach(() => {
  document.body.innerHTML = '';
  agentSettings.update({ ...DEFAULT_AGENT_PREFERENCES });
});

function mount(codexModels: AgentModel[] | null = null) {
  const savePreference = vi.fn();
  const save = vi.fn(async (_value: AgentPreferences) => undefined);
  const onSaved = vi.fn();
  const agents = vi.fn(async (_fresh: boolean) => [CLAUDE, CODEX]);
  const models = vi.fn(async (_kind: string) => codexModels);
  const modal = new SettingsModal(document.body, {
    savePreference,
    resetPreferences: async () => null,
    applyPreferences: () => undefined,
    agent: { agents, save, onSaved, models },
  });
  const overlay = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
  const panel = overlay.querySelector<HTMLElement>('[data-panel="agent"]')!;
  const $ = <T extends Element = HTMLElement>(selector: string) => panel.querySelector<T>(selector)!;
  return { modal, overlay, panel, $, save, onSaved, agents, savePreference };
}

describe('Settings → Agent', () => {
  it('reads the stored preference, shows what detection found, and saves every field in one key', async () => {
    applyAgentPreferences({ agent: { defaultAgent: 'claude', claudePath: '/opt/claude', claudeModel: 'opus', permissionMode: 'ask' } } as UserPreferences);
    const h = mount();
    h.modal.show('agent');
    await settle();
    expect(h.$<HTMLSelectElement>('[data-ref="default-agent"]').value).toBe('claude');
    expect(h.$<HTMLInputElement>('[data-ref="claude-path"]').value).toBe('/opt/claude');
    expect(h.$<HTMLInputElement>('[data-ref="claude-model"]').value).toBe('opus');
    expect(h.$<HTMLSelectElement>('[data-ref="permission-mode"]').value).toBe('ask');
    expect(h.panel.textContent).toContain(IGNORE_API_KEY_LABEL);

    const found = h.$('[data-ref="found"]');
    expect(found.querySelector('[data-agent="claude"] [data-ref="verdict"]')!.textContent).toBe('Ready');
    expect(found.querySelector('[data-agent="claude"]')!.textContent).toContain('Uses the API key in ANTHROPIC_API_KEY.');
    expect(found.querySelector('[data-agent="codex"] [data-ref="verdict"]')!.textContent).toBe('Not supported yet');

    // Clear the path, keep the subscription over the key, change the model.
    const path = h.$<HTMLInputElement>('[data-ref="claude-path"]');
    path.value = '';
    path.dispatchEvent(new Event('input'));
    const ignore = h.$<HTMLInputElement>('[data-ref="ignore-api-key"]');
    ignore.checked = true;
    ignore.dispatchEvent(new Event('change'));
    const model = h.$<HTMLInputElement>('[data-ref="claude-model"]');
    model.value = 'sonnet';
    model.dispatchEvent(new Event('input'));
    h.overlay.querySelector<HTMLButtonElement>('[data-ref="save"]')!.click();
    await settle();
    expect(h.save).toHaveBeenCalledWith({
      defaultAgent: 'claude', claudePath: '', codexPath: '', claudeModel: 'sonnet', codexModel: '',
      claudeEffort: '', codexEffort: '', effort: '', permissionMode: 'ask', claudeIgnoreApiKey: true,
    });
    expect(h.onSaved).toHaveBeenCalledTimes(1);
    expect(agentSettings.current).toMatchObject({ claudeModel: 'sonnet', claudeIgnoreApiKey: true });
    expect(agentSettings.current.claudePath).toBeUndefined();
  });

  it('flags a model name the engine would refuse and keeps the old one', async () => {
    applyAgentPreferences({ agent: { defaultAgent: null, claudeModel: 'opus', permissionMode: 'ask' } } as UserPreferences);
    const h = mount();
    h.modal.show('agent');
    const model = h.$<HTMLInputElement>('[data-ref="claude-model"]');
    model.value = 'not a model';
    model.dispatchEvent(new Event('input'));
    expect(h.$('[data-ref="model-error"]').classList.contains('hidden')).toBe(false);
    h.overlay.querySelector<HTMLButtonElement>('[data-ref="save"]')!.click();
    await settle();
    expect(h.save.mock.calls[0][0].claudeModel).toBe('opus');
  });

  it("offers each agent's own effort levels: Claude Code's --effort choices, every level a Codex model lists", async () => {
    applyAgentPreferences({ agent: { defaultAgent: null, permissionMode: 'ask', effort: 'high' } } as UserPreferences);
    const h = mount([
      { id: 'default', label: 'Default' },
      { id: 'gpt-luna', label: 'Luna', isDefault: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'gpt-terra', label: 'Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    ]);
    h.modal.show('agent');
    await settle();
    const claude = h.$<HTMLSelectElement>('[data-ref="claude-effort"]');
    const codex = h.$<HTMLSelectElement>('[data-ref="codex-effort"]');
    expect([...claude.options].map((o) => o.textContent)).toEqual(['Claude Code’s default', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
    expect([...codex.options].map((o) => o.value)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    // The older shared effort stands in for both until each has its own.
    expect(claude.value).toBe('high');
    expect(codex.value).toBe('high');

    claude.value = 'max';
    claude.dispatchEvent(new Event('change'));
    codex.value = 'ultra';
    codex.dispatchEvent(new Event('change'));
    h.overlay.querySelector<HTMLButtonElement>('[data-ref="save"]')!.click();
    await settle();
    expect(h.save.mock.calls[0][0]).toMatchObject({ claudeEffort: 'max', codexEffort: 'ultra', effort: '' });
    expect(agentSettings.current).toMatchObject({ claudeEffort: 'max', codexEffort: 'ultra' });
  });

  it('Check again detects afresh', async () => {
    const h = mount();
    h.modal.show('agent');
    await settle();
    h.$<HTMLButtonElement>('[data-ref="recheck"]').click();
    await settle();
    expect(h.agents).toHaveBeenLastCalledWith(true);
  });
});
