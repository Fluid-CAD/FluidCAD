// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel, type ChatConfirmOptions, type ChatPanelSettings } from '../src/ui/chat/chat-panel';
import type { ChatMessage, PermissionMode, SessionStatus, ToolPart, TurnRecord } from '../src/ui/chat/chat-types';
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
// chats menu (switch, rename, delete) and the model picker.

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
  const confirm = vi.fn(async (_options: ChatConfirmOptions) => true);
  const onPermissionModeChosen = vi.fn((mode: PermissionMode) => {
    current.permissionMode = mode;
  });
  const panel = new ChatPanel({
    container,
    client,
    slot,
    settings: () => current,
    openExternal,
    openSettings,
    openSource,
    confirm,
    onPermissionModeChosen,
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
  return { client, panel, container, events, slot, editor, openExternal, openSettings, openSource, confirm, onPermissionModeChosen, timers, settings: current, $, $$, input, sendButton, type, key, width };
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
    // In the mode the header holds.
    expect(client.continueTurn).toHaveBeenCalledWith('s', 'ask');
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
    const resetsAt = new Date(Date.now() + 3 * 3600_000 + 60_000).toISOString();
    client.emit('s', { type: 'status', status: { state: 'error', kind: 'rate-limit', message: 'Limit reached.', resetsAt } });
    const at = new Date(resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    expect(h.$('[data-ref="status-text"]')!.textContent).toBe(`Limit reached. It resets in 3 h 1 min, at ${at}.`);
  });

  it('a plan-limit notice says when it resets in local time; one stored with the raw instant reads the same', async () => {
    const client = new FakeChatClient();
    const resetsAt = new Date(Date.now() + 2 * 3600_000 + 30 * 60_000).toISOString();
    const at = new Date(resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    client.addSession({
      id: 's',
      title: 'S',
      messages: [
        { id: 'u1', role: 'user', turnId: 't1', createdAt: '', parts: [{ type: 'text', id: 'x', text: 'hi' }] },
        { id: 'a1', role: 'assistant', turnId: 't1', createdAt: '', parts: [
          { type: 'notice', id: 'n1', level: 'warning', text: "Claude Code reached your plan's five-hour usage limit.", resetsAt },
          // As the runtime wrote it before the reset time had its own field.
          { type: 'notice', id: 'n2', level: 'error', text: `Claude Code reached your plan's five-hour usage limit; it resets at ${resetsAt}.` },
        ] },
      ],
      turns: [{ id: 't1', userMessageId: 'u1', revertible: false }],
    });
    const h = mount(client);
    await opened(h);
    const notices = h.$$('[data-part="notice"]').map((n) => n.textContent!.trim());
    expect(notices[0]).toMatch(new RegExp(`^Claude Code reached your plan's five-hour usage limit\\. It resets in 2 h (29|30) min, at ${at}\\.$`));
    expect(notices[1]).toMatch(new RegExp(`^Claude Code reached your plan's five-hour usage limit; it resets in 2 h (29|30) min, at ${at}\\.$`));
  });

  it('shows what each turn used under its answer; the cost only when it is billed', async () => {
    const client = new FakeChatClient();
    client.addSession({
      id: 's',
      title: 'S',
      messages: [
        { id: 'u1', role: 'user', turnId: 't1', createdAt: '', parts: [{ type: 'text', id: 'x', text: 'hi' }] },
        { id: 'a1', role: 'assistant', turnId: 't1', createdAt: '', parts: [{ type: 'text', id: 'y', text: 'Hello.' }] },
      ],
      turns: [{ id: 't1', userMessageId: 'u1', revertible: false, usage: { inputTokens: 23456, outputTokens: 512, costUsd: 0.0421 } }],
    });
    const h = mount(client);
    await opened(h);
    const usage = () => h.$('[data-message-id="a1"] [data-ref="usage"]')!;
    // On a subscription the figure is not a charge: in the tooltip only.
    expect(usage().textContent).toBe('23k in · 512 out');
    expect(usage().title).toMatch(/23,456 input tokens.*512 output tokens.*\$0\.04 at API prices/);

    // A turn streaming now gets its line when its usage arrives.
    h.type('more');
    h.key('Enter');
    await settle();
    const assistant = client.startAssistant('s', 'a2');
    client.part('s', assistant, { type: 'text', id: 'z', text: 'Sure.' });
    expect(h.$('[data-message-id="a2"] [data-ref="usage"]')).toBeNull();
    client.emit('s', { type: 'usage', turnId: 'turn-1', inputTokens: 900, outputTokens: 40 });
    client.finish('s', assistant);
    expect(h.$('[data-message-id="a2"] [data-ref="usage"]')!.textContent).toBe('900 in · 40 out');

    // On an API key the cost is a charge: shown.
    client.recheckValue = [FakeChatClient.install({ authMethod: 'api_key' })];
    await h.panel.state.loadAgents(true);
    expect(usage().textContent).toBe('23k in · 512 out · $0.04');
  });
});

