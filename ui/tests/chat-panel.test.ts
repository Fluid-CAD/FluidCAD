// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel, type ChatPanelSettings } from '../src/ui/chat/chat-panel';
import { LeftSlot } from '../src/ui/left-slot';
import { isEditableTarget, isChatComposer } from '../src/editable-target';
import { FakeChatClient } from './fixtures/fake-chat-client';
import { settle } from './fixtures/fake-packages-client';

// The Agent panel as the page mounts it (docs/agent-chat-plan.md §10): one
// slot with the code editor and the Hub; the four states of §9.1 (not
// found, too old, not signed in, ready) with how Claude Code is paid for;
// a new chat created by its first message; the attach protocol (snapshot,
// then events after its seq; resync and a new engine refetch); a turn
// streaming thinking, tool cards and markdown; Stop, Escape, Continue; the
// session menu and the model picker.

const panels: ChatPanel[] = [];

afterEach(() => {
  for (const panel of panels.splice(0)) {
    panel.destroy();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty('--fluidcad-editor-width');
  document.body.innerHTML = '';
});

/** Timers the test fires by hand (the reattach after a refused stream). */
class ManualTimers {
  pending: { callback: () => void; ms: number }[] = [];
  set = (callback: () => void, ms: number): unknown => {
    const entry = { callback, ms };
    this.pending.push(entry);
    return entry;
  };
  clear = (handle: unknown): void => {
    this.pending = this.pending.filter((entry) => entry !== handle);
  };
  async fire(): Promise<void> {
    for (const entry of this.pending.splice(0)) {
      entry.callback();
    }
    await settle();
  }
}

function mount(client = new FakeChatClient(), settings: Partial<ChatPanelSettings> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const events: string[] = [];
  const slot = new LeftSlot({ width: 500 });
  const editor = { close: () => events.push('editor closed') };
  slot.register(editor);
  const openExternal = vi.fn();
  const openSettings = vi.fn();
  const openSource = vi.fn();
  const timers = new ManualTimers();
  const current: ChatPanelSettings = { defaultAgent: null, permissionMode: 'ask', ...settings };
  const panel = new ChatPanel({
    container,
    client,
    slot,
    settings: () => current,
    openExternal,
    openSettings,
    openSource,
    onOpenChange: (open) => events.push(open ? 'agent open' : 'agent closed'),
    timers,
  });
  panels.push(panel);
  const $ = <T extends Element = HTMLElement>(selector: string) => panel.el.querySelector<T>(selector);
  const $$ = <T extends Element = HTMLElement>(selector: string) => [...panel.el.querySelectorAll<T>(selector)];
  const input = () => $<HTMLTextAreaElement>('[data-ref="input"]')!;
  const sendButton = () => $<HTMLButtonElement>('[data-ref="send"]')!;
  const type = (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event('input'));
  };
  const key = (k: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    input().dispatchEvent(event);
    return event;
  };
  const width = () => document.documentElement.style.getPropertyValue('--fluidcad-editor-width');
  return { client, panel, container, events, slot, editor, openExternal, openSettings, openSource, timers, settings: current, $, $$, input, sendButton, type, key, width };
}

/** Open the panel and let the first reads land. */
async function opened(h: ReturnType<typeof mount>): Promise<void> {
  h.panel.show();
  await settle();
  await settle();
}

