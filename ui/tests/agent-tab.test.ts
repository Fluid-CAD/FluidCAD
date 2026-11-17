// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from '../src/ui/settings/settings-modal';
import { agentSettings, applyAgentPreferences, DEFAULT_AGENT_PREFERENCES, rememberEffort, rememberModel } from '../src/ui/settings/agent-settings';
import { IGNORE_API_KEY_LABEL } from '../src/ui/settings/agent-tab';
import type { AgentInstall } from '../src/ui/chat/chat-types';
import type { AgentPreferences, UserPreferences } from '../src/api';
import { settle } from './fixtures/fake-packages-client';

// Settings → Agent (docs/agent-chat-plan.md §9.3, §19): the agent for new
// chats, the permission mode and the subscription-over-API-key choice, saved
// in the one `agent` preference (the engine merges field by field, so the
// model, effort and paths it does not send stay); under them, Detected Agents.
// The model and effort are picked with the Agent panel's chips.

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

function mount(claude: AgentInstall = CLAUDE) {
  const savePreference = vi.fn();
  const save = vi.fn(async (_value: AgentPreferences) => undefined);
  const onSaved = vi.fn();
  const agents = vi.fn(async (_fresh: boolean) => [claude, CODEX]);
  const modal = new SettingsModal(document.body, {
    savePreference,
    resetPreferences: async () => null,
    applyPreferences: () => undefined,
    agent: { agents, save, onSaved },
  });
  const overlay = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
  const panel = overlay.querySelector<HTMLElement>('[data-panel="agent"]')!;
  const $ = <T extends Element = HTMLElement>(selector: string) => panel.querySelector<T>(selector)!;
  return { modal, overlay, panel, $, save, onSaved, agents, savePreference };
}

