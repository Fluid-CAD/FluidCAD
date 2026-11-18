// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from '../src/ui/settings/settings-modal';
import { agentSettings, applyAgentPreferences, DEFAULT_AGENT_PREFERENCES, rememberEffort, rememberModel } from '../src/ui/settings/agent-settings';
import { IGNORE_API_KEY_LABEL } from '../src/ui/settings/agent-tab';
import type { AgentInstall, ApiProviderStatus } from '../src/ui/chat/chat-types';
import type { AgentPreferences, UserPreferences } from '../src/api';
import { settle } from './fixtures/fake-packages-client';
import { FakeChatClient } from './fixtures/fake-chat-client';

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
    // ("Local models" are the API agent's servers, not a model to pick.)
    expect([...h.panel.querySelectorAll('label')].map((l) => l.textContent)).not.toContainEqual(expect.stringMatching(/model|effort|program/i));

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

    it('is on by itself when a subscription is signed in, with no extra state line or link', async () => {
      applyAgentPreferences({ agent: { defaultAgent: null, permissionMode: 'ask' } } as UserPreferences);
      const h = mountWith(SUBSCRIBED);
      h.modal.show('agent');
      await settle();
      expect(h.$<HTMLInputElement>('[data-ref="ignore-api-key"]').checked).toBe(true);
      expect(h.$('[data-ref="ignore-api-key-hint"]').textContent).toContain('On by default when you are signed in to a Claude subscription');
      expect(h.overlay.querySelector('[data-ref="ignore-api-key-note"], [data-ref="ignore-api-key-auto"]')).toBeNull();
      expect(h.$('[data-ref="found"] [data-agent="claude"]').textContent).toContain('ANTHROPIC_API_KEY is left out');
    });

    it('is off by itself when no subscription is signed in', async () => {
      applyAgentPreferences({ agent: { defaultAgent: null, permissionMode: 'ask' } } as UserPreferences);
      const h = mountWith(NO_SUBSCRIPTION);
      h.modal.show('agent');
      await settle();
      expect(h.$<HTMLInputElement>('[data-ref="ignore-api-key"]').checked).toBe(false);
    });

    it('shows an explicit choice over detection, and saves a toggle as a choice', async () => {
      applyAgentPreferences({ agent: { defaultAgent: null, permissionMode: 'ask', claudeIgnoreApiKey: false } } as UserPreferences);
      expect(agentSettings.current.claudeIgnoreApiKey).toBe(false);
      const h = mountWith(SUBSCRIBED);
      h.modal.show('agent');
      await settle();
      const box = h.$<HTMLInputElement>('[data-ref="ignore-api-key"]');
      expect(box.checked).toBe(false);

      // Toggling writes an explicit choice, even the value automatic would give.
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      h.overlay.querySelector<HTMLButtonElement>('[data-ref="save"]')!.click();
      await settle();
      expect(h.save.mock.calls[0][0]).toMatchObject({ claudeIgnoreApiKey: true });
      expect(agentSettings.current.claudeIgnoreApiKey).toBe(true);
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

  it("the API agent's model carries its provider; its effort is its own", () => {
    applyAgentPreferences({ agent: { defaultAgent: 'api', permissionMode: 'ask', claudeEffort: 'max', apiModel: 'no-provider' } } as UserPreferences);
    // A stored model without a provider is not one.
    expect(agentSettings.current.defaultAgent).toBe('api');
    expect(agentSettings.current.apiModel).toBeUndefined();
    expect(rememberModel('api', 'openrouter/anthropic/claude-x')).toEqual({ apiModel: 'openrouter/anthropic/claude-x' });
    expect(rememberEffort('api', 'high')).toEqual({ apiEffort: 'high' });
    expect(agentSettings.current).toMatchObject({ apiModel: 'openrouter/anthropic/claude-x', apiEffort: 'high', claudeEffort: 'max' });
  });

  it('reads the stored servers defensively: built-in ids, bad slugs and other kinds are left out', () => {
    applyAgentPreferences({
      agent: {
        defaultAgent: null,
        permissionMode: 'ask',
        providers: [
          { id: 'ollama', kind: 'openai-compatible', label: 'Ollama', baseURL: 'http://localhost:11434/v1', contextWindow: 8192 },
          { id: 'anthropic', kind: 'openai-compatible', label: 'Not me', baseURL: 'http://x' },
          { id: 'Bad Id', kind: 'openai-compatible', label: 'Bad', baseURL: 'http://x' },
          { id: 'other', kind: 'openai', label: 'Other' },
        ],
      },
    } as UserPreferences);
    expect(agentSettings.current.providers).toEqual([
      { id: 'ollama', kind: 'openai-compatible', label: 'Ollama', baseURL: 'http://localhost:11434/v1', contextWindow: 8192 },
    ]);
  });
});