describe('the header', () => {
  it('the chats menu lists the chats newest first, with the agent, the time and the status, and switches', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-17T10:30:00.000Z'), toFake: ['Date'] });
    try {
      const client = new FakeChatClient();
      client.addSession({ id: 'a', title: 'Alpha', updatedAt: '2026-11-17T09:00:00.000Z', status: { state: 'interrupted', reason: 'The app restarted.' } });
      client.addSession({ id: 'b', title: 'Beta', updatedAt: '2026-11-17T10:25:00.000Z' });
      client.addSession({ id: 'c', title: 'Gamma', agent: 'codex', updatedAt: '2026-11-17T08:00:00.000Z', status: { state: 'error', kind: 'rate-limit', message: 'Limit.' } });
      const h = mount(client);
      await opened(h);
      expect(h.$('[data-ref="title"]')!.textContent).toBe('Beta');
      h.$<HTMLButtonElement>('[data-ref="sessions"]')!.click();
      await settle();
      const menu = h.container.querySelector('[data-ref="session-menu"]')!;
      expect(menu.querySelector('[data-ref="menu-new-chat"]')!.textContent!.trim()).toBe('New chat');
      const titles = [...menu.querySelectorAll('[data-ref="session-title"]')].map((t) => t.textContent);
      expect(titles).toEqual(['Beta', 'Alpha', 'Gamma']);
      const metas = [...menu.querySelectorAll('[data-ref="session-meta"]')].map((t) => t.textContent);
      expect(metas[0]).toBe('Claude Code · 5 min ago');
      expect(metas[1]).toBe('Claude Code · 1 h ago · Interrupted');
      expect(metas[2]).toBe('Codex · 2 h ago · Limit reached');
      expect(menu.querySelector('[data-current="true"] [data-ref="session-title"]')!.textContent).toBe('Beta');

      const alpha = menu.querySelector<HTMLButtonElement>('[data-session-id="a"] [data-ref="open-session"]')!;
      alpha.click();
      await settle();
      expect(h.container.querySelector('[data-ref="session-menu"]')).toBeNull();
      expect(h.$('[data-ref="title"]')!.textContent).toBe('Alpha');
      expect(client.openStreams()).toHaveLength(1);
      expect(client.openStreams()[0].id).toBe('a');

      h.$<HTMLButtonElement>('[data-ref="new-chat"]')!.click();
      expect(h.$('[data-ref="title"]')!.textContent).toBe('New chat');
      expect(client.openStreams()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renames a chat in place from the menu: Enter keeps it (PATCH), Escape leaves it', async () => {
    const client = new FakeChatClient();
    client.addSession({ id: 'a', title: 'Alpha', updatedAt: '2026-11-17T09:00:00.000Z' });
    client.addSession({ id: 'b', title: 'Beta', updatedAt: '2026-11-17T10:00:00.000Z' });
    const h = mount(client);
    await opened(h);
    const menu = async () => {
      h.$<HTMLButtonElement>('[data-ref="sessions"]')!.click();
      await settle();
      return h.container.querySelector<HTMLElement>('[data-ref="session-menu"]')!;
    };
    let m = await menu();
    m.querySelector<HTMLButtonElement>('[data-session-id="b"] [data-ref="rename-session"]')!.click();
    let input = m.querySelector<HTMLInputElement>('[data-ref="rename-input"]')!;
    expect(input.value).toBe('Beta');
    input.value = 'Bracket fillets';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle();
    expect(client.rename).toHaveBeenCalledWith('b', 'Bracket fillets');
    expect(h.$('[data-ref="title"]')!.textContent).toBe('Bracket fillets');
    expect(m.querySelector('[data-ref="rename-input"]')).toBeNull();
    expect(m.querySelector('[data-session-id="b"] [data-ref="session-title"]')!.textContent).toBe('Bracket fillets');

    // Another chat, then Escape: nothing is sent.
    m.querySelector<HTMLButtonElement>('[data-session-id="a"] [data-ref="rename-session"]')!.click();
    input = m.querySelector<HTMLInputElement>('[data-ref="rename-input"]')!;
    input.value = 'Never mind';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await settle();
    expect(client.rename).toHaveBeenCalledTimes(1);
    expect(m.querySelector('[data-session-id="a"] [data-ref="session-title"]')!.textContent).toBe('Alpha');
    // The menu stays open after Escape left the field.
    expect(h.container.querySelector('[data-ref="session-menu"]')).not.toBeNull();

    // A refusal stays in the field.
    client.rename.mockResolvedValueOnce({ ok: false, status: 400, error: '`title` must be a non-empty string.' });
    m = h.container.querySelector<HTMLElement>('[data-ref="session-menu"]')!;
    m.querySelector<HTMLButtonElement>('[data-session-id="a"] [data-ref="rename-session"]')!.click();
    input = m.querySelector<HTMLInputElement>('[data-ref="rename-input"]')!;
    input.value = 'Odd';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle();
    expect(m.querySelector('[data-ref="rename-error"]')!.textContent).toMatch(/non-empty/);
    expect(m.querySelector('[data-ref="rename-input"]')).not.toBeNull();
  });

  it('deletes a chat after asking; deleting the chat on screen opens a new chat', async () => {
    const client = new FakeChatClient();
    client.addSession({ id: 'a', title: 'Alpha', updatedAt: '2026-11-17T09:00:00.000Z' });
    client.addSession({ id: 'b', title: 'Beta', updatedAt: '2026-11-17T10:00:00.000Z' });
    const h = mount(client);
    await opened(h);
    const openMenu = async () => {
      h.$<HTMLButtonElement>('[data-ref="sessions"]')!.click();
      await settle();
      return h.container.querySelector<HTMLElement>('[data-ref="session-menu"]')!;
    };

    // Declined: nothing happens.
    h.confirm.mockResolvedValueOnce(false);
    (await openMenu()).querySelector<HTMLButtonElement>('[data-session-id="a"] [data-ref="delete-session"]')!.click();
    await settle();
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm.mock.calls[0][0]).toMatchObject({ title: 'Delete chat', confirmLabel: 'Delete', danger: true, kind: 'delete' });
    expect(h.confirm.mock.calls[0][0].message).toMatch(/“Alpha”/);
    expect(client.remove).not.toHaveBeenCalled();

    // Another chat: the one on screen stays.
    (await openMenu()).querySelector<HTMLButtonElement>('[data-session-id="a"] [data-ref="delete-session"]')!.click();
    await settle();
    expect(client.remove).toHaveBeenCalledWith('a');
    expect(h.$('[data-ref="title"]')!.textContent).toBe('Beta');
    let m = await openMenu();
    expect([...m.querySelectorAll('[data-ref="session-title"]')].map((t) => t.textContent)).toEqual(['Beta']);

    // The chat on screen: a new chat takes its place.
    m.querySelector<HTMLButtonElement>('[data-session-id="b"] [data-ref="delete-session"]')!.click();
    await settle();
    expect(client.remove).toHaveBeenCalledWith('b');
    expect(h.panel.state.session).toBeNull();
    expect(h.$('[data-ref="title"]')!.textContent).toBe('New chat');
    expect(client.openStreams()).toHaveLength(0);
    m = await openMenu();
    expect(m.querySelectorAll('[data-ref="session-title"]')).toHaveLength(0);
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

  it("the effort picker offers Claude Code's levels, low to max, and sends the one picked", async () => {
    const h = mount(new FakeChatClient(), { claudeEffort: 'xhigh' });
    await opened(h);
    const picker = () => h.$<HTMLSelectElement>('[data-ref="effort-picker"]')!;
    expect([...picker().options].map((o) => o.textContent)).toEqual([
      'Default effort', 'Low effort', 'Medium effort', 'High effort', 'Extra high effort', 'Max effort',
    ]);
    expect(picker().value).toBe('xhigh');
    picker().value = 'max';
    picker().dispatchEvent(new Event('change'));
    h.type('think hard');
    h.key('Enter');
    await settle();
    expect(h.client.sent[0].message.effort).toBe('max');
    h.client.emit(h.client.sent[0].id, { type: 'status', status: { state: 'idle' } });

    // "Default effort" sends none: the CLI's own.
    picker().value = '';
    picker().dispatchEvent(new Event('change'));
    h.type('quick');
    h.key('Enter');
    await settle();
    expect(h.client.sent[1].message).not.toHaveProperty('effort');
  });

  it("for Codex it offers the levels of the model picked, and drops a level the model lacks", async () => {
    const client = new FakeChatClient();
    client.agentsValue = [FakeChatClient.install({ kind: 'codex', authMethod: null })];
    client.modelsValue = [
      { id: 'default', label: 'Default' },
      { id: 'gpt-luna', label: 'Luna', isDefault: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
      { id: 'gpt-terra', label: 'Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
    ];
    const h = mount(client, { defaultAgent: 'codex', codexEffort: 'ultra' });
    await opened(h);
    const levels = () => [...h.$<HTMLSelectElement>('[data-ref="effort-picker"]')!.options].map((o) => o.value);
    // Default is Luna, which has no "ultra": the default holds.
    expect(levels()).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(h.$<HTMLSelectElement>('[data-ref="effort-picker"]')!.value).toBe('');
    const model = h.$<HTMLSelectElement>('[data-ref="model-picker"]')!;
    model.value = 'gpt-terra';
    model.dispatchEvent(new Event('change'));
    expect(levels()).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(h.$<HTMLSelectElement>('[data-ref="effort-picker"]')!.value).toBe('ultra');
    h.type('go');
    h.key('Enter');
    await settle();
    expect(client.sent[0].message).toMatchObject({ model: 'gpt-terra', effort: 'ultra' });
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

  it('a tool’s own JSON refusal reads as its message, even cut short', async () => {
    const { readableError } = await import('../src/ui/chat/parts/tool-part');
    const refusal = JSON.stringify({ code: 'missing-imports', message: 'Refusing to write "/w/a.part.js" — uses fillet without an import.', details: {} });
    expect(readableError(refusal)).toBe('Refusing to write "/w/a.part.js" — uses fillet without an import.');
    expect(readableError(refusal.slice(0, -5))).toBe('Refusing to write "/w/a.part.js" — uses fillet without an import.');
    expect(readableError('Declined.')).toBe('Declined.');
    expect(readableError('{"no":"message"}')).toBe('{"no":"message"}');
  });
});

// --- Phase 4: approval, the permission mode, revert, the dirty buffer -------

const DIFF = '--- a/plate.part.js\n+++ b/plate.part.js\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n+fillet(2)\n c\n';

function editPart(overrides: Partial<ToolPart> = {}): ToolPart {
  return {
    type: 'tool',
    id: 'edit',
    source: 'fluidcad',
    name: 'edit_range',
    title: 'Edit plate.part.js, line 2',
    kind: 'edit',
    state: 'awaiting-approval',
    input: { path: 'plate.part.js' },
    diff: DIFF,
    approval: { id: 'ap1', canAllowSession: true },
    ...overrides,
  };
}

/** A session whose running turn waits on `part`, as a snapshot holds it (a reload, a second tab). */
function waitingSession(client: FakeChatClient, part: ToolPart = editPart()) {
  return client.addSession({
    id: 's',
    title: 'Fillet',
    status: { state: 'awaiting-approval', turnId: 't1', approvalIds: part.approval ? [part.approval.id] : [] },
    messages: [
      { id: 'u1', role: 'user', turnId: 't1', createdAt: '', parts: [{ type: 'text', id: 'u1t', text: 'add a 2 mm fillet' }] },
      { id: 'a1', role: 'assistant', turnId: 't1', createdAt: '', parts: [part] },
    ],
    turns: [{ id: 't1', userMessageId: 'u1', revertible: false }],
  });
}

describe('approval on tool cards (§12.1)', () => {
  it('shows the diff above Allow, Allow for this session and Deny; Allow answers and the buttons go with the event', async () => {
    const client = new FakeChatClient();
    waitingSession(client);
    const h = mount(client);
    await opened(h);
    const card = h.$('[data-part="tool"]')!;
    expect(card.dataset.state).toBe('awaiting-approval');
    const approval = card.querySelector('[data-ref="approval"]')!;
    expect(approval.classList.contains('hidden')).toBe(false);
    // The diff, expanded, before the buttons; lines tinted by their sign.
    const diff = approval.querySelector('[data-ref="diff"]')!;
    expect(diff.compareDocumentPosition(approval.querySelector('[data-ref="allow"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...diff.querySelectorAll('.chat-diff-add')].map((l) => l.textContent)).toEqual(['+B\n', '+fillet(2)\n']);
    expect([...diff.querySelectorAll('.chat-diff-del')].map((l) => l.textContent)).toEqual(['-b\n']);
    expect(diff.querySelectorAll('.chat-diff-file')).toHaveLength(2);
    expect(diff.querySelector('.chat-diff-hunk')!.textContent).toBe('@@ -1,3 +1,4 @@\n');
    expect(approval.querySelector('[data-ref="approval-question"]')!.textContent!.trim()).toBe('Apply this change?');
    const buttons = [...approval.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.map((b) => [b.dataset.ref, b.textContent!.trim(), b.disabled])).toEqual([
      ['allow', 'Allow', false],
      ['allow-session', 'Allow for this session', false],
      ['deny', 'Deny', false],
    ]);
    // Real buttons: in the tab order, no shortcut needed.
    expect(buttons.every((b) => b.tabIndex >= 0 && b.type === 'button')).toBe(true);
    expect(h.$('[data-ref="activity"]')!.textContent).toBe('Waiting for your approval…');

    buttons[0].click();
    await settle();
    expect(client.decideApproval).toHaveBeenCalledWith('s', 'ap1', 'allow');
    expect(card.dataset.state).toBe('running');
    expect(card.querySelectorAll('[data-ref="approval"] button')).toHaveLength(0);
    expect(card.querySelector('[data-ref="approval"]')!.textContent!.trim()).toBe('You allowed this');
    // The diff moved into the details.
    card.querySelector<HTMLButtonElement>('[data-ref="toggle"]')!.click();
    expect(card.querySelector('[data-ref="details"] [data-ref="diff"]')).not.toBeNull();
    expect(h.panel.el.dataset.status).toBe('running');
  });

  it('Allow for this session and Deny send their decision; a declined card says so', async () => {
    const client = new FakeChatClient();
    waitingSession(client);
    const h = mount(client);
    await opened(h);
    h.$<HTMLButtonElement>('[data-ref="allow-session"]')!.click();
    await settle();
    expect(client.decideApproval).toHaveBeenLastCalledWith('s', 'ap1', 'allow-session');
    expect(h.$('[data-ref="approval"]')!.textContent!.trim()).toBe('You allowed this for the session');

    const other = new FakeChatClient();
    waitingSession(other);
    const d = mount(other);
    await opened(d);
    d.$<HTMLButtonElement>('[data-ref="deny"]')!.click();
    await settle();
    expect(other.decideApproval).toHaveBeenCalledWith('s', 'ap1', 'deny');
    const card = d.$('[data-part="tool"]')!;
    expect(card.dataset.state).toBe('denied');
    expect(card.querySelector('[data-ref="approval"]')!.classList.contains('hidden')).toBe(true);
    expect(card.querySelector('[data-ref="error"]')!.textContent).toBe('Declined.');
  });

  it('offers no Allow for this session when the call does not (outside the project)', async () => {
    const client = new FakeChatClient();
    waitingSession(client, editPart({ name: 'export', title: 'Export a STEP file', kind: 'outside', diff: undefined, approval: { id: 'ap2', canAllowSession: false } }));
    const h = mount(client);
    await opened(h);
    expect(h.$$('[data-ref="approval"] button').map((b) => b.dataset.ref)).toEqual(['allow', 'deny']);
    expect(h.$('[data-ref="approval"] [data-ref="diff"]')).toBeNull();
    expect(h.$('[data-ref="approval-question"]')!.textContent!.trim()).toBe('This reaches outside the project. Allow it?');
  });

  it('settled elsewhere (another tab, a stop): the buttons go; stopped, timed out and cancelled cards say why', async () => {
    const client = new FakeChatClient();
    waitingSession(client);
    const h = mount(client);
    await opened(h);
    client.emit('s', { type: 'part-update', messageId: 'a1', partId: 'edit', patch: { state: 'denied', approval: { id: 'ap1', canAllowSession: true, decision: 'deny' }, error: 'Stopped before you answered.' } });
    const card = h.$('[data-part="tool"]')!;
    expect(card.querySelectorAll('button[data-ref="allow"]')).toHaveLength(0);
    expect(card.querySelector('[data-ref="error"]')!.textContent).toBe('Stopped before you answered.');
    client.emit('s', { type: 'part-update', messageId: 'a1', partId: 'edit', patch: { state: 'error', approval: { id: 'ap1', canAllowSession: true }, error: 'Approval timed out.' } });
    expect(card.dataset.state).toBe('error');
    expect(card.querySelector('[data-ref="approval"]')!.classList.contains('hidden')).toBe(true);
    expect(card.querySelector('[data-ref="error"]')!.textContent).toBe('Approval timed out.');
  });

  it('an answer the engine did not take: the buttons come back, and the reason shows', async () => {
    const client = new FakeChatClient();
    waitingSession(client);
    let release!: () => void;
    client.decideApproval.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ ok: false, status: 0, error: 'FluidCAD did not answer.' });
    }));
    const h = mount(client);
    await opened(h);
    h.$<HTMLButtonElement>('[data-ref="allow"]')!.click();
    await settle();
    // While it goes, the answers wait.
    expect(h.$$<HTMLButtonElement>('[data-ref="approval"] button').every((b) => b.disabled)).toBe(true);
    release();
    await settle();
    expect(h.$$<HTMLButtonElement>('[data-ref="approval"] button').every((b) => !b.disabled)).toBe(true);
    expect(h.$('[data-ref="status"]')!.textContent).toContain('FluidCAD did not answer.');
  });
});

describe('the permission mode in the header', () => {
  it('starts from Settings, switches from its menu, is remembered, and goes with the next message and Continue', async () => {
    const h = mount(new FakeChatClient(), { permissionMode: 'ask' });
    await opened(h);
    const button = h.$<HTMLButtonElement>('[data-ref="mode"]')!;
    expect(button.dataset.mode).toBe('ask');
    expect(button.textContent!.trim()).toBe('Ask');
    expect(button.getAttribute('aria-label')).toBe('Permission mode: Ask before edits');
    button.click();
    const menu = h.container.querySelector('[data-ref="mode-menu"]')!;
    const rows = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], button')].filter((r) => r.textContent);
    expect(rows.map((r) => r.textContent!.trim())).toEqual(['Ask before edits', 'Apply edits automatically']);
    rows[1].click();
    expect(h.onPermissionModeChosen).toHaveBeenCalledWith('auto-edits');
    expect(button.dataset.mode).toBe('auto-edits');
    expect(button.textContent!.trim()).toBe('Auto-apply');
    expect(button.title).toContain('Apply edits automatically');

    h.type('add a fillet');
    h.key('Enter');
    await settle();
    expect(h.client.sent[0].message.mode).toBe('auto-edits');
  });

  it('Settings → Agent saved again decides; Continue goes in the current mode', async () => {
    const client = new FakeChatClient();
    client.addSession({ id: 's', title: 'S', status: { state: 'interrupted', reason: 'The app restarted.' } });
    const h = mount(client, { permissionMode: 'auto-edits' });
    await opened(h);
    expect(h.$('[data-ref="mode"]')!.dataset.mode).toBe('auto-edits');
    h.panel.setMode('ask');
    h.settings.permissionMode = 'auto-edits';
    h.panel.settingsChanged();
    expect(h.$('[data-ref="mode"]')!.dataset.mode).toBe('auto-edits');
    h.$<HTMLButtonElement>('[data-ref="continue"]')!.click();
    await settle();
    expect(client.continueTurn).toHaveBeenCalledWith('s', 'auto-edits');
  });
});

/** Three ended turns: the first and the third changed files, the second did not. */
function turnsSession(client: FakeChatClient, status: SessionStatus = { state: 'idle' }) {
  const messages: ChatMessage[] = [];
  for (const n of [1, 2, 3]) {
    messages.push({ id: `u${n}`, role: 'user', turnId: `t${n}`, createdAt: '', parts: [{ type: 'text', id: `u${n}t`, text: `turn ${n}` }] });
    messages.push({ id: `a${n}`, role: 'assistant', turnId: `t${n}`, createdAt: '', parts: [{ type: 'text', id: `a${n}t`, text: 'Done.' }] });
  }
  const turns: TurnRecord[] = [
    { id: 't1', userMessageId: 'u1', revertible: true, files: ['plate.part.js'], endedAt: 'x', endReason: 'done' },
    { id: 't2', userMessageId: 'u2', revertible: false, endedAt: 'x', endReason: 'done' },
    { id: 't3', userMessageId: 'u3', revertible: true, files: ['lid.part.js', 'plate.part.js'], endedAt: 'x', endReason: 'done' },
  ];
  return client.addSession({ id: 's', title: 'Turns', status, messages, turns });
}

describe('Revert this turn (§12.2)', () => {
  const actions = (h: ReturnType<typeof mount>, id: string) => h.$(`[data-message-id="${id}"] [data-ref="actions"]`)!;

  it('is offered under the user message of each turn with changes; confirms with the files and the later turns; then marks them Reverted', async () => {
    const client = new FakeChatClient();
    turnsSession(client);
    const h = mount(client);
    await opened(h);
    expect(actions(h, 'u1').querySelector('[data-ref="revert"]')!.textContent!.trim()).toBe('Revert this turn');
    expect(actions(h, 'u2').querySelector('[data-ref="revert"]')).toBeNull();
    expect(actions(h, 'u3').querySelector('[data-ref="revert"]')).not.toBeNull();
    // Assistant messages carry no revert.
    expect(h.$('[data-message-id="a1"] [data-ref="revert"]')).toBeNull();

    actions(h, 'u1').querySelector<HTMLButtonElement>('[data-ref="revert"]')!.click();
    await settle();
    expect(h.confirm).toHaveBeenCalledTimes(1);
    const asked = h.confirm.mock.calls[0][0];
    expect(asked.title).toBe('Revert this turn');
    expect(asked.message).toContain('The later turn that changed files is reverted too.');
    expect(asked.items).toEqual(['plate.part.js', 'lid.part.js']);
    expect(asked.confirmLabel).toBe('Revert 2 turns');
    expect(client.revert).toHaveBeenCalledWith('s', 't1');

    // Both turns are marked; the outcome shows under the turn asked on.
    expect(actions(h, 'u1').querySelector('[data-ref="reverted"]')!.textContent!.trim()).toBe('Reverted');
    expect(actions(h, 'u3').querySelector('[data-ref="reverted"]')).not.toBeNull();
    expect(h.$$('[data-ref="revert"]')).toHaveLength(0);
    const outcome = actions(h, 'u1').querySelector<HTMLElement>('[data-ref="revert-outcome"]')!;
    expect(outcome.dataset.outcome).toBe('done');
    expect(outcome.querySelector('[data-ref="restored"]')!.textContent).toBe('Put back 2 files: lid.part.js, plate.part.js.');
    outcome.querySelector<HTMLButtonElement>('[data-ref="dismiss-revert"]')!.click();
    expect(h.$('[data-ref="revert-outcome"]')).toBeNull();
  });

  it('the last turn alone: no word of later turns; cancelling the confirm reverts nothing', async () => {
    const client = new FakeChatClient();
    turnsSession(client);
    const h = mount(client);
    await opened(h);
    h.confirm.mockResolvedValueOnce(false);
    actions(h, 'u3').querySelector<HTMLButtonElement>('[data-ref="revert"]')!.click();
    await settle();
    const asked = h.confirm.mock.calls[0][0];
    expect(asked.message).not.toContain('later');
    expect(asked.items).toEqual(['lid.part.js', 'plate.part.js']);
    expect(asked.confirmLabel).toBe('Revert');
    expect(client.revert).not.toHaveBeenCalled();
    expect(actions(h, 'u3').querySelector('[data-ref="revert"]')).not.toBeNull();
  });

  it('files that could not be put back are listed with why, and the turn stays revertible', async () => {
    const client = new FakeChatClient();
    turnsSession(client);
    client.revertAnswer = {
      ok: true,
      value: { restored: [], failed: [{ path: 'lid.part.js', error: 'The file has unsaved changes in the editor. Save or discard them, then revert again.' }] },
    };
    const h = mount(client);
    await opened(h);
    actions(h, 'u3').querySelector<HTMLButtonElement>('[data-ref="revert"]')!.click();
    await settle();
    const outcome = actions(h, 'u3').querySelector<HTMLElement>('[data-ref="revert-outcome"]')!;
    expect(outcome.dataset.outcome).toBe('failed');
    expect(outcome.textContent).toContain('Could not put back:');
    expect(outcome.querySelector('[data-ref="failed"]')!.textContent).toBe('lid.part.js — The file has unsaved changes in the editor. Save or discard them, then revert again.');
    expect(outcome.querySelector('[data-ref="restored"]')).toBeNull();
    expect(actions(h, 'u3').querySelector<HTMLButtonElement>('[data-ref="revert"]')!.disabled).toBe(false);

    // A refusal (409: a turn started meanwhile) says so too.
    client.revertAnswer = { ok: false, status: 409, error: 'Stop the running turn before reverting.' };
    actions(h, 'u3').querySelector<HTMLButtonElement>('[data-ref="revert"]')!.click();
    await settle();
    expect(actions(h, 'u3').querySelector('[data-ref="revert-outcome"]')!.textContent).toContain('Not reverted: Stop the running turn before reverting.');
  });

  it('is disabled while a turn runs, and appears live when a turn keeps its first checkpoint', async () => {
    const client = new FakeChatClient();
    turnsSession(client);
    const h = mount(client);
    await opened(h);
    h.type('one more');
    h.key('Enter');
    await settle();
    const button = actions(h, 'u1').querySelector<HTMLButtonElement>('[data-ref="revert"]')!;
    expect(button.disabled).toBe(true);
    button.click();
    await settle();
    expect(h.confirm).not.toHaveBeenCalled();
    // The new turn (`user-1` / `turn-1` in the fake) changes a file.
    expect(actions(h, 'user-1').querySelector('[data-ref="revert"]')).toBeNull();
    client.emit('s', { type: 'checkpoint', turnId: 'turn-1', files: ['plate.part.js'] });
    expect(actions(h, 'user-1').querySelector<HTMLButtonElement>('[data-ref="revert"]')!.disabled).toBe(true);
    const a = client.startAssistant('s', 'assistant-4');
    client.finish('s', a);
    expect(actions(h, 'user-1').querySelector<HTMLButtonElement>('[data-ref="revert"]')!.disabled).toBe(false);
    expect(actions(h, 'u1').querySelector<HTMLButtonElement>('[data-ref="revert"]')!.disabled).toBe(false);
  });
});

describe('the dirty-buffer card (§12.2)', () => {
  it('names the file with unsaved changes and opens it in the editor', async () => {
    const client = new FakeChatClient();
    client.addSession({
      id: 's',
      title: 'S',
      messages: [{ id: 'a1', role: 'assistant', turnId: 't1', createdAt: '', parts: [editPart({
        name: 'write_file',
        title: 'Write bracket.fluid.js',
        state: 'error',
        approval: undefined,
        errorCode: 'dirty-buffer',
        error: 'Not written: bracket.fluid.js has unsaved changes in the editor. Save it, then ask again.',
        output: { text: JSON.stringify({ code: 'dirty-buffer', message: 'Refusing to write "/w/bracket.fluid.js" — the editor has unsaved changes.', details: { dirtyFiles: ['/w/bracket.fluid.js'] } }) },
      })] }],
    });
    const h = mount(client);
    await opened(h);
    const card = h.$('[data-part="tool"]')!;
    expect(card.dataset.errorCode).toBe('dirty-buffer');
    const dirty = card.querySelector('[data-ref="dirty-buffer"]')!;
    expect(dirty.classList.contains('hidden')).toBe(false);
    expect(dirty.querySelector('[data-ref="dirty-file"]')!.textContent).toBe('bracket.fluid.js');
    expect(dirty.textContent).toContain('has unsaved changes in the editor');
    // Said once: the plain error line stays out of the way.
    expect(card.querySelector('[data-ref="error"]')!.classList.contains('hidden')).toBe(true);
    dirty.querySelector<HTMLButtonElement>('[data-ref="open-file"]')!.click();
    expect(h.openSource).toHaveBeenCalledWith('/w/bracket.fluid.js', 1, 1);
  });
});