describe('the Agent panel', () => {
  it('takes the left slot: the editor closes first, then the panel takes the shared width; narrow, it covers the scene', async () => {
    vi.stubGlobal('innerWidth', 1440);
    const h = mount();
    expect(h.panel.el.classList.contains('hidden')).toBe(true);
    await opened(h);
    expect(h.events).toEqual(['editor closed', 'agent open']);
    expect(h.width()).toBe('500px');
    expect(h.panel.el.style.width).toBe('500px');
    h.slot.take(h.editor, { el: document.createElement('div'), minWidth: 240 });
    expect(h.panel.isOpen()).toBe(false);
    expect(h.events.at(-1)).toBe('agent closed');

    vi.stubGlobal('innerWidth', 600);
    h.panel.show();
    expect(h.width()).toBe('0px');
    expect(h.panel.el.style.width).toBe('calc(100% - var(--fluidcad-rail-width, 0px))');
    h.panel.close();
    expect(h.width()).toBe('0px');
  });

  it('names the feature "Agent" and Claude Code only as plain text; no logo images', async () => {
    const h = mount();
    await opened(h);
    expect(h.panel.el.getAttribute('aria-label')).toBe('Agent');
    expect(h.$('[data-ref="agent-name"]')!.textContent).toBe('Claude Code');
    expect(h.$$('img')).toHaveLength(0);
  });
});

describe('the empty states (§9.1)', () => {
  it('not found: what it needs, the install page through the host, the path setting, Check again', async () => {
    const client = new FakeChatClient();
    client.agentsValue = [FakeChatClient.install({ path: null, version: null, supported: false, loggedIn: null, authMethod: null, problem: 'Claude Code was not found. Install it, or set its path in Settings.' }), FakeChatClient.codexUnsupported()];
    const h = mount(client);
    await opened(h);
    const setup = h.$('[data-ref="setup"]')!;
    expect(setup.dataset.state).toBe('not-found');
    expect(setup.textContent).toContain('The Agent needs Claude Code');
    expect(setup.textContent).toContain('Settings → Agent');
    expect(h.$('[data-ref="composer"]')!.classList.contains('hidden')).toBe(true);
    h.$<HTMLButtonElement>('[data-ref="install-link"]')!.click();
    expect(h.openExternal).toHaveBeenCalledWith('https://code.claude.com/docs/en/setup');
    h.$<HTMLButtonElement>('[data-ref="open-settings"]')!.click();
    expect(h.openSettings).toHaveBeenCalledTimes(1);

    // Installed meanwhile: Check again detects afresh and the composer comes.
    client.recheckValue = [FakeChatClient.install()];
    h.$<HTMLButtonElement>('[data-ref="check-again"]')!.click();
    await settle();
    expect(client.agents).toHaveBeenLastCalledWith(true);
    expect(h.$('[data-ref="setup"]')).toBeNull();
    expect(h.$('[data-ref="welcome"]')).not.toBeNull();
    expect(h.$('[data-ref="composer"]')!.classList.contains('hidden')).toBe(false);
  });

  it('a path set in Settings that is not the program says so', async () => {
    const client = new FakeChatClient();
    client.agentsValue = [FakeChatClient.install({ path: '/nope/claude', version: null, supported: false, loggedIn: null, problem: 'The Claude Code path set in Settings is not an executable file: /nope/claude' })];
    const h = mount(client);
    await opened(h);
    expect(h.$('[data-ref="setup"]')!.textContent).toContain('is not an executable file: /nope/claude');
  });

  it('too old: the version found and the one needed, with the update command', async () => {
    const client = new FakeChatClient();
    client.agentsValue = [FakeChatClient.install({ version: '2.0.1', supported: false, loggedIn: null })];
    const h = mount(client);
    await opened(h);
    const setup = h.$('[data-ref="setup"]')!;
    expect(setup.dataset.state).toBe('too-old');
    expect(setup.textContent).toContain('Claude Code 2.0.1 is installed; the Agent needs 2.1.259 or later.');
    expect(h.$('[data-ref="command"] code')!.textContent).toBe('claude update');
  });

  it('not signed in: the command to run, a copy button and Check again', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const client = new FakeChatClient();
    client.agentsValue = [FakeChatClient.install({ loggedIn: false, authMethod: 'none', problem: 'Claude Code is not signed in.' })];
    const h = mount(client);
    await opened(h);
    expect(h.$('[data-ref="setup"]')!.dataset.state).toBe('signed-out');
    expect(h.$('[data-ref="command"] code')!.textContent).toBe('claude auth login');
    h.$<HTMLButtonElement>('[data-ref="copy-command"]')!.click();
    expect(writeText).toHaveBeenCalledWith('claude auth login');
    client.recheckValue = [FakeChatClient.install()];
    h.$<HTMLButtonElement>('[data-ref="check-again"]')!.click();
    await settle();
    expect(h.$('[data-ref="welcome"]')).not.toBeNull();
  });

  it('ready: says Claude Code runs on the subscription, or on the API key with the setting that changes it', async () => {
    const h = mount();
    await opened(h);
    expect(h.$('[data-ref="welcome"] [data-ref="auth"]')!.textContent).toBe('Claude Code runs on your Claude subscription.');
    expect(h.$('[data-ref="auth-badge"]')!.textContent).toBe('Subscription');

    const client = new FakeChatClient();
    client.agentsValue = [FakeChatClient.install({ authMethod: 'api_key' })];
    const k = mount(client);
    await opened(k);
    const welcome = k.$$('[data-ref="welcome"]')[0];
    expect(welcome.textContent).toContain('ANTHROPIC_API_KEY');
    expect(welcome.textContent).toContain('Use my Claude subscription even if ANTHROPIC_API_KEY is set');
    expect(k.$('[data-ref="auth-badge"]')!.textContent).toBe('API key');
    k.$<HTMLButtonElement>('[data-ref="welcome"] [data-ref="open-settings"]')!.click();
    expect(k.openSettings).toHaveBeenCalled();
  });
});