// The `api` agent (docs/agent-chat-plan.md §20): its built-in providers' keys
// and the local servers. A key goes to the engine by its own PUT, never
// through the preferences, and the page keeps no copy.
describe("Settings → Agent: the API agent's keys and local models", () => {
  const SECRET = 'sk-or-v1-0123456789abcdef';

  /** Settings → Agent over an in-memory engine (the panel's fake client), wired as main.ts wires it. */
  function mountApi(providers: ApiProviderStatus[]) {
    const client = new FakeChatClient();
    client.agentsValue = [CLAUDE, CODEX, FakeChatClient.apiInstall(providers)];
    const savePreference = vi.fn();
    const saved: AgentPreferences[] = [];
    const save = vi.fn(async (value: AgentPreferences) => {
      saved.push(structuredClone(value));
      // The engine now knows the servers saved.
      const api = client.agentsValue.find((a) => a.kind === 'api')!;
      for (const server of value.providers ?? []) {
        if (!api.providers!.some((p) => p.id === server.id)) {
          api.providers!.push(FakeChatClient.provider({ id: server.id, label: server.label, baseURL: server.baseURL }));
        }
      }
      return true;
    });
    const onSaved = vi.fn();
    const modal = new SettingsModal(document.body, {
      savePreference,
      resetPreferences: async () => null,
      applyPreferences: () => undefined,
      agent: {
        agents: async (fresh) => {
          const answer = await client.agents(fresh);
          return answer.ok ? answer.value : null;
        },
        save,
        onSaved,
        providers: async () => {
          const answer = await client.providers();
          return answer.ok ? answer.value : null;
        },
        setKey: async (id, apiKey) => {
          const answer = await client.setProviderKey(id, apiKey);
          return answer.ok === false ? answer.error : null;
        },
        removeKey: async (id) => {
          const answer = await client.removeProviderKey(id);
          return answer.ok === false ? answer.error : null;
        },
      },
    });
    const overlay = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    const panel = overlay.querySelector<HTMLElement>('[data-panel="agent"]')!;
    const $ = <T extends Element = HTMLElement>(selector: string) => panel.querySelector<T>(selector);
    const dialogSave = () => overlay.querySelector<HTMLButtonElement>('[data-ref="save"]')!;
    const row = (id: string) => $(`[data-ref="api-keys"] [data-provider="${id}"]`)!;
    const type = (input: HTMLInputElement, value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    return { client, modal, overlay, panel, $, save, saved, savePreference, onSaved, dialogSave, row, type };
  }

  const NONE = () => [
    FakeChatClient.provider({ id: 'anthropic' }),
    FakeChatClient.provider({ id: 'openai' }),
    FakeChatClient.provider({ id: 'openrouter' }),
  ];

  it('one row per built-in provider: the variable that sets it, a stored key with Remove, or an empty field', async () => {
    const h = mountApi([
      FakeChatClient.provider({ id: 'anthropic', hasKey: true, keySource: 'env', ready: true }),
      FakeChatClient.provider({ id: 'openai', hasKey: true, keySource: 'stored', ready: true }),
      FakeChatClient.provider({ id: 'openrouter' }),
    ]);
    h.modal.show('agent');
    await settle();
    expect([...h.panel.querySelectorAll<HTMLElement>('[data-ref="api-keys"] [data-provider]')].map((r) => r.dataset.provider)).toEqual([
      'anthropic', 'openai', 'openrouter',
    ]);

    // From the environment: said, and no field (it would not win anyway).
    expect(h.row('anthropic').textContent).toContain('Anthropic API');
    expect(h.row('anthropic').querySelector('[data-ref="key-env"]')!.textContent).toBe('Set by ANTHROPIC_API_KEY');
    expect(h.row('anthropic').querySelector('input')).toBeNull();

    // Stored: a field to replace it, and Remove.
    const stored = h.row('openai').querySelector<HTMLInputElement>('[data-ref="key-input"]')!;
    expect(stored.type).toBe('password');
    expect(stored.autocomplete).toBe('off');
    expect(stored.placeholder).toBe('Key saved');
    expect(stored.value).toBe('');
    expect(h.row('openai').querySelector('[data-ref="key-remove"]')).not.toBeNull();

    // None: an empty field; Save waits for a key.
    const none = h.row('openrouter').querySelector<HTMLInputElement>('[data-ref="key-input"]')!;
    expect(none.placeholder).toBe('Paste a key');
    expect(h.row('openrouter').querySelector('[data-ref="key-remove"]')).toBeNull();
    expect(h.row('openrouter').querySelector<HTMLButtonElement>('[data-ref="key-save"]')!.disabled).toBe(true);

    // Detected Agents lists each provider, ready or not.
    const found = h.$('[data-ref="found"]')!;
    expect([...found.querySelectorAll<HTMLElement>('[data-agent="api"]')].map((r) => [r.dataset.provider, r.querySelector('[data-ref="verdict"]')!.textContent])).toEqual([
      ['anthropic', 'Ready'], ['openai', 'Ready'], ['openrouter', 'Not ready'],
    ]);
    expect(found.querySelector('[data-provider="openrouter"]')!.textContent).toContain('No API key.');
  });

  it('a key is stored by its own Save, never through the preferences, and the field is emptied', async () => {
    const h = mountApi(NONE());
    h.modal.show('agent');
    await settle();
    const input = () => h.row('openrouter').querySelector<HTMLInputElement>('[data-ref="key-input"]')!;
    h.type(input(), `  ${SECRET} `);
    // Typing a key is not an unsaved setting: the dialog's Save stays off.
    expect(h.dialogSave().disabled).toBe(true);
    h.row('openrouter').querySelector<HTMLButtonElement>('[data-ref="key-save"]')!.click();
    await settle();
    expect(h.client.setProviderKey).toHaveBeenCalledWith('openrouter', SECRET);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.savePreference).not.toHaveBeenCalled();
    // Stored: the page keeps no copy, and learns only that there is one.
    expect(input().value).toBe('');
    expect(input().placeholder).toBe('Key saved');
    expect(h.row('openrouter').querySelector('[data-ref="key-remove"]')).not.toBeNull();
    expect(h.overlay.innerHTML).not.toContain(SECRET);
    expect(JSON.stringify(agentSettings.current)).not.toContain(SECRET);
    expect(h.$('[data-ref="found"] [data-provider="openrouter"] [data-ref="verdict"]')!.textContent).toBe('Ready');
    // An open Agent panel reads detection again.
    expect(h.onSaved).toHaveBeenCalled();

    // Remove deletes the stored key.
    h.row('openrouter').querySelector<HTMLButtonElement>('[data-ref="key-remove"]')!.click();
    await settle();
    expect(h.client.removeProviderKey).toHaveBeenCalledWith('openrouter');
    expect(input().placeholder).toBe('Paste a key');
    expect(h.$('[data-ref="found"] [data-provider="openrouter"] [data-ref="verdict"]')!.textContent).toBe('Not ready');

    // Nothing the tab saves through the preferences carries a key.
    const agent = h.$<HTMLSelectElement>('[data-ref="default-agent"]')!;
    agent.value = 'api';
    agent.dispatchEvent(new Event('change'));
    h.dialogSave().click();
    await settle();
    expect(h.saved).toEqual([{ defaultAgent: 'api', permissionMode: 'ask', claudeIgnoreApiKey: null }]);
  });

  it('a refused key says why; a key typed and not stored is gone on Cancel', async () => {
    const h = mountApi(NONE());
    h.modal.show('agent');
    await settle();
    const input = () => h.row('anthropic').querySelector<HTMLInputElement>('[data-ref="key-input"]')!;
    h.type(input(), 'x'.repeat(600));
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle();
    const error = h.row('anthropic').querySelector<HTMLElement>('[data-ref="key-error"]')!;
    expect(error.textContent).toBe('An API key is 1 to 512 characters.');
    expect(error.classList.contains('hidden')).toBe(false);

    h.type(input(), SECRET);
    h.modal.hide();
    h.modal.show('agent');
    await settle();
    expect(input().value).toBe('');
    expect(h.overlay.innerHTML).not.toContain(SECRET);
  });

  it('adds a local model from a preset; the dialog saves it in agent.providers, then stores its key', async () => {
    const h = mountApi(NONE());
    h.modal.show('agent');
    await settle();
    expect(h.$('[data-ref="servers"]')!.classList.contains('hidden')).toBe(false);
    h.$<HTMLButtonElement>('[data-ref="add-ollama"]')!.click();
    const card = h.$('[data-server="ollama"]')!;
    expect(card.querySelector<HTMLInputElement>('[data-ref="server-label"]')!.value).toBe('Ollama');
    expect(card.querySelector<HTMLInputElement>('[data-ref="server-url"]')!.value).toBe('http://localhost:11434/v1');
    // Images are off by default for these servers.
    expect(card.querySelector<HTMLInputElement>('[data-ref="server-images"]')!.checked).toBe(false);
    // Not saved yet, so the engine does not know it: no Save of its own for the key.
    expect(card.querySelector('[data-ref="key-save"]')).toBeNull();
    expect(card.querySelector<HTMLInputElement>('[data-ref="key-input"]')!.placeholder).toBe('Optional');
    expect(h.dialogSave().disabled).toBe(false);

    h.type(card.querySelector<HTMLInputElement>('[data-ref="server-context"]')!, '32768');
    h.type(card.querySelector<HTMLInputElement>('[data-ref="key-input"]')!, SECRET);
    h.dialogSave().click();
    await settle();
    await settle();
    expect(h.saved).toEqual([{
      defaultAgent: null,
      permissionMode: 'ask',
      claudeIgnoreApiKey: null,
      providers: [{ id: 'ollama', kind: 'openai-compatible', label: 'Ollama', baseURL: 'http://localhost:11434/v1', images: false, contextWindow: 32768 }],
    }]);
    expect(agentSettings.current.providers).toEqual(h.saved[0].providers);
    // The key went by its own PUT, after the server was saved.
    expect(h.client.setProviderKey).toHaveBeenCalledWith('ollama', SECRET);
    expect(h.save.mock.invocationCallOrder[0]).toBeLessThan(h.client.setProviderKey.mock.invocationCallOrder[0]);
    expect(JSON.stringify(h.saved)).not.toContain(SECRET);
    const savedCard = h.$('[data-server="ollama"]')!;
    expect(savedCard.querySelector<HTMLInputElement>('[data-ref="key-input"]')!.value).toBe('');
    // Known now: its key has its own Save and Remove, like the built-ins.
    expect(savedCard.querySelector('[data-ref="key-save"]')).not.toBeNull();
    expect(savedCard.querySelector('[data-ref="key-remove"]')).not.toBeNull();
    expect(h.dialogSave().disabled).toBe(true);
    expect(h.$('[data-ref="found"] [data-provider="ollama"] [data-ref="verdict"]')!.textContent).toBe('Ready');

    // A second Ollama gets an id of its own.
    h.$<HTMLButtonElement>('[data-ref="add-ollama"]')!.click();
    expect(h.$<HTMLInputElement>('[data-server="ollama-2"] [data-ref="server-label"]')!.value).toBe('Ollama 2');
  });

  it('edits and removes a stored server; one without a valid base URL is not saved', async () => {
    applyAgentPreferences({
      agent: {
        defaultAgent: null,
        permissionMode: 'ask',
        providers: [{ id: 'lm-studio', kind: 'openai-compatible', label: 'LM Studio', baseURL: 'http://localhost:1234/v1', images: false }],
      },
    } as UserPreferences);
    const h = mountApi([...NONE(), FakeChatClient.provider({ id: 'lm-studio', label: 'LM Studio', baseURL: 'http://localhost:1234/v1' })]);
    h.modal.show('agent');
    await settle();
    const card = h.$('[data-server="lm-studio"]')!;
    h.type(card.querySelector<HTMLInputElement>('[data-ref="server-label"]')!, 'Studio');
    const images = card.querySelector<HTMLInputElement>('[data-ref="server-images"]')!;
    images.checked = true;
    images.dispatchEvent(new Event('change'));
    // A server with no address yet.
    h.$<HTMLButtonElement>('[data-ref="add-custom"]')!.click();
    const custom = h.$('[data-server="server"]')!;
    expect(custom.querySelector<HTMLInputElement>('[data-ref="server-url"]')!.value).toBe('');
    h.dialogSave().click();
    await settle();
    // Not sent: the field says what is wrong, and the tab stays unsaved.
    expect(h.saved[0]).not.toHaveProperty('providers');
    expect(custom.querySelector('[data-ref="server-url"]')!.classList.contains('input-error')).toBe(true);
    expect(h.$('[data-ref="servers-error"]')!.classList.contains('hidden')).toBe(false);
    expect(h.dialogSave().disabled).toBe(false);

    h.type(custom.querySelector<HTMLInputElement>('[data-ref="server-url"]')!, 'ftp://example.com');
    h.dialogSave().click();
    await settle();
    expect(h.saved.at(-1)).not.toHaveProperty('providers');

    // Remove the bad one: the edits to the other go.
    custom.querySelector<HTMLButtonElement>('[data-ref="server-remove"]')!.click();
    h.dialogSave().click();
    await settle();
    expect(h.saved.at(-1)!.providers).toEqual([
      { id: 'lm-studio', kind: 'openai-compatible', label: 'Studio', baseURL: 'http://localhost:1234/v1', images: true },
    ]);
    expect(h.$('[data-ref="servers-error"]')!.classList.contains('hidden')).toBe(true);

    // Removing every server saves an empty list (the engine deletes their keys).
    h.$<HTMLButtonElement>('[data-server="lm-studio"] [data-ref="server-remove"]')!.click();
    h.dialogSave().click();
    await settle();
    expect(h.saved.at(-1)!.providers).toEqual([]);
    expect(agentSettings.current.providers).toBeUndefined();
  });

  it('hides the keys and servers when the engine has no API agent', async () => {
    const h = mount();
    h.modal.show('agent');
    await settle();
    expect(h.$('[data-ref="api-keys"]').classList.contains('hidden')).toBe(true);
    expect(h.$('[data-ref="servers"]').classList.contains('hidden')).toBe(true);
  });
});