describe('Settings → Agent', () => {
  it('reads the stored preference, shows Detected Agents, and saves its own fields in one key', async () => {
    applyAgentPreferences({
      agent: { defaultAgent: 'claude', claudePath: '/opt/claude', claudeModel: 'opus', claudeEffort: 'max', permissionMode: 'ask' },
    } as UserPreferences);
    const h = mount();
    h.modal.show('agent');
    await settle();
    expect(h.$<HTMLSelectElement>('[data-ref="default-agent"]').value).toBe('claude');
    expect(h.$<HTMLSelectElement>('[data-ref="permission-mode"]').value).toBe('ask');
    // The panel's words for the two modes; nothing says the agent only reads.
    expect([...h.$<HTMLSelectElement>('[data-ref="permission-mode"]').options].map((o) => o.textContent)).toEqual([
      'Ask before edits',
      'Apply edits automatically',
    ]);
    expect(h.panel.textContent).not.toMatch(/only reads the project/);
    expect(h.panel.textContent).toContain(IGNORE_API_KEY_LABEL);
    // No model, effort or program fields: the chips pick the first two.
    for (const ref of ['claude-model', 'codex-model', 'claude-effort', 'codex-effort', 'claude-path', 'codex-path', 'model-error']) {
      expect(h.panel.querySelector(`[data-ref="${ref}"]`)).toBeNull();
    }
    expect(h.panel.querySelectorAll('input[type="text"], datalist')).toHaveLength(0);
    expect(h.panel.textContent).not.toMatch(/model|effort|program/i);

    expect(h.panel.textContent).toContain('Detected Agents');
    expect(h.panel.textContent).not.toContain('What FluidCAD found');
    const found = h.$('[data-ref="found"]');
    expect(found.querySelector('[data-agent="claude"] [data-ref="verdict"]')!.textContent).toBe('Ready');
    expect(found.querySelector('[data-agent="claude"]')!.textContent).toContain('Version 2.1.326');
    expect(found.querySelector('[data-agent="claude"]')!.textContent).toContain('/home/u/.local/bin/claude');
    expect(found.querySelector('[data-agent="claude"]')!.textContent).toContain('Uses the API key in ANTHROPIC_API_KEY.');
    expect(found.querySelector('[data-agent="codex"] [data-ref="verdict"]')!.textContent).toBe('Not supported yet');

    // Change the agent and keep the subscription over the key.
    const agent = h.$<HTMLSelectElement>('[data-ref="default-agent"]');
    agent.value = 'codex';
    agent.dispatchEvent(new Event('change'));
    const ignore = h.$<HTMLInputElement>('[data-ref="ignore-api-key"]');
    ignore.checked = true;
    ignore.dispatchEvent(new Event('change'));
    h.overlay.querySelector<HTMLButtonElement>('[data-ref="save"]')!.click();
    await settle();
    // Only the tab's fields: what it does not send, the engine keeps.
    expect(h.save).toHaveBeenCalledWith({ defaultAgent: 'codex', permissionMode: 'ask', claudeIgnoreApiKey: true });
    expect(h.onSaved).toHaveBeenCalledTimes(1);
    expect(agentSettings.current).toMatchObject({
      defaultAgent: 'codex', claudeIgnoreApiKey: true, claudePath: '/opt/claude', claudeModel: 'opus', claudeEffort: 'max',
    });
  });

  it('keeps a model or effort picked on a chip while the tab was open', async () => {
    applyAgentPreferences({ agent: { defaultAgent: null, claudeModel: 'opus', permissionMode: 'ask' } } as UserPreferences);
    const h = mount();
    h.modal.show('agent');
    await settle();
    // The panel's chip, meanwhile.
    agentSettings.update({ ...agentSettings.current, claudeModel: 'sonnet', codexEffort: 'high' });
    const mode = h.$<HTMLSelectElement>('[data-ref="permission-mode"]');
    mode.value = 'auto-edits';
    mode.dispatchEvent(new Event('change'));
    h.overlay.querySelector<HTMLButtonElement>('[data-ref="save"]')!.click();
    await settle();
    expect(h.save.mock.calls[0][0]).toEqual({ defaultAgent: null, permissionMode: 'auto-edits', claudeIgnoreApiKey: null });
    expect(agentSettings.current).toMatchObject({ claudeModel: 'sonnet', codexEffort: 'high', permissionMode: 'auto-edits' });
  });

  describe('the API-key switch', () => {
    const SUBSCRIBED: AgentInstall = { ...CLAUDE, authMethod: 'claude.ai', apiKeyPresent: true, subscriptionAvailable: true, apiKeyIgnored: true };
    const NO_SUBSCRIPTION: AgentInstall = { ...CLAUDE, authMethod: 'api_key', apiKeyPresent: true, subscriptionAvailable: false, apiKeyIgnored: false };

    const mountWith = (claude: AgentInstall) => mount(claude);
    const note = (h: ReturnType<typeof mount>) => h.$('[data-ref="ignore-api-key-note"]');
    const auto = (h: ReturnType<typeof mount>) => h.$<HTMLButtonElement>('[data-ref="ignore-api-key-auto"]');

    it('is on by itself when a subscription is signed in, and says why', async () => {
      applyAgentPreferences({ agent: { defaultAgent: null, permissionMode: 'ask' } } as UserPreferences);
      const h = mountWith(SUBSCRIBED);
      h.modal.show('agent');
      await settle();
      expect(h.$<HTMLInputElement>('[data-ref="ignore-api-key"]').checked).toBe(true);
      expect(note(h).dataset.state).toBe('automatic');
      expect(note(h).textContent).toBe('Automatic: on because a Claude subscription is signed in.');
      expect(auto(h).classList.contains('hidden')).toBe(true);
      expect(h.$('[data-ref="found"] [data-agent="claude"]').textContent).toContain('ANTHROPIC_API_KEY is left out');
    });

    it('is off by itself when no subscription is signed in', async () => {
      applyAgentPreferences({ agent: { defaultAgent: null, permissionMode: 'ask' } } as UserPreferences);
      const h = mountWith(NO_SUBSCRIPTION);
      h.modal.show('agent');
      await settle();
      expect(h.$<HTMLInputElement>('[data-ref="ignore-api-key"]').checked).toBe(false);
      expect(note(h).textContent).toBe('Automatic: off because no Claude subscription is signed in.');
    });

    it('shows an explicit choice over detection, saves a toggle as a choice, and goes back to automatic', async () => {
      applyAgentPreferences({ agent: { defaultAgent: null, permissionMode: 'ask', claudeIgnoreApiKey: false } } as UserPreferences);
      expect(agentSettings.current.claudeIgnoreApiKey).toBe(false);
      const h = mountWith(SUBSCRIBED);
      h.modal.show('agent');
      await settle();
      const box = h.$<HTMLInputElement>('[data-ref="ignore-api-key"]');
      expect(box.checked).toBe(false);
      expect(note(h).dataset.state).toBe('explicit');
      expect(note(h).textContent).toBe('Off: your choice.');
      expect(auto(h).classList.contains('hidden')).toBe(false);

      // "Use automatic": the switch follows detection again, and saves as null (cleared).
      auto(h).click();
      expect(box.checked).toBe(true);
      expect(note(h).textContent).toBe('Automatic: on because a Claude subscription is signed in.');
      h.overlay.querySelector<HTMLButtonElement>('[data-ref="save"]')!.click();
      await settle();
      expect(h.save.mock.calls[0][0]).toMatchObject({ claudeIgnoreApiKey: null });
      expect('claudeIgnoreApiKey' in agentSettings.current).toBe(false);

      // Toggling writes an explicit choice, even the value automatic would give.
      box.checked = false;
      box.dispatchEvent(new Event('change'));
      expect(note(h).textContent).toBe('Off: your choice.');
      h.overlay.querySelector<HTMLButtonElement>('[data-ref="save"]')!.click();
      await settle();
      expect(h.save.mock.calls[1][0]).toMatchObject({ claudeIgnoreApiKey: false });
      expect(agentSettings.current.claudeIgnoreApiKey).toBe(false);
    });

    it('an untouched automatic switch saves as automatic', async () => {
      applyAgentPreferences({ agent: { defaultAgent: null, permissionMode: 'ask' } } as UserPreferences);
      const h = mountWith(SUBSCRIBED);
      h.modal.show('agent');
      await settle();
      const agent = h.$<HTMLSelectElement>('[data-ref="default-agent"]');
      agent.value = 'claude';
      agent.dispatchEvent(new Event('change'));
      h.overlay.querySelector<HTMLButtonElement>('[data-ref="save"]')!.click();
      await settle();
      expect(h.save.mock.calls[0][0]).toMatchObject({ defaultAgent: 'claude', claudeIgnoreApiKey: null });
    });
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

describe("the chips' model and effort, kept for new chats", () => {
  it("a model is the agent's default; Default clears it", () => {
    applyAgentPreferences({ agent: { defaultAgent: null, permissionMode: 'ask', codexModel: 'gpt-luna' } } as UserPreferences);
    expect(rememberModel('claude', 'sonnet')).toEqual({ claudeModel: 'sonnet' });
    expect(agentSettings.current).toMatchObject({ claudeModel: 'sonnet', codexModel: 'gpt-luna' });
    expect(rememberModel('codex', 'default')).toEqual({ codexModel: '' });
    expect('codexModel' in agentSettings.current).toBe(false);
    expect(agentSettings.current.claudeModel).toBe('sonnet');
  });

  it("an effort is the agent's own, and the older shared one it stood in for is written out for the other", () => {
    // Stored before per-agent efforts: one "high" for both.
    applyAgentPreferences({ agent: { defaultAgent: null, permissionMode: 'ask', effort: 'high' } } as UserPreferences);
    expect(rememberEffort('claude', 'max')).toEqual({ claudeEffort: 'max', codexEffort: 'high', effort: '' });
    expect(agentSettings.current).toMatchObject({ claudeEffort: 'max', codexEffort: 'high' });
    // Default effort clears the agent's own.
    expect(rememberEffort('codex', '')).toEqual({ claudeEffort: 'max', codexEffort: '', effort: '' });
    expect('codexEffort' in agentSettings.current).toBe(false);
  });
});