describe('a chat', () => {
  it('a new chat is created by its first message, which goes with the model and the permission mode', async () => {
    const h = mount(new FakeChatClient(), { permissionMode: 'ask', effort: 'low' });
    await opened(h);
    expect(h.$('[data-ref="title"]')!.textContent).toBe('New chat');
    expect(h.sendButton().disabled).toBe(true);
    h.type('What is in this model?');
    expect(h.sendButton().disabled).toBe(false);
    // Shift+Enter is a new line, not a send.
    expect(h.key('Enter', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(h.client.createSession).not.toHaveBeenCalled();
    h.key('Enter');
    await settle();
    expect(h.client.createSession).toHaveBeenCalledWith('claude');
    const id = h.client.createSession.mock.results[0] && [...h.client.snapshots.keys()][0];
    expect(h.client.sent).toEqual([{ id, message: { text: 'What is in this model?', model: 'default', mode: 'ask', effort: 'low' } }]);
    expect(h.input().value).toBe('');
    // The user's message came back over the stream, and the title with it.
    expect(h.$('[data-role="user"] .chat-user-text')!.textContent).toBe('What is in this model?');
    expect(h.$('[data-ref="title"]')!.textContent).toBe('What is in this model?');
    expect(h.panel.el.dataset.status).toBe('running');
    expect(h.sendButton().dataset.action).toBe('stop');
    expect(h.$('[data-ref="activity"]')!.textContent).toBe('Working…');
  });

  it('streams thinking, tool cards and markdown; thinking folds away when the answer starts', async () => {
    const h = mount();
    await opened(h);
    h.type('Tell me');
    h.key('Enter');
    await settle();
    const id = [...h.client.snapshots.keys()][0];
    const a = h.client.startAssistant(id);
    h.client.part(id, a, { type: 'reasoning', id: 'r1', text: '' });
    const reasoning = () => h.$('[data-part="reasoning"]')!;
    expect(reasoning().textContent).toContain('Thinking…');
    h.client.delta(id, a, 'r1', 'Look at the **scene** first.');
    expect(reasoning().querySelector('.chat-reasoning-body')!.classList.contains('hidden')).toBe(false);
    expect(reasoning().querySelector('strong')!.textContent).toBe('scene');

    h.client.part(id, a, { type: 'tool', id: 't1', source: 'fluidcad', name: 'search_docs', title: 'Read the docs: hole', kind: 'read', state: 'running', input: { query: 'counterbore hole' } });
    expect(reasoning().textContent).toContain('Thought');
    expect(reasoning().querySelector('.chat-reasoning-body')!.classList.contains('hidden')).toBe(true);
    const card = () => h.$('[data-part="tool"]')!;
    expect(card().dataset.state).toBe('running');
    expect(card().querySelector('[data-ref="title"]')!.textContent).toBe('Read the docs: hole');
    expect(card().querySelector('[data-ref="summary"]')!.textContent).toBe('counterbore hole');
    expect(card().querySelector('.loading-spinner')).not.toBeNull();
    h.client.emit(id, { type: 'part-update', messageId: a, partId: 't1', patch: { state: 'done', output: { text: 'hole() makes…', images: ['shot.png'] } } });
    expect(card().dataset.state).toBe('done');
    expect(card().querySelector('[data-ref="images"] img')!.getAttribute('src')).toBe(`api/agent/sessions/${id}/files/shot.png`);
    // The raw input and output on a click.
    expect(card().querySelector('[data-ref="details"]')!.classList.contains('hidden')).toBe(true);
    card().querySelector<HTMLButtonElement>('[data-ref="toggle"]')!.click();
    const details = card().querySelector('[data-ref="details"]')!;
    expect(details.classList.contains('hidden')).toBe(false);
    expect(details.textContent).toContain('"query": "counterbore hole"');
    expect(details.textContent).toContain('hole() makes…');

    h.client.part(id, a, { type: 'tool', id: 't2', source: 'fluidcad', name: 'write_file', title: 'Write bracket.part.js', kind: 'edit', state: 'running', input: { path: 'bracket.part.js', content: 'x' } });
    h.client.emit(id, { type: 'part-update', messageId: a, partId: 't2', patch: { state: 'denied', error: 'FluidCAD did not run write_file: changing the project from the chat is not available in this version.' } });
    const denied = h.$$('[data-part="tool"]')[1];
    expect(denied.dataset.state).toBe('denied');
    expect(denied.querySelector('[data-ref="error"]')!.textContent).toContain('did not run write_file');

    h.client.part(id, a, { type: 'text', id: 'x1', text: '' });
    h.client.delta(id, a, 'x1', 'A plate with **four');
    h.client.delta(id, a, 'x1', '** holes:\n\n```js\nhole(4)\n');
    const text = h.$('[data-part="text"]:not(.chat-user-text)')!;
    expect(text.querySelector('strong')!.textContent).toBe('four');
    expect(text.querySelector('[data-ref="code-block"] code')!.textContent).toContain('hole(4)');
    h.client.delta(id, a, 'x1', '```\n');
    h.client.finish(id, a);
    expect(h.panel.el.dataset.status).toBe('idle');
    expect(h.sendButton().dataset.action).toBe('send');
    expect(h.$('[data-ref="activity"]')!.classList.contains('hidden')).toBe(true);
    // Nothing the model wrote went through innerHTML: no element it named exists.
    expect(h.$$('script, iframe')).toHaveLength(0);
  });

  it('a render outcome shows on the card, with a link to the line', async () => {
    const client = new FakeChatClient();
    const s = client.addSession({ title: 'Earlier', updatedAt: '2026-11-17T11:00:00.000Z' });
    client.emit(s.id, { type: 'message-start', message: { id: 'a', role: 'assistant', turnId: 't', createdAt: '' } });
    client.emit(s.id, { type: 'part-start', messageId: 'a', part: {
      type: 'tool', id: 'w', source: 'fluidcad', name: 'recompute', title: 'Re-render the model', kind: 'edit', state: 'done', input: {},
      output: { text: JSON.stringify({ render: { state: 'compile-error', compileError: { message: 'Unexpected token', sourceLocation: { filePath: '/w/plate.part.js', line: 7, column: 3 } } } }) },
    } });
    const h = mount(client);
    await opened(h);
    const outcome = h.$('[data-ref="outcome"]')!;
    expect(outcome.textContent).toContain('Compile error: Unexpected token');
    outcome.querySelector<HTMLButtonElement>('[data-ref="source-link"]')!.click();
    expect(h.openSource).toHaveBeenCalledWith('/w/plate.part.js', 7, 3);
  });

  it('Stop and Escape cancel the turn; typing goes on while it runs, and Enter waits', async () => {
    const h = mount();
    await opened(h);
    h.type('first');
    h.key('Enter');
    await settle();
    const id = [...h.client.snapshots.keys()][0];
    const a = h.client.startAssistant(id);
    h.client.part(id, a, { type: 'text', id: 'x', text: 'Partial' });
    h.type('next question');
    expect(h.input().disabled).toBe(false);
    h.key('Enter');
    await settle();
    expect(h.client.sent).toHaveLength(1);
    expect(h.input().value).toBe('next question');
    const escape = h.key('Escape');
    expect(escape.defaultPrevented).toBe(true);
    await settle();
    expect(h.client.cancel).toHaveBeenCalledWith(id);
    expect(h.$('[data-part="notice"]')!.textContent!.trim()).toBe('Stopped.');
    expect(h.sendButton().dataset.action).toBe('send');
    // The partial answer stays.
    expect(h.$$('[data-part="text"]').map((e) => e.textContent)).toContain('Partial');
    // The Stop button does the same as Escape.
    h.key('Enter');
    await settle();
    expect(h.client.sent.map((s) => s.message.text)).toEqual(['first', 'next question']);
    h.sendButton().click();
    await settle();
    expect(h.client.cancel).toHaveBeenCalledTimes(2);
  });

  it('a send the engine refuses keeps the text and says why', async () => {
    const h = mount();
    await opened(h);
    h.client.send.mockResolvedValueOnce({ ok: false, status: 409, error: 'A turn is already running in this session.' });
    h.type('hello');
    h.key('Enter');
    await settle();
    expect(h.input().value).toBe('hello');
    expect(h.$('[data-ref="status"]')!.textContent).toContain('A turn is already running');
    h.$<HTMLButtonElement>('[data-ref="dismiss"]')!.click();
    expect(h.$('[data-ref="status"]')!.classList.contains('hidden')).toBe(true);
  });
});

describe('the attach protocol (§7.3)', () => {
  it('opens the latest chat from its snapshot, then follows events after its seq only', async () => {
    const client = new FakeChatClient();
    client.addSession({ id: 'old', title: 'Old', updatedAt: '2026-11-16T10:00:00.000Z' });
    const s = client.addSession({ id: 'latest', title: 'Latest', updatedAt: '2026-11-17T11:00:00.000Z' });
    client.emit(s.id, { type: 'message-start', message: { id: 'u', role: 'user', turnId: 't', createdAt: '' } });
    client.emit(s.id, { type: 'part-start', messageId: 'u', part: { type: 'text', id: 'p', text: 'Hi there' } });
    const h = mount(client);
    await opened(h);
    expect(client.snapshot).toHaveBeenCalledWith('latest');
    expect(h.$('[data-ref="title"]')!.textContent).toBe('Latest');
    expect(client.subscribe).toHaveBeenCalledWith('latest', { after: 2, epoch: 'epoch-1' }, expect.anything());
    expect(h.$('.chat-user-text')!.textContent).toBe('Hi there');

    // An event the snapshot already holds (a replay overlap) is not applied twice.
    const sub = client.openStreams('latest')[0];
    sub.handlers.onEnvelope({ epoch: 'epoch-1', seq: 2, event: { type: 'part-delta', messageId: 'u', partId: 'p', text: ' again' } });
    expect(h.$('.chat-user-text')!.textContent).toBe('Hi there');
    client.emit(s.id, { type: 'part-delta', messageId: 'u', partId: 'p', text: '!' });
    expect(h.$('.chat-user-text')!.textContent).toBe('Hi there!');
  });

  it('resync, or an envelope from a restarted engine, refetches the snapshot and attaches again', async () => {
    const client = new FakeChatClient();
    const s = client.addSession({ id: 's', title: 'S' });
    const h = mount(client);
    await opened(h);
    expect(client.snapshot).toHaveBeenCalledTimes(1);
    client.resync('s');
    await settle();
    expect(client.snapshot).toHaveBeenCalledTimes(2);
    expect(client.openStreams('s')).toHaveLength(1);

    // The engine restarted: a new epoch.
    client.snapshots.get('s')!.epoch = 'epoch-2';
    s.title = 'After restart';
    client.emit('s', { type: 'status', status: { state: 'idle' } }, { epoch: 'epoch-2' });
    await settle();
    expect(client.snapshot).toHaveBeenCalledTimes(3);
    expect(client.subscribe).toHaveBeenLastCalledWith('s', { after: 1, epoch: 'epoch-2' }, expect.anything());
    expect(h.$('[data-ref="title"]')!.textContent).toBe('After restart');
  });

  it('a stream the server refuses is retried; a deleted session goes back to a new chat', async () => {
    const client = new FakeChatClient();
    client.addSession({ id: 's', title: 'S' });
    const h = mount(client);
    await opened(h);
    client.refuseStreams('s');
    await settle();
    expect(h.$('[data-ref="status"]')!.textContent).toContain('Reconnecting');
    expect(h.timers.pending).toHaveLength(1);
    await h.timers.fire();
    expect(client.openStreams('s')).toHaveLength(1);
    expect(h.$('[data-ref="status"]')!.classList.contains('hidden')).toBe(true);

    client.snapshots.delete('s');
    client.resync('s');
    await settle();
    expect(h.$('[data-ref="title"]')!.textContent).toBe('New chat');
  });

  it('after an engine restart cut a turn off: the reason and Continue', async () => {
    const client = new FakeChatClient();
    client.addSession({ id: 's', title: 'S', status: { state: 'interrupted', reason: 'The app restarted while this turn was running.' } });
    const h = mount(client);
    await opened(h);
    expect(h.$('[data-ref="status"]')!.textContent).toContain('The app restarted');
    h.$<HTMLButtonElement>('[data-ref="continue"]')!.click();
    await settle();
    expect(client.continueTurn).toHaveBeenCalledWith('s');
    expect(h.panel.el.dataset.status).toBe('running');
  });

  it('a sign-in error offers Check again; a plan limit says when it resets', async () => {
    const client = new FakeChatClient();
    client.addSession({ id: 's', title: 'S', status: { state: 'error', kind: 'auth', message: 'Claude Code is not signed in.' } });
    const h = mount(client);
    await opened(h);
    expect(h.$('[data-ref="status"]')!.textContent).toContain('Claude Code is not signed in.');
    h.$<HTMLButtonElement>('[data-ref="status-check-again"]')!.click();
    await settle();
    expect(client.agents).toHaveBeenLastCalledWith(true);
    client.emit('s', { type: 'status', status: { state: 'error', kind: 'rate-limit', message: 'Limit reached.', resetsAt: '2030-01-01T15:00:00.000Z' } });
    expect(h.$('[data-ref="status"]')!.textContent).toMatch(/Limit reached\. It resets at /);
  });
});

describe('the header', () => {
  it('the session menu lists the chats and switches between them', async () => {
    const client = new FakeChatClient();
    client.addSession({ id: 'a', title: 'Alpha', updatedAt: '2026-11-17T09:00:00.000Z' });
    client.addSession({ id: 'b', title: 'Beta', updatedAt: '2026-11-17T10:00:00.000Z' });
    const h = mount(client);
    await opened(h);
    expect(h.$('[data-ref="title"]')!.textContent).toBe('Beta');
    h.$<HTMLButtonElement>('[data-ref="sessions"]')!.click();
    await settle();
    const menu = h.container.querySelector('[data-ref="session-menu"]')!;
    const rows = [...menu.querySelectorAll('[role="menuitem"], button')].map((r) => r.textContent!.trim()).filter(Boolean);
    expect(rows).toEqual(['New chat', 'Beta', 'Alpha']);
    const alpha = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], button')].find((r) => r.textContent!.trim() === 'Alpha')!;
    alpha.click();
    await settle();
    expect(h.$('[data-ref="title"]')!.textContent).toBe('Alpha');
    expect(client.openStreams()).toHaveLength(1);
    expect(client.openStreams()[0].id).toBe('a');

    h.$<HTMLButtonElement>('[data-ref="new-chat"]')!.click();
    expect(h.$('[data-ref="title"]')!.textContent).toBe('New chat');
    expect(client.openStreams()).toHaveLength(0);
  });

  it('the model picker offers Default and the aliases, and any model by name', async () => {
    const h = mount(new FakeChatClient(), { claudeModel: 'haiku' });
    await opened(h);
    const picker = () => h.$<HTMLSelectElement>('[data-ref="model-picker"]')!;
    expect([...picker().options].map((o) => o.textContent)).toEqual(['Default', 'Opus', 'Sonnet', 'Haiku', 'Fable', 'Other model…']);
    expect(picker().value).toBe('haiku');
    picker().value = 'sonnet';
    picker().dispatchEvent(new Event('change'));
    h.type('one');
    h.key('Enter');
    await settle();
    expect(h.client.sent[0].message.model).toBe('sonnet');
    const id = h.client.sent[0].id;
    h.client.emit(id, { type: 'status', status: { state: 'idle' } });

    picker().value = '__other__';
    picker().dispatchEvent(new Event('change'));
    const name = h.$<HTMLInputElement>('[data-ref="model-input"]')!;
    name.value = 'claude-sonnet-4-5';
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(picker().value).toBe('claude-sonnet-4-5');
    h.type('two');
    h.key('Enter');
    await settle();
    expect(h.client.sent[1].message.model).toBe('claude-sonnet-4-5');
  });

  it('the agent row is a picker only when more than one agent can run', async () => {
    const client = new FakeChatClient();
    client.agentsValue = [FakeChatClient.install(), FakeChatClient.codexUnsupported()];
    const h = mount(client);
    await opened(h);
    expect(h.$('[data-ref="agent-picker"]')).toBeNull();
    expect(h.$('[data-ref="agent-name"]')!.textContent).toBe('Claude Code');
  });
});

describe('the composer and the page’s shortcuts', () => {
  it('is a text field to the shortcut guards, and marked for the global Ctrl+B', () => {
    const h = mount();
    expect(isEditableTarget(h.input())).toBe(true);
    expect(isChatComposer(h.input())).toBe(true);
    expect(isChatComposer(h.panel.el)).toBe(false);
  });
});

describe('the tool card’s line', () => {
  it('names the input that says most, and nothing the title already says', async () => {
    const { summarizeToolInput, readRenderOutcome } = await import('../src/ui/chat/parts/tool-part');
    expect(summarizeToolInput({ query: 'counterbore hole', limit: 5 })).toBe('counterbore hole');
    expect(summarizeToolInput({ path: '/w/very/long/plate.part.js' }, 'Read plate.part.js')).toBe('');
    expect(summarizeToolInput({ pattern: 'hole\\(' }, 'Search')).toBe('hole\\(');
    expect(summarizeToolInput({ width: 10, deep: { a: 1 }, flag: true })).toBe('width: 10 · flag: true');
    expect(summarizeToolInput({ query: 'x'.repeat(200) })).toHaveLength(90);
    expect(readRenderOutcome('{"render":{"state":"build-error","objectErrors":[{"name":"Fillet 1","message":"radius too large","sourceLocation":{"filePath":"/w/a.part.js","line":3,"column":1}}]}}'))
      .toEqual({ state: 'build-error', errors: [{ name: 'Fillet 1', message: 'radius too large', location: { filePath: '/w/a.part.js', line: 3, column: 1 } }] });
    expect(readRenderOutcome('plain text')).toBeNull();
  });
});
