// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel, type ChatConfirmOptions, type ChatPanelDeps, type ChatPanelSettings } from '../src/ui/chat/chat-panel';
import type { AgentInstall, AgentKind, AgentModel, ApiProviderStatus, ChangePreview, ChangePreviewSide, ChatMessage, ParamsPart, PermissionMode, QuestionPart, SessionStatus, ToolPart, TurnRecord, VariantTile, VariantsPart } from '../src/ui/chat/chat-types';
import type { ParamCardDefinition, ParamCardHost, ParamCardModel } from '../src/ui/chat/parts/params-part';
import { factChanges } from '../src/ui/chat/parts/build-facts';
import { duration } from '../src/ui/chat/parts/change-preview';
import { factLines } from '../src/ui/chat/parts/variants-part';
import { LeftSlot } from '../src/ui/left-slot';
import { closePopupMenu } from '../src/ui/popup-menu';
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

function mount(client = new FakeChatClient(), settings: Partial<ChatPanelSettings> = {}, deps: Partial<ChatPanelDeps> = {}) {
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
  const onAgentChosen = vi.fn((kind: AgentKind) => {
    current.defaultAgent = kind;
  });
  const onModelChosen = vi.fn((kind: AgentKind, model: string) => {
    current[kind === 'api' ? 'apiModel' : kind === 'codex' ? 'codexModel' : 'claudeModel'] = model === 'default' ? undefined : model;
  });
  const onEffortChosen = vi.fn((kind: AgentKind, effort: string) => {
    current[kind === 'api' ? 'apiEffort' : kind === 'codex' ? 'codexEffort' : 'claudeEffort'] = effort === '' ? undefined : effort;
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
    onAgentChosen,
    onPermissionModeChosen,
    onModelChosen,
    onEffortChosen,
    onOpenChange: (open) => events.push(open ? 'agent open' : 'agent closed'),
    timers,
    ...deps,
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
  return { client, panel, container, events, slot, editor, openExternal, openSettings, openSource, confirm, onAgentChosen, onPermissionModeChosen, onModelChosen, onEffortChosen, timers, settings: current, $, $$, input, sendButton, type, key, width };
}

/** Open a chip's menu (it opens in the panel's container) and read its rows' labels; the menu closes again. */
function menuRows(h: ReturnType<typeof mount>, chip: HTMLElement, ref: string): string[] {
  chip.click();
  const menu = h.container.querySelector(`[data-ref="${ref}"]`)!;
  const rows = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((r) => r.textContent!.trim());
  closePopupMenu();
  return rows;
}

/** A chip's label, without its icons. */
function label(chip: HTMLElement): string {
  return chip.querySelector('.chat-chip-label')!.textContent!;
}

/** Pick the row labelled `label` in a chip's menu. */
function pick(h: ReturnType<typeof mount>, chip: HTMLElement, ref: string, label: string): void {
  chip.click();
  const menu = h.container.querySelector(`[data-ref="${ref}"]`)!;
  const row = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((r) => r.textContent!.trim() === label);
  expect(row, `${label} in ${ref}`).toBeDefined();
  row!.click();
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
    expect(h.$('[data-ref="welcome"]')!.textContent).toContain('Claude Code');
    // One agent installed: the chip says how Claude is paid for, and its menu has Manage.
    expect(label(h.$('[data-ref="agent-picker"]')!)).toBe('Claude Code');
    expect(h.$$('img')).toHaveLength(0);
  });
});

describe('the empty states (§9.1)', () => {
  it('not found: what it needs, the install page through the host, where FluidCAD looks, Check again', async () => {
    const client = new FakeChatClient();
    client.agentsValue = [FakeChatClient.install({ path: null, version: null, supported: false, loggedIn: null, authMethod: null, problem: 'Claude Code was not found on your PATH or in the usual install folders. Install it, then check again.' }), FakeChatClient.codexUnsupported()];
    const h = mount(client);
    await opened(h);
    const setup = h.$('[data-ref="setup"]')!;
    expect(setup.dataset.state).toBe('not-found');
    expect(setup.textContent).toContain('The Agent needs Claude Code');
    expect(h.$('[data-ref="where"]')!.textContent).toBe(
      'FluidCAD looks for Claude Code on your PATH and in the usual install folders. Once it is installed, check again.',
    );
    // The program paths are not set in Settings any more: nothing points there.
    expect(setup.textContent).not.toContain('Settings');
    expect(h.$('[data-ref="open-settings"]')).toBeNull();
    expect(h.$('[data-ref="composer"]')!.classList.contains('hidden')).toBe(true);
    h.$<HTMLButtonElement>('[data-ref="install-link"]')!.click();
    expect(h.openExternal).toHaveBeenCalledWith('https://code.claude.com/docs/en/setup');

    // Installed meanwhile: Check again detects afresh and the composer comes.
    client.recheckValue = [FakeChatClient.install()];
    h.$<HTMLButtonElement>('[data-ref="check-again"]')!.click();
    await settle();
    expect(client.agents).toHaveBeenLastCalledWith(true);
    expect(h.$('[data-ref="setup"]')).toBeNull();
    expect(h.$('[data-ref="welcome"]')).not.toBeNull();
    expect(h.$('[data-ref="composer"]')!.classList.contains('hidden')).toBe(false);
  });

  it('a stored path that is not the program says so', async () => {
    const client = new FakeChatClient();
    client.agentsValue = [FakeChatClient.install({ path: '/nope/claude', version: null, supported: false, loggedIn: null, problem: "The Claude Code path in FluidCAD's preferences (agent.claudePath) is not an executable file: /nope/claude" })];
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
    // Claude Code signs in from a terminal only.
    expect(client.startLogin).not.toHaveBeenCalled();
  });

  it('Codex not signed in: Sign in opens the ChatGPT page in the browser, waits, then detects again', async () => {
    const client = new FakeChatClient();
    const codexOut = FakeChatClient.install({ kind: 'codex', loggedIn: false, authMethod: null, problem: 'Codex is not signed in.' });
    client.agentsValue = [codexOut];
    const h = mount(client, { defaultAgent: 'codex' });
    await opened(h);
    const setup = h.$('[data-ref="setup"]')!;
    expect(setup.dataset.state).toBe('signed-out');
    // The terminal command stays as the fallback.
    expect(h.$('[data-ref="command"] code')!.textContent).toBe('codex login');
    h.$<HTMLButtonElement>('[data-ref="sign-in"]')!.click();
    await settle();
    expect(client.startLogin).toHaveBeenCalledWith('codex');
    expect(h.openExternal).toHaveBeenCalledWith('https://auth.example.invalid/oauth/authorize?state=x');
    expect(h.$('[data-ref="sign-in-waiting"]')!.textContent).toMatch(/Finish signing in in your browser/);
    // Not done yet: still waiting; the page can be opened again.
    await h.timers.fire();
    expect(client.loginStatus).toHaveBeenCalledWith('codex', 'login-1');
    h.$<HTMLButtonElement>('[data-ref="sign-in-reopen"]')!.click();
    expect(h.openExternal).toHaveBeenCalledTimes(2);
    // Done: detection runs again and the composer is there.
    client.loginState = { state: 'done' };
    client.recheckValue = [FakeChatClient.install({ kind: 'codex', authMethod: null })];
    await h.timers.fire();
    await settle();
    expect(client.agents).toHaveBeenLastCalledWith(true);
    expect(h.$('[data-ref="welcome"]')).not.toBeNull();
    expect(h.panel.state.signIn).toBeNull();
    // Nothing about the account is on the page.
    expect(h.panel.el.textContent).not.toMatch(/@/);
  });

  it('a Codex sign-in that fails says why and can be tried again; Cancel stops one in progress', async () => {
    const client = new FakeChatClient();
    client.agentsValue = [FakeChatClient.install({ kind: 'codex', loggedIn: false, authMethod: null })];
    const h = mount(client, { defaultAgent: 'codex' });
    await opened(h);
    h.$<HTMLButtonElement>('[data-ref="sign-in"]')!.click();
    await settle();
    h.$<HTMLButtonElement>('[data-ref="sign-in-cancel"]')!.click();
    await settle();
    expect(client.cancelLogin).toHaveBeenCalledWith('codex', 'login-1');
    expect(h.$('[data-ref="sign-in"]')).not.toBeNull();

    client.loginState = { state: 'failed', error: 'Login server error: denied' };
    h.$<HTMLButtonElement>('[data-ref="sign-in"]')!.click();
    await settle();
    await h.timers.fire();
    await settle();
    expect(h.$('[data-ref="sign-in-error"]')!.textContent).toBe('Signing in did not finish: Login server error: denied');
    expect(h.$('[data-ref="sign-in"]')).not.toBeNull();
  });

  it('ready: says Claude Code runs on the subscription, naming the account when known', async () => {
    const h = mount();
    await opened(h);
    expect(h.$('[data-ref="welcome"] [data-ref="auth"]')!.textContent).toBe('Claude Code runs on your Claude subscription.');
    expect(label(h.$('[data-ref="agent-picker"]')!)).toBe('Claude Code');

    const client = new FakeChatClient();
    client.agentsValue = [FakeChatClient.install({ account: 'me@example.com' })];
    const k = mount(client);
    await opened(k);
    expect(k.$('[data-ref="welcome"] [data-ref="auth"]')!.textContent).toBe('Claude Code runs on your Claude subscription (me@example.com).');
    const chip = k.$<HTMLElement>('[data-ref="agent-picker"]')!;
    expect(chip.dataset.tone).toBeUndefined();
    expect(k.$('[data-ref="welcome"]')!.textContent).not.toContain('ANTHROPIC_API_KEY');
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
  });
});

describe('the chips under the message box', () => {
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

  it('the model chip offers Default and the aliases, and any model by name', async () => {
    const h = mount(new FakeChatClient(), { claudeModel: 'haiku' });
    await opened(h);
    const chip = () => h.$<HTMLButtonElement>('[data-ref="composer-controls"] [data-ref="model-picker"]')!;
    expect(label(chip())).toBe('Haiku');
    expect(chip().dataset.value).toBe('haiku');
    expect(menuRows(h, chip(), 'model-menu')).toEqual(['Default', 'Opus', 'Sonnet', 'Haiku', 'Fable', 'Other model…']);
    pick(h, chip(), 'model-menu', 'Sonnet');
    expect(label(chip())).toBe('Sonnet');
    h.type('one');
    h.key('Enter');
    await settle();
    expect(h.client.sent[0].message.model).toBe('sonnet');
    const id = h.client.sent[0].id;
    h.client.emit(id, { type: 'status', status: { state: 'idle' } });

    pick(h, chip(), 'model-menu', 'Other model…');
    const name = h.$<HTMLInputElement>('[data-ref="model-input"]')!;
    name.value = 'claude-sonnet-4-5';
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(chip().dataset.value).toBe('claude-sonnet-4-5');
    h.type('two');
    h.key('Enter');
    await settle();
    expect(h.client.sent[1].message.model).toBe('claude-sonnet-4-5');
  });

  it("the model and effort picked on the chips are the agent's defaults for new chats, after a reload too", async () => {
    const h = mount(new FakeChatClient(), { claudeModel: 'haiku', claudeEffort: 'low' });
    await opened(h);
    const model = (k = h) => k.$<HTMLButtonElement>('[data-ref="composer-controls"] [data-ref="model-picker"]')!;
    const effort = (k = h) => k.$<HTMLButtonElement>('[data-ref="effort-picker"]')!;
    pick(h, model(), 'model-menu', 'Sonnet');
    expect(h.onModelChosen).toHaveBeenLastCalledWith('claude', 'sonnet');
    pick(h, effort(), 'effort-menu', 'Max');
    expect(h.onEffortChosen).toHaveBeenLastCalledWith('claude', 'max');
    pick(h, model(), 'model-menu', 'Other model…');
    const name = h.$<HTMLInputElement>('[data-ref="model-input"]')!;
    name.value = 'claude-opus-4-1';
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.onModelChosen).toHaveBeenLastCalledWith('claude', 'claude-opus-4-1');
    // A name the engine would refuse is not kept.
    pick(h, model(), 'model-menu', 'Other model…');
    const bad = h.$<HTMLInputElement>('[data-ref="model-input"]')!;
    bad.value = 'not a model';
    bad.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.onModelChosen).toHaveBeenCalledTimes(2);

    // The page reloads: a new chat starts with what was picked last.
    const again = mount(new FakeChatClient(), { ...h.settings });
    await opened(again);
    expect(model(again).dataset.value).toBe('claude-opus-4-1');
    expect(effort(again).dataset.value).toBe('max');

    // Default on either chip goes back to the program's own.
    pick(again, model(again), 'model-menu', 'Default');
    expect(again.onModelChosen).toHaveBeenLastCalledWith('claude', 'default');
    pick(again, effort(again), 'effort-menu', 'Default');
    expect(again.onEffortChosen).toHaveBeenLastCalledWith('claude', '');
    expect(again.settings.claudeModel).toBeUndefined();
    expect(again.settings.claudeEffort).toBeUndefined();
  });

  it('the agent chip of a new chat lists the agents that can run, then Manage, which opens Settings', async () => {
    const one = new FakeChatClient();
    one.agentsValue = [FakeChatClient.install(), FakeChatClient.codexUnsupported()];
    const h = mount(one);
    await opened(h);
    const only = h.$<HTMLButtonElement>('[data-ref="composer-controls"] [data-ref="agent-picker"]')!;
    expect(label(only)).toBe('Claude Code');
    expect(menuRows(h, only, 'agent-menu')).toEqual(['Claude Code', 'Manage']);
    pick(h, only, 'agent-menu', 'Manage');
    expect(h.openSettings).toHaveBeenCalledTimes(1);
    expect(h.panel.state.agent).toBe('claude');

    const two = new FakeChatClient();
    two.agentsValue = [FakeChatClient.install(), FakeChatClient.install({ kind: 'codex', authMethod: null })];
    const k = mount(two);
    await opened(k);
    const chip = () => k.$<HTMLButtonElement>('[data-ref="composer-controls"] [data-ref="agent-picker"]')!;
    expect(label(chip())).toBe('Claude Code');
    expect(menuRows(k, chip(), 'agent-menu')).toEqual(['Claude Code', 'Codex', 'Manage']);
    pick(k, chip(), 'agent-menu', 'Codex');
    expect(label(chip())).toBe('Codex');
    expect(k.panel.state.agent).toBe('codex');
    // In a chat the agent is fixed: its name, without a menu.
    k.type('hello');
    k.key('Enter');
    await settle();
    expect(k.$('[data-ref="agent-picker"]')).toBeNull();
    expect(label(k.$('[data-ref="composer-controls"] [data-ref="agent-name"]')!)).toBe('Codex');
  });

  it('names the account each CLI is signed in with, in parentheses', async () => {
    const client = new FakeChatClient();
    client.agentsValue = [
      FakeChatClient.install({ account: 'me@example.com' }),
      FakeChatClient.install({ kind: 'codex', authMethod: null, account: 'gpt@example.com' }),
    ];
    const h = mount(client);
    await opened(h);
    const chip = h.$<HTMLButtonElement>('[data-ref="composer-controls"] [data-ref="agent-picker"]')!;
    expect(label(chip)).toBe('Claude Code (me@example.com)');
    expect(menuRows(h, chip, 'agent-menu')).toEqual(['Claude Code (me@example.com)', 'Codex (gpt@example.com)', 'Manage']);
  });

  it('the agent chip shows the CLIs that cannot run yet as disabled rows saying why', async () => {
    const client = new FakeChatClient();
    client.agentsValue = [
      FakeChatClient.install(),
      FakeChatClient.install({ kind: 'codex', authMethod: null, loggedIn: false }),
      FakeChatClient.apiInstall([FakeChatClient.provider({ id: 'openrouter', ready: true })]),
    ];
    const h = mount(client);
    await opened(h);
    const chip = h.$<HTMLButtonElement>('[data-ref="composer-controls"] [data-ref="agent-picker"]')!;
    expect(menuRows(h, chip, 'agent-menu')).toEqual(['Claude Code', 'Codex (Not signed in)', 'OpenRouter', 'Manage']);
    chip.click();
    const row = [...h.container.querySelectorAll<HTMLButtonElement>('[data-ref="agent-menu"] [role="menuitem"]')]
      .find((r) => r.textContent!.trim() === 'Codex (Not signed in)')!;
    expect(row.disabled).toBe(true);
    expect(row.title).toContain('not signed in');
    row.click();
    expect(h.panel.state.agent).toBe('claude');
    closePopupMenu();

    const missing = new FakeChatClient();
    missing.agentsValue = [
      FakeChatClient.install(),
      FakeChatClient.install({ kind: 'codex', path: null, version: null, supported: false, loggedIn: null, authMethod: null }),
    ];
    const k = mount(missing);
    await opened(k);
    const other = k.$<HTMLButtonElement>('[data-ref="composer-controls"] [data-ref="agent-picker"]')!;
    expect(menuRows(k, other, 'agent-menu')).toEqual(['Claude Code', 'Codex (Not installed)', 'Manage']);
  });

  it('puts the settings under the message box as chips, none in the header, Send at the bottom right', async () => {
    const h = mount();
    await opened(h);
    const controls = h.$('[data-ref="composer"] [data-ref="composer-controls"]')!;
    expect([...controls.querySelectorAll<HTMLElement>('.chat-chip:not(.hidden)')].map((c) => c.dataset.ref)).toEqual([
      'agent-picker', 'model-picker', 'effort-picker', 'mode',
    ]);
    // The chips row and Send share the footer under the textarea.
    const footer = controls.parentElement!;
    expect(footer.previousElementSibling).toBe(h.input());
    expect(footer.lastElementChild).toBe(h.$('[data-ref="send"]'));
    expect(h.input().rows).toBe(2);
    // Every chip with a menu has a chevron icon, not a ▾ glyph.
    for (const chip of controls.querySelectorAll<HTMLElement>('button.chat-chip')) {
      expect(chip.querySelector('.chat-chip-chevron svg')).not.toBeNull();
      expect(chip.textContent).not.toContain('▾');
    }
    expect(h.panel.el.querySelectorAll('select')).toHaveLength(0);
  });

  it("the effort chip offers Claude Code's levels, low to max, and sends the one picked", async () => {
    const h = mount(new FakeChatClient(), { claudeEffort: 'xhigh' });
    await opened(h);
    const chip = () => h.$<HTMLButtonElement>('[data-ref="effort-picker"]')!;
    expect(menuRows(h, chip(), 'effort-menu')).toEqual([
      'Default', 'Low', 'Medium', 'High', 'Extra high', 'Max',
    ]);
    expect(chip().dataset.value).toBe('xhigh');
    expect(label(chip())).toBe('Extra high effort');
    pick(h, chip(), 'effort-menu', 'Max');
    h.type('think hard');
    h.key('Enter');
    await settle();
    expect(h.client.sent[0].message.effort).toBe('max');
    h.client.emit(h.client.sent[0].id, { type: 'status', status: { state: 'idle' } });

    // "Default effort" sends none: the CLI's own.
    pick(h, chip(), 'effort-menu', 'Default');
    expect(label(chip())).toBe('Effort');
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
    const effort = () => h.$<HTMLButtonElement>('[data-ref="effort-picker"]')!;
    const levels = () => menuRows(h, effort(), 'effort-menu');
    // Default is Luna, which has no "ultra": the default holds.
    expect(levels()).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
    expect(effort().dataset.value).toBe('');
    pick(h, h.$<HTMLButtonElement>('[data-ref="model-picker"]')!, 'model-menu', 'Terra');
    expect(levels()).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max', 'Ultra']);
    expect(effort().dataset.value).toBe('ultra');
    h.type('go');
    h.key('Enter');
    await settle();
    expect(client.sent[0].message).toMatchObject({ model: 'gpt-terra', effort: 'ultra' });
  });
});

// The `api` agent (docs/agent-chat-plan.md §20): FluidCAD's own agent loop on
// a provider the user has a key for, or a local server. Each ready provider
// is an entry of the agent picker; an `api` chat stays on its provider.
describe('the API agent (§20)', () => {
  const ANTHROPIC = FakeChatClient.provider({ id: 'anthropic', hasKey: true, keySource: 'stored', ready: true });
  const OPENAI_NONE = FakeChatClient.provider({ id: 'openai' });
  const OPENROUTER = FakeChatClient.provider({ id: 'openrouter', hasKey: true, keySource: 'env', ready: true });
  const OLLAMA = FakeChatClient.provider({ id: 'ollama', label: 'Ollama', baseURL: 'http://localhost:11434/v1' });
  const API_MODELS: AgentModel[] = [
    { id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'anthropic', isDefault: true, efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'high' },
    { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic', efforts: ['low', 'medium', 'high'] },
    { id: 'openrouter/anthropic/claude-opus-5-5', provider: 'openrouter', isDefault: true },
    { id: 'openrouter/openai/gpt-x', provider: 'openrouter' },
  ];

  /** Claude Code and Codex ready, and the API agent with `providers` (the engine may list a server first). */
  function withApi(providers: ApiProviderStatus[], clis: AgentInstall[] = [FakeChatClient.install(), FakeChatClient.install({ kind: 'codex', authMethod: null })]) {
    const client = new FakeChatClient();
    client.agentsValue = [...clis, FakeChatClient.apiInstall(providers)];
    client.apiModelsValue = API_MODELS;
    return client;
  }

  it('a long model list gets a search field and scrolls; Other model… starts from what was searched', async () => {
    const client = withApi([OPENROUTER]);
    client.apiModelsValue = Array.from({ length: 40 }, (_, i): AgentModel => ({
      id: `openrouter/vendor${i % 4}/model-${i}`,
      label: `Vendor ${i % 4}: Model ${i}`,
      provider: 'openrouter',
      ...(i === 0 ? { isDefault: true } : {}),
    }));
    const h = mount(client);
    await opened(h);
    pick(h, h.$<HTMLButtonElement>('[data-ref="composer-controls"] [data-ref="agent-picker"]')!, 'agent-menu', 'OpenRouter');
    await settle();
    const model = () => h.$<HTMLButtonElement>('[data-ref="composer-controls"] [data-ref="model-picker"]')!;
    model().click();
    const menu = h.container.querySelector<HTMLElement>('[data-ref="model-menu"]')!;
    const search = menu.querySelector<HTMLInputElement>('[data-ref="menu-search"]')!;
    expect(search.placeholder).toBe('Search models');
    expect(document.activeElement).toBe(search);
    const shown = () => [...menu.querySelectorAll<HTMLElement>('[data-ref="menu-list"] [role="menuitem"]:not(.hidden)')].map((r) => r.textContent!.trim());
    expect(shown()).toHaveLength(40);
    // By the name, or by the id.
    search.value = 'vendor 3: model 1';
    search.dispatchEvent(new Event('input'));
    expect(shown()).toEqual(['Vendor 3: Model 11', 'Vendor 3: Model 15', 'Vendor 3: Model 19', 'Vendor 3: Model 31']);
    search.value = 'vendor2/model-38';
    search.dispatchEvent(new Event('input'));
    expect(shown()).toEqual(['Vendor 2: Model 38']);
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(h.onModelChosen).toHaveBeenLastCalledWith('api', 'openrouter/vendor2/model-38');
    expect(label(model())).toBe('Vendor 2: Model 38');

    // Nothing found: Other model… takes the search as the name to type.
    model().click();
    const again = h.container.querySelector<HTMLElement>('[data-ref="model-menu"]')!;
    const field = again.querySelector<HTMLInputElement>('[data-ref="menu-search"]')!;
    field.value = 'acme/new-model';
    field.dispatchEvent(new Event('input'));
    [...again.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((r) => r.textContent!.trim() === 'Other model…')!.click();
    await settle();
    expect(h.$<HTMLInputElement>('[data-ref="model-input"]')!.value).toBe('acme/new-model');

    // A short list stays a plain menu.
    const k = mount(withApi([ANTHROPIC]));
    await opened(k);
    pick(k, k.$<HTMLButtonElement>('[data-ref="composer-controls"] [data-ref="agent-picker"]')!, 'agent-menu', 'Anthropic API');
    await settle();
    k.$<HTMLButtonElement>('[data-ref="composer-controls"] [data-ref="model-picker"]')!.click();
    expect(k.container.querySelector('[data-ref="model-menu"] [data-ref="menu-search"]')).toBeNull();
    closePopupMenu();
  });

  it('the chats menu names an api chat by its provider', async () => {
    const client = withApi([ANTHROPIC, OPENROUTER]);
    client.addSession({ id: 'p', title: 'On a key', agent: 'api', model: 'anthropic/claude-opus-5-5', updatedAt: new Date().toISOString() });
    client.addSession({ id: 'q', title: 'Not run yet', agent: 'api', model: null, updatedAt: '2026-11-17T08:00:00.000Z' });
    const h = mount(client);
    await opened(h);
    h.$<HTMLButtonElement>('[data-ref="sessions"]')!.click();
    await settle();
    const metas = [...h.container.querySelectorAll('[data-ref="session-menu"] [data-ref="session-meta"]')].map((t) => t.textContent!.split(' · ')[0]);
    expect(metas).toEqual(['Anthropic API', 'API']);
  });

  it('lists each ready provider after Claude Code and Codex, by its label', async () => {
    const h = mount(withApi([OLLAMA, ANTHROPIC, OPENAI_NONE, OPENROUTER]));
    await opened(h);
    const chip = h.$<HTMLButtonElement>('[data-ref="composer-controls"] [data-ref="agent-picker"]')!;
    expect(menuRows(h, chip, 'agent-menu')).toEqual(['Claude Code', 'Codex', 'Anthropic API', 'OpenRouter', 'Ollama', 'Manage']);
  });

  it("picking a provider starts an api chat on its default model; the model chip lists that provider's models only", async () => {
    const h = mount(withApi([ANTHROPIC, OPENAI_NONE, OPENROUTER]));
    await opened(h);
    const agent = () => h.$<HTMLButtonElement>('[data-ref="composer-controls"] [data-ref="agent-picker"]')!;
    const model = () => h.$<HTMLButtonElement>('[data-ref="composer-controls"] [data-ref="model-picker"]')!;
    const effort = () => h.$<HTMLButtonElement>('[data-ref="effort-picker"]');

    pick(h, agent(), 'agent-menu', 'OpenRouter');
    await settle();
    expect(label(agent())).toBe('OpenRouter');
    expect(h.panel.state.agent).toBe('api');
    expect(h.onAgentChosen).toHaveBeenLastCalledWith('api');
    // The provider is remembered with its model, so new chats start there.
    expect(h.onModelChosen).toHaveBeenLastCalledWith('api', 'openrouter/anthropic/claude-opus-5-5');
    // Its models only, named without the provider; no Default (no program to default to).
    expect(label(model())).toBe('anthropic/claude-opus-5-5');
    expect(menuRows(h, model(), 'model-menu')).toEqual(['anthropic/claude-opus-5-5', 'openai/gpt-x', 'Other model…']);
    // A model that takes no effort has no effort chip.
    expect(effort()).toBeNull();

    pick(h, agent(), 'agent-menu', 'Anthropic API');
    await settle();
    expect(label(agent())).toBe('Anthropic API');
    expect(label(model())).toBe('Claude Opus 5.5');
    expect(menuRows(h, model(), 'model-menu')).toEqual(['Claude Opus 5.5', 'Claude Sonnet 5', 'Other model…']);
    expect(menuRows(h, effort()!, 'effort-menu')).toEqual(['Default', 'Low', 'Medium', 'High', 'Max']);
    pick(h, model(), 'model-menu', 'Claude Sonnet 5');
    expect(h.onModelChosen).toHaveBeenLastCalledWith('api', 'anthropic/claude-sonnet-5');
    // The effort chip follows the model's own levels.
    expect(menuRows(h, effort()!, 'effort-menu')).toEqual(['Default', 'Low', 'Medium', 'High']);
    pick(h, effort()!, 'effort-menu', 'High');
    expect(h.onEffortChosen).toHaveBeenLastCalledWith('api', 'high');

    h.type('Make it 2 mm thicker.');
    h.key('Enter');
    await settle();
    expect(h.client.createSession).toHaveBeenCalledWith('api');
    expect(h.client.sent[0].message).toMatchObject({ model: 'anthropic/claude-sonnet-5', effort: 'high' });
    // In the chat the provider is fixed: its name, without a menu.
    expect(h.$('[data-ref="agent-picker"]')).toBeNull();
    const name = h.$<HTMLElement>('[data-ref="composer-controls"] [data-ref="agent-name"]')!;
    expect(label(name)).toBe('Anthropic API');
    expect(name.title).toBe('This chat runs on Anthropic API.');
    expect(menuRows(h, model(), 'model-menu')).toEqual(['Claude Opus 5.5', 'Claude Sonnet 5', 'Other model…']);
  });

  it('a new chat starts on the last provider and model used, or the first ready one', async () => {
    const h = mount(withApi([ANTHROPIC, OPENROUTER]), { defaultAgent: 'api', apiModel: 'openrouter/openai/gpt-x' });
    await opened(h);
    expect(label(h.$('[data-ref="agent-picker"]')!)).toBe('OpenRouter');
    expect(h.$('[data-ref="model-picker"]')!.dataset.value).toBe('openrouter/openai/gpt-x');

    // That provider is not ready any more: the first one that is, on its suggested model.
    const k = mount(withApi([ANTHROPIC, OPENAI_NONE]), { defaultAgent: 'api', apiModel: 'openai/gpt-y' });
    await opened(k);
    expect(label(k.$('[data-ref="agent-picker"]')!)).toBe('Anthropic API');
    expect(k.$('[data-ref="model-picker"]')!.dataset.value).toBe('anthropic/claude-opus-5-5');
  });

  it('on a local model: its name on the chip, any model by name, and no send without a model', async () => {
    const client = withApi([OLLAMA], [FakeChatClient.install({ path: null, version: null, supported: false, loggedIn: null, authMethod: null })]);
    client.apiModelsValue = [];
    const h = mount(client);
    await opened(h);
    // The only agent that runs: the chip says where it runs.
    expect(label(h.$('[data-ref="agent-picker"]')!)).toBe('Ollama');
    expect(h.$('[data-ref="welcome"]')!.textContent).toContain('The agent can model');
    const model = () => h.$<HTMLButtonElement>('[data-ref="composer-controls"] [data-ref="model-picker"]')!;
    expect(label(model())).toBe('Model');

    h.type('hello');
    h.key('Enter');
    await settle();
    expect(h.client.createSession).not.toHaveBeenCalled();
    expect(h.$('[data-ref="status-text"]')!.textContent).toBe('Choose a model on the model chip first.');

    pick(h, model(), 'model-menu', 'Other model…');
    const name = h.$<HTMLInputElement>('[data-ref="model-input"]')!;
    name.value = 'qwen3-vl:4b';
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(model().dataset.value).toBe('ollama/qwen3-vl:4b');
    expect(label(model())).toBe('qwen3-vl:4b');
    h.key('Enter');
    await settle();
    expect(h.client.sent[0].message.model).toBe('ollama/qwen3-vl:4b');
  });

  it('neither program installed: the not-found screen also offers an API key, through Settings', async () => {
    const client = new FakeChatClient();
    client.agentsValue = [
      FakeChatClient.install({ path: null, version: null, supported: false, loggedIn: null, authMethod: null }),
      FakeChatClient.codexUnsupported(),
      FakeChatClient.apiInstall(),
    ];
    const h = mount(client);
    await opened(h);
    const setup = h.$('[data-ref="setup"]')!;
    expect(setup.dataset.state).toBe('not-found');
    expect(setup.querySelector('h3')!.textContent).toBe('The Agent needs Claude Code or an API key');
    expect(h.$('[data-ref="api-option"]')!.textContent).toBe('Or run it on your own API key or a local model, such as Ollama:');
    h.$<HTMLButtonElement>('[data-ref="add-api-key"]')!.click();
    expect(h.openSettings).toHaveBeenCalledTimes(1);

    // A key added in Settings: the new chat moves to the API agent by itself.
    client.recheckValue = [client.agentsValue[0], client.agentsValue[1], FakeChatClient.apiInstall([ANTHROPIC])];
    client.apiModelsValue = API_MODELS;
    h.$<HTMLButtonElement>('[data-ref="check-again"]')!.click();
    await settle();
    await settle();
    expect(h.panel.state.agent).toBe('api');
    expect(h.$('[data-ref="welcome"]')).not.toBeNull();
    expect(label(h.$('[data-ref="agent-picker"]')!)).toBe('Anthropic API');
    expect(h.$('[data-ref="model-picker"]')!.dataset.value).toBe('anthropic/claude-opus-5-5');
  });

  it('the API agent with no provider ready: Add an API key opens Settings', async () => {
    const client = new FakeChatClient();
    client.agentsValue = [FakeChatClient.install({ path: null, version: null, supported: false, loggedIn: null, authMethod: null }), FakeChatClient.apiInstall()];
    const h = mount(client, { defaultAgent: 'api' });
    await opened(h);
    const setup = h.$('[data-ref="setup"]')!;
    expect(setup.dataset.state).toBe('signed-out');
    expect(setup.querySelector('h3')!.textContent).toBe('Add an API key');
    expect(setup.textContent).toContain('Anthropic, OpenAI or OpenRouter API key, or on a local model');
    // No program to install, update or sign in to.
    expect(h.$('[data-ref="install-link"], [data-ref="command"], [data-ref="sign-in"]')).toBeNull();
    expect(h.$('[data-ref="composer"]')!.classList.contains('hidden')).toBe(true);
    h.$<HTMLButtonElement>('[data-ref="add-api-key"]')!.click();
    expect(h.openSettings).toHaveBeenCalledTimes(1);
    expect(h.$('[data-ref="check-again"]')).not.toBeNull();
  });

  it("a chat whose provider is no longer ready says which, with the way to Settings", async () => {
    const client = withApi([ANTHROPIC, OPENAI_NONE]);
    client.addSession({
      id: 's',
      title: 'On OpenAI',
      agent: 'api',
      model: 'openai/gpt-y',
      messages: [{ id: 'u1', role: 'user', turnId: 't1', createdAt: '', parts: [{ type: 'text', id: 'x', text: 'hi' }] }],
      turns: [{ id: 't1', userMessageId: 'u1', revertible: false }],
    });
    const h = mount(client);
    await opened(h);
    expect(h.panel.state.session?.id).toBe('s');
    expect(label(h.$('[data-ref="agent-name"]')!)).toBe('OpenAI API');
    const setup = h.$('[data-ref="setup"]')!;
    expect(setup.dataset.state).toBe('signed-out');
    expect(setup.querySelector('h3')!.textContent).toBe('OpenAI API is not ready');
    expect(setup.textContent).toContain('No API key.');
    expect(h.$('[data-ref="composer"]')!.classList.contains('hidden')).toBe(true);
    h.$<HTMLButtonElement>('[data-ref="add-api-key"]')!.click();
    expect(h.openSettings).toHaveBeenCalled();
  });

  it('a turn on a provider key shows its cost; on a local server it costs nothing', async () => {
    const client = withApi([ANTHROPIC, OLLAMA]);
    const turns: TurnRecord[] = [{ id: 't1', userMessageId: 'u1', revertible: false, usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.0123 } }];
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', turnId: 't1', createdAt: '', parts: [{ type: 'text', id: 'x', text: 'hi' }] },
      { id: 'a1', role: 'assistant', turnId: 't1', createdAt: '', parts: [{ type: 'text', id: 'y', text: 'Hello.' }] },
    ];
    client.addSession({ id: 's', title: 'S', agent: 'api', model: 'anthropic/claude-opus-5-5', messages, turns });
    const h = mount(client);
    await opened(h);
    expect(h.$('[data-message-id="a1"] [data-ref="usage"]')!.textContent).toBe('1.2k in · 300 out · $0.01');
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

  it("asks about a package install by what it means: the package's code will run with the user's permissions", async () => {
    const client = new FakeChatClient();
    waitingSession(client, editPart({
      name: 'install_package',
      title: 'Install @acme/kit from the hub',
      kind: 'outside',
      input: { name: '@acme/kit' },
      diff: undefined,
      approval: { id: 'ap3', canAllowSession: false },
    }));
    const h = mount(client);
    await opened(h);
    expect(h.$('[data-ref="approval-question"]')!.textContent!.trim()).toBe("A package's code runs in FluidCAD with your permissions. Install it?");
    expect(h.$$('[data-ref="approval"] button').map((b) => b.dataset.ref)).toEqual(['allow', 'deny']);
    expect(h.$('[data-part="tool"]')!.textContent).toContain('Install @acme/kit from the hub');
  });

  /** An install waiting, with what the hub said of the package. */
  const installPart = (overrides: Partial<ToolPart> = {}) => editPart({
    name: 'install_package',
    title: 'Install @acme/kit from the hub',
    kind: 'outside',
    input: { name: '@acme/kit' },
    diff: undefined,
    approval: { id: 'ap3', canAllowSession: false, canAllowAlways: true },
    install: {
      state: 'ready',
      name: '@acme/kit',
      version: '0.2.0',
      target: null,
      upgrade: false,
      publisher: 'acme',
      description: 'Standoffs and <b>mounting</b> bosses.',
      license: 'MIT',
      installs: 1234,
      contents: { features: 2, parts: 1, assemblies: 0 },
      installed: [],
      pinned: null,
    },
    ...overrides,
  });

  it('an install shows a confirmation card: the package as the hub describes it, then Install, Always and Deny', async () => {
    const client = new FakeChatClient();
    waitingSession(client, installPart());
    const h = mount(client);
    await opened(h);
    const card = h.$('[data-ref="approval"] [data-ref="install"]')!;
    expect(card.dataset.state).toBe('ready');
    expect(card.querySelector('[data-ref="install-name"]')!.textContent).toBe('@acme/kit');
    expect(card.querySelector('[data-ref="install-version"]')!.textContent).toBe('0.2.0');
    expect(card.querySelector('[data-ref="install-meta"]')!.textContent).toBe('by acme · MIT · 1,234 installs');
    // The publisher's text is text: no markup of theirs reaches the page.
    const description = card.querySelector('[data-ref="install-description"]')!;
    expect(description.textContent).toBe('Standoffs and <b>mounting</b> bosses.');
    expect(description.querySelector('b')).toBeNull();
    expect(card.querySelector('[data-ref="install-facts"]')!.textContent).toBe('2 features, 1 part · Goes where Settings → Packages puts new packages');
    expect(h.$$('[data-ref="approval"] button').map((b) => [b.dataset.ref, b.textContent!.trim()])).toEqual([
      ['allow', 'Install'],
      ['allow-always', 'Always'],
      ['deny', 'Deny'],
    ]);
  });

  it('the install card says where the package goes, an upgrade, a copy already here and a deprecation; reading the hub, it says so', async () => {
    const client = new FakeChatClient();
    waitingSession(client, installPart({
      input: { name: '@acme/kit', target: 'project', upgrade: true },
      install: { state: 'ready', name: '@acme/kit', version: '0.2.0', target: 'project', upgrade: true, installed: ['0.2.0'], pinned: '0.1.0', deprecated: 'Use @acme/kit2.' },
    }));
    const h = mount(client);
    await opened(h);
    expect(h.$('[data-ref="install-facts"]')!.textContent).toBe('Copied into this project’s packages/ folder');
    expect(h.$('[data-ref="install-upgrade"]')!.textContent!.trim()).toBe('Moves this project up from 0.1.0');
    expect(h.$('[data-ref="install-local"]')!.textContent!.trim()).toBe('Already on this machine: nothing to download');
    expect(h.$('[data-ref="install-deprecated"]')!.textContent!.trim()).toBe('Deprecated: Use @acme/kit2.');

    client.emit('s', { type: 'part-update', messageId: 'a1', partId: 'edit', patch: { install: { state: 'loading', name: '@acme/kit', version: null, target: null, upgrade: false } } });
    expect(h.$('[data-ref="install"]')!.dataset.state).toBe('loading');
    expect(h.$('[data-ref="install-loading"]')!.textContent).toBe('Reading the package on the hub…');
    expect(h.$('[data-ref="install-version"]')).toBeNull();
    // The buttons work while the hub is read.
    expect(h.$$<HTMLButtonElement>('[data-ref="approval"] button').every((b) => !b.disabled)).toBe(true);
  });

  it('Always sends its decision, tells the page, and the card says installs are allowed always, with a way to change it', async () => {
    const client = new FakeChatClient();
    waitingSession(client, installPart());
    const onInstallsAlwaysAllowed = vi.fn();
    const h = mount(client, {}, { onInstallsAlwaysAllowed });
    await opened(h);
    h.$<HTMLButtonElement>('[data-ref="allow-always"]')!.click();
    await settle();
    expect(client.decideApproval).toHaveBeenLastCalledWith('s', 'ap3', 'allow-always');
    expect(onInstallsAlwaysAllowed).toHaveBeenCalledTimes(1);
    client.emit('s', { type: 'part-update', messageId: 'a1', partId: 'edit', patch: { state: 'running', approval: { id: 'ap3', canAllowSession: false, canAllowAlways: true, decision: 'allow-always' } } });
    const approval = h.$('[data-ref="approval"]')!;
    expect(approval.textContent).toContain('You allowed package installs always');
    approval.querySelector<HTMLButtonElement>('[data-ref="always-settings"]')!.click();
    expect(h.openSettings).toHaveBeenCalledWith('general');
  });

  it('where an install goes is chosen as in the Hub panel: a split Install button, its places menu, the choice beside it and sent with the answer', async () => {
    const client = new FakeChatClient();
    waitingSession(client, installPart({
      approval: { id: 'ap3', canAllowSession: false, canAllowAlways: true, canChooseTarget: true },
      install: { state: 'ready', name: '@acme/kit', version: '0.2.0', target: 'library', upgrade: false, contents: { features: 2, parts: 0, assemblies: 0 } },
    }));
    const onInstallTargetChosen = vi.fn();
    const h = mount(client, {}, { onInstallTargetChosen });
    await opened(h);
    // The place is the button's: the facts keep what the package exports.
    expect(h.$('[data-ref="install-facts"]')!.textContent).toBe('2 features');
    expect(h.$('[data-ref="install-target"]')!.textContent).toBe('into my library');
    expect(h.$$('[data-ref="approval"] button').map((b) => b.dataset.ref)).toEqual(['allow', 'target-menu', 'allow-always', 'deny']);
    expect(h.$('[data-ref="install-targets"]')).toBeNull();

    const chevron = h.$<HTMLButtonElement>('[data-ref="target-menu"]')!;
    chevron.click();
    expect(h.$('[data-ref="target-menu"]')!.getAttribute('aria-expanded')).toBe('true');
    const options = h.$$<HTMLButtonElement>('[data-ref="install-targets"] [role="menuitemradio"]');
    expect(options.map((o) => [o.dataset.target, o.getAttribute('aria-checked'), o.textContent!.trim()])).toEqual([
      ['library', 'true', 'My libraryEvery project can use it; this project uses it.'],
      ['project', 'false', 'This projectA copy in its packages/ folder, committed with it.'],
    ]);
    options[1].click();
    expect(h.$('[data-ref="install-targets"]')).toBeNull();
    expect(h.$('[data-ref="install-target"]')!.textContent).toBe('into this project');
    expect(onInstallTargetChosen).toHaveBeenCalledWith('project');

    // The same place again is no new choice; Escape closes the menu.
    h.$<HTMLButtonElement>('[data-ref="target-menu"]')!.click();
    h.$$<HTMLButtonElement>('[data-ref="install-targets"] [data-target="project"]')[0].click();
    expect(onInstallTargetChosen).toHaveBeenCalledTimes(1);
    h.$<HTMLButtonElement>('[data-ref="target-menu"]')!.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(h.$('[data-ref="install-targets"]')).toBeNull();

    h.$<HTMLButtonElement>('[data-ref="allow"]')!.click();
    await settle();
    expect(client.decideApproval).toHaveBeenLastCalledWith('s', 'ap3', 'allow', 'project');
    // Answered: the details keep where it went.
    h.$<HTMLButtonElement>('[data-ref="toggle"]')!.click();
    expect(h.$('[data-ref="details"] [data-ref="install-facts"]')!.textContent).toBe('2 features · Copied into this project’s packages/ folder');
  });

  it('a press outside the places menu closes it and still lands; Deny sends no place', async () => {
    const client = new FakeChatClient();
    waitingSession(client, installPart({
      approval: { id: 'ap3', canAllowSession: false, canChooseTarget: true },
      install: { state: 'loading', name: '@acme/kit', version: null, target: 'project', upgrade: false },
    }));
    const h = mount(client);
    await opened(h);
    expect(h.$('[data-ref="install-target"]')!.textContent).toBe('into this project');
    h.$<HTMLButtonElement>('[data-ref="target-menu"]')!.click();
    const deny = h.$<HTMLButtonElement>('[data-ref="deny"]')!;
    deny.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(h.$('[data-ref="install-targets"]')).toBeNull();
    expect(h.$('[data-ref="deny"]')).toBe(deny);
    deny.click();
    await settle();
    expect(client.decideApproval).toHaveBeenLastCalledWith('s', 'ap3', 'deny');
  });

  it('an install that ran without asking because of Always says so', async () => {
    const client = new FakeChatClient();
    waitingSession(client, installPart({ state: 'done', approval: { id: 'ap4', canAllowSession: false, decision: 'allow-always', standing: true } }));
    const h = mount(client);
    await opened(h);
    const approval = h.$('[data-ref="approval"]')!;
    expect(approval.classList.contains('hidden')).toBe(false);
    expect(approval.textContent).toContain('Installed without asking: you chose Always for package installs');
    expect(approval.querySelector('[data-ref="install"]')).toBeNull();
    // The package stays with the card's details.
    h.$<HTMLButtonElement>('[data-ref="toggle"]')!.click();
    expect(h.$('[data-ref="details"] [data-ref="install-name"]')!.textContent).toBe('@acme/kit');
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

// --- Questions the agent asks (ask_user, §22) -------------------------------

function questionPart(overrides: Partial<QuestionPart> = {}): QuestionPart {
  return {
    type: 'question',
    id: 'q1',
    state: 'awaiting-answer',
    questions: [
      {
        question: 'Which thread should the holes take?',
        options: [
          { label: 'M4', description: 'Fits the standoffs already in the model.' },
          { label: 'M5' },
        ],
      },
      { question: 'Which faces get a chamfer?', options: [{ label: 'Top' }, { label: 'Bottom' }, { label: 'Sides' }], multiSelect: true },
      { question: 'How thick should the wall be?' },
    ],
    ...overrides,
  };
}

/** A session whose running turn waits on `part`, as a snapshot holds it (a reload, a second tab). */
function askingSession(client: FakeChatClient, part: QuestionPart = questionPart()) {
  return client.addSession({
    id: 's',
    title: 'Bracket',
    status: part.state === 'awaiting-answer' ? { state: 'awaiting-answer', turnId: 't1', questionIds: [part.id] } : { state: 'idle' },
    messages: [
      { id: 'u1', role: 'user', turnId: 't1', createdAt: '', parts: [{ type: 'text', id: 'u1t', text: 'add mounting holes' }] },
      { id: 'a1', role: 'assistant', turnId: 't1', createdAt: '', parts: [part] },
    ],
    turns: [{ id: 't1', userMessageId: 'u1', revertible: false }],
  });
}

const BEFORE_SIDE: ChangePreviewSide = {
  state: 'built',
  buildId: 'build-before',
  sceneKind: 'part',
  facts: { solidCount: 1, size: [60, 40, 30], volume: 72000, unit: 'mm', sound: true },
  bounds: { min: [-30, -20, 0], max: [30, 20, 30] },
};
const AFTER_SIDE: ChangePreviewSide = {
  state: 'built',
  buildId: 'build-after',
  sceneKind: 'part',
  facts: { solidCount: 2, size: [60, 40, 36], volume: 73256.6, unit: 'mm', sound: true },
  bounds: { min: [-30, -20, 0], max: [30, 20, 36] },
};
const READY_PREVIEW: ChangePreview = { state: 'ready', same: false, before: BEFORE_SIDE, after: AFTER_SIDE };

describe('what a change does to the model, on its approval card (§25)', () => {
  const previewOf = (card: Element) => card.querySelector<HTMLElement>('[data-ref="preview"]');
  const tilesOf = (card: Element) => [...card.querySelectorAll<HTMLElement>('[data-ref="preview-tile"]')];
  const factsOf = (card: Element) => [...card.querySelectorAll<HTMLElement>('[data-ref="preview-fact"]')].map((row) => [...row.children].map((c) => c.textContent));
  const setPreview = (client: FakeChatClient, preview: ChangePreview) =>
    client.emit('s', { type: 'part-update', messageId: 'a1', partId: 'edit', patch: { preview } });
  const settled = (preview: ChangePreview | undefined, overrides: Partial<ToolPart> = {}) =>
    editPart({ state: 'done', approval: { id: 'ap1', canAllowSession: true, decision: 'allow' }, output: { text: '{"render":{"state":"rendered"}}' }, ...(preview ? { preview } : {}), ...overrides });

  it('fills in while the buttons already work: placeholders as the engine builds, then both sides from one camera and the facts as differences', async () => {
    const client = new FakeChatClient();
    waitingSession(client);
    const host = variantsHost();
    const h = mount(client, {}, { variants: host });
    await opened(h);
    const card = h.$('[data-part="tool"]')!;
    // The card as it always was until the engine says a preview is coming.
    expect(previewOf(card)).toBeNull();

    setPreview(client, { state: 'building' });
    await settle();
    const preview = previewOf(card)!;
    expect(preview.dataset.state).toBe('building');
    expect(tilesOf(card).map((t) => [t.dataset.side, t.textContent!.trim()])).toEqual([['before', 'Building…Before'], ['after', 'QueuedAfter']]);
    expect(preview.querySelector('[data-ref="preview-progress"]')!.textContent).toContain('you can answer now');
    // The facts' rows hold their place while it builds, with nothing in them yet.
    expect([...preview.querySelectorAll('[data-ref="preview-facts-pending"] .chat-change-fact')].map((row) => row.textContent)).toEqual(['Bodies…', 'Size…', 'Volume…']);
    expect(factsOf(card)).toEqual([]);
    // Above the diff, which is above the buttons — and the buttons are live.
    const approval = card.querySelector('[data-ref="approval"]')!;
    expect(preview.compareDocumentPosition(approval.querySelector('[data-ref="diff"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...approval.querySelectorAll<HTMLButtonElement>('.chat-approval-buttons button')].map((b) => b.disabled)).toEqual([false, false, false]);
    expect(host.pictures).not.toHaveBeenCalled();

    setPreview(client, { state: 'building', before: BEFORE_SIDE });
    await settle();
    expect(tilesOf(card).map((t) => t.textContent!.trim())).toEqual(['BuiltBefore', 'Building…After']);
    // One side alone is not drawn: the two share a camera.
    expect(host.pictures).not.toHaveBeenCalled();

    setPreview(client, READY_PREVIEW);
    await settle();
    expect(previewOf(card)!.dataset.state).toBe('ready');
    expect(host.pictures).toHaveBeenCalledTimes(1);
    expect(host.pictures).toHaveBeenCalledWith(['build-before', 'build-after']);
    expect(tilesOf(card).map((t) => [t.dataset.side, t.querySelector('img')!.getAttribute('src'), t.textContent])).toEqual([
      ['before', host.png('build-before'), 'Before'],
      ['after', host.png('build-after'), 'After'],
    ]);
    // Handed over together, to be kept with the session.
    expect(client.savePreviewPictures).toHaveBeenCalledTimes(1);
    expect(client.savePreviewPictures).toHaveBeenCalledWith('s', 'ap1', {
      before: { mediaType: 'image/png', base64: btoa('build-before') },
      after: { mediaType: 'image/png', base64: btoa('build-after') },
    });
    expect(factsOf(card)).toEqual([
      ['Bodies', '1 → 2', '+1'],
      ['Size', '60 × 40 × 30 mm → 60 × 40 × 36 mm', 'Z +6 mm'],
      ['Volume', '72,000 mm³ → 73,257 mm³', '+1,257 mm³ (+1.7%)'],
    ]);
    expect(card.querySelector('[data-ref="preview-problems"]')).toBeNull();
    // The kept pictures arriving changes nothing on screen, and nothing is drawn again.
    await settle();
    expect(tilesOf(card).map((t) => t.querySelector('img')!.getAttribute('src'))).toEqual([host.png('build-before'), host.png('build-after')]);
    expect(host.pictures).toHaveBeenCalledTimes(1);
    expect(client.savePreviewPictures).toHaveBeenCalledTimes(1);
  });

  it('shows the change over the model on request, takes it out on the answer, and keeps the tiles with the details', async () => {
    const client = new FakeChatClient();
    waitingSession(client, editPart({ preview: READY_PREVIEW }));
    const host = variantsHost();
    const h = mount(client, {}, { variants: host });
    await opened(h);
    const card = h.$('[data-part="tool"]')!;
    const show = card.querySelector<HTMLButtonElement>('[data-ref="preview-show"]')!;
    expect(show.textContent!.trim()).toBe('Show in viewport');
    expect(show.getAttribute('aria-pressed')).toBe('false');
    show.click();
    await settle();
    expect(host.showGhost).toHaveBeenCalledWith('build-after');
    expect(host.ghost).toBe('build-after');
    expect(card.querySelector('[data-ref="preview-show"]')!.getAttribute('aria-pressed')).toBe('true');
    card.querySelector<HTMLButtonElement>('[data-ref="preview-show"]')!.click();
    expect(host.ghost).toBeNull();
    card.querySelector<HTMLButtonElement>('[data-ref="preview-show"]')!.click();
    await settle();
    expect(host.ghost).toBe('build-after');

    card.querySelector<HTMLButtonElement>('[data-ref="allow"]')!.click();
    await settle();
    // Answered: the ghost goes, the approval slot says so in one line, and the tiles wait in the details.
    expect(host.ghost).toBeNull();
    expect(card.querySelector('[data-ref="approval"]')!.textContent!.trim()).toBe('You allowed this');
    expect(card.querySelector('[data-ref="preview"]')).toBeNull();
    card.querySelector<HTMLButtonElement>('[data-ref="toggle"]')!.click();
    const details = card.querySelector('[data-ref="details"]')!;
    expect(tilesOf(details).map((t) => t.dataset.side)).toEqual(['before', 'after']);
    expect(tilesOf(details).every((t) => t.querySelector('img') !== null)).toBe(true);
    expect(factsOf(details)).toHaveLength(3);
    // Nothing to click on a settled card's preview.
    expect(details.querySelector('[data-ref="preview"]')!.querySelectorAll('button')).toHaveLength(0);
    expect([...details.querySelectorAll('.chat-tool-section-label')].map((l) => l.textContent)).toEqual(['Before and after', 'Input', 'Change']);

    // A panel that closes takes a shown change out of the viewport too.
    const other = new FakeChatClient();
    waitingSession(other, editPart({ preview: READY_PREVIEW }));
    const otherHost = variantsHost();
    const o = mount(other, {}, { variants: otherHost });
    await opened(o);
    o.$<HTMLButtonElement>('[data-ref="preview-show"]')!.click();
    await settle();
    expect(otherHost.ghost).toBe('build-after');
    o.panel.close();
    expect(otherHost.ghost).toBeNull();
  });

  it('says first that a change does not build, with the reasons, and leaves the answer to the user', async () => {
    const client = new FakeChatClient();
    waitingSession(client, editPart({
      preview: { state: 'ready', same: false, before: BEFORE_SIDE, after: { state: 'failed', problems: [{ title: 'Compile error', message: 'rib is not defined', line: 14 }] } },
    }));
    const host = variantsHost();
    const h = mount(client, {}, { variants: host });
    await opened(h);
    const card = h.$('[data-part="tool"]')!;
    const problems = card.querySelector<HTMLElement>('[data-ref="preview-problems"]')!;
    expect(problems.getAttribute('role')).toBe('alert');
    expect(problems.querySelector('.chat-change-problems-title')!.textContent!.trim()).toBe('This change does not build');
    expect([...problems.querySelectorAll('[data-ref="preview-problem"]')].map((p) => p.textContent)).toEqual(['Compile error: rib is not definedline 14']);
    // It is the first thing in the approval, before the diff and the buttons.
    expect(card.querySelector('[data-ref="approval"]')!.firstElementChild!.firstElementChild).toBe(problems);
    // Nothing built with the change: no pictures, no facts, nothing to show in the viewport.
    expect(tilesOf(card)).toHaveLength(0);
    expect(card.querySelector('[data-ref="preview-facts"]')).toBeNull();
    expect(card.querySelector('[data-ref="preview-show"]')).toBeNull();
    expect(host.pictures).not.toHaveBeenCalled();
    expect([...card.querySelectorAll<HTMLButtonElement>('.chat-approval-buttons button')].map((b) => [b.dataset.ref, b.disabled])).toEqual([
      ['allow', false], ['allow-session', false], ['deny', false],
    ]);

    // Features that fail: what did build is drawn beside the file as it is, the reasons listed and the rest counted.
    const failing: ChangePreviewSide = {
      ...AFTER_SIDE,
      state: 'failed',
      problems: [{ title: 'Fillet 2 failed', message: 'the radius is too large', line: 22 }, { title: 'Shell 1 failed', message: 'no face to open' }],
      moreProblems: 3,
    };
    setPreview(client, { state: 'ready', same: false, before: { ...BEFORE_SIDE, state: 'failed', problems: [{ title: 'Fillet 1 failed', message: 'x' }] }, after: failing });
    await settle();
    // The failed features are left out of the build, which can leave the model as it is: said without a green tick.
    setPreview(client, { state: 'ready', same: true, before: BEFORE_SIDE, after: { ...failing, facts: BEFORE_SIDE.facts } });
    await settle();
    expect(card.querySelector<HTMLElement>('[data-ref="preview-same"]')!.textContent!.trim()).toBe('What does build is the same geometry as now.');
    expect(card.querySelector<HTMLElement>('[data-ref="preview-same"]')!.dataset.icon).toBe('plain');
    expect(tilesOf(card)).toHaveLength(0);
    setPreview(client, { state: 'ready', same: false, before: { ...BEFORE_SIDE, state: 'failed', problems: [{ title: 'Fillet 1 failed', message: 'x' }] }, after: failing });
    await settle();
    const listed = [...card.querySelectorAll('[data-ref="preview-problems"] li')].map((p) => p.textContent);
    expect(listed).toEqual(['Fillet 2 failed: the radius is too largeline 22', 'Shell 1 failed: no face to open', 'and 3 more']);
    expect(card.querySelector('[data-ref="preview-before-failed"]')!.textContent).toBe('The file as it is does not build either.');
    expect(tilesOf(card).map((t) => [t.dataset.side, t.dataset.state])).toEqual([['before', 'failed'], ['after', 'failed']]);

    // The other way round: the change is what makes the file build.
    setPreview(client, { state: 'ready', same: false, before: { state: 'failed', problems: [{ title: 'Compile error', message: 'x' }] }, after: AFTER_SIDE });
    await settle();
    expect(card.querySelector('[data-ref="preview-problems"]')).toBeNull();
    expect(card.querySelector('[data-ref="preview-fixes"]')!.textContent!.trim()).toBe('The file as it is does not build; with this change it does.');
    expect(tilesOf(card).map((t) => t.dataset.side)).toEqual(['after']);
    expect(card.querySelector('[data-ref="preview-facts"]')!.textContent).toBe('2 bodies · 60 × 40 × 36 mm · 73,257 mm³');
  });

  it('says "No change to the geometry" instead of two identical pictures', async () => {
    const client = new FakeChatClient();
    waitingSession(client, editPart({ preview: { state: 'ready', same: true, before: BEFORE_SIDE, after: { ...BEFORE_SIDE, buildId: 'build-after' } } }));
    const host = variantsHost();
    const h = mount(client, {}, { variants: host });
    await opened(h);
    const card = h.$('[data-part="tool"]')!;
    expect(card.querySelector('[data-ref="preview-same"]')!.textContent!.trim()).toBe('No change to the geometry');
    expect(card.querySelector('[data-ref="preview-facts"]')!.textContent).toBe('1 body · 60 × 40 × 30 mm · 72,000 mm³');
    expect(tilesOf(card)).toHaveLength(0);
    expect(card.querySelector('[data-ref="preview-show"]')).toBeNull();
    expect(host.pictures).not.toHaveBeenCalled();
    expect(client.savePreviewPictures).not.toHaveBeenCalled();
  });

  it('shows one picture for a file the change creates', async () => {
    const client = new FakeChatClient();
    waitingSession(client, editPart({ name: 'write_file', title: 'Create rib.part.js', preview: { state: 'building', before: null } }));
    const host = variantsHost();
    const h = mount(client, {}, { variants: host });
    await opened(h);
    const card = h.$('[data-part="tool"]')!;
    expect(tilesOf(card).map((t) => t.textContent!.trim())).toEqual(['Building…New file']);
    setPreview(client, { state: 'ready', before: null, after: AFTER_SIDE });
    await settle();
    expect(host.pictures).toHaveBeenCalledWith(['build-after']);
    expect(tilesOf(card).map((t) => [t.dataset.side, t.querySelector('img') !== null, t.textContent])).toEqual([['after', true, 'New file']]);
    expect(card.querySelector('[data-ref="preview-facts"]')!.textContent).toBe('2 bodies · 60 × 40 × 36 mm · 73,257 mm³');
    expect(client.savePreviewPictures).toHaveBeenCalledWith('s', 'ap1', { after: { mediaType: 'image/png', base64: btoa('build-after') } });
    // The model on screen is another file's: nothing to draw this one over.
    expect(card.querySelector('[data-ref="preview-show"]')).toBeNull();
  });

  it('offers a button instead of building a slow file unasked, and builds when it is clicked', async () => {
    const client = new FakeChatClient();
    waitingSession(client, editPart({ preview: { state: 'offered', estimateMs: 6240 } }));
    const host = variantsHost();
    const h = mount(client, {}, { variants: host });
    await opened(h);
    const card = h.$('[data-part="tool"]')!;
    expect(card.querySelector('[data-ref="preview-offer"]')!.textContent).toBe("Not previewed: this file's last build took 6.2 s.");
    const button = card.querySelector<HTMLButtonElement>('[data-ref="preview-build"]')!;
    expect(button.textContent!.trim()).toBe('Preview the change');
    expect(button.title).toContain('The app waits while they build');
    expect(tilesOf(card)).toHaveLength(0);
    // Refused for a reason that is not "already building": the button comes back.
    client.previewAnswer = { ok: false, status: 500, error: 'The engine is busy.' };
    button.click();
    expect(card.querySelector<HTMLButtonElement>('[data-ref="preview-build"]')!.disabled).toBe(true);
    await settle();
    expect(card.querySelector<HTMLButtonElement>('[data-ref="preview-build"]')!.disabled).toBe(false);

    client.previewAnswer = null;
    card.querySelector<HTMLButtonElement>('[data-ref="preview-build"]')!.click();
    await settle();
    expect(client.requestPreview).toHaveBeenLastCalledWith('s', 'ap1');
    expect(previewOf(card)!.dataset.state).toBe('building');
    expect(card.querySelector('[data-ref="preview-build"]')).toBeNull();
    expect(tilesOf(card)).toHaveLength(2);
    // The approval was never in the way.
    expect(card.dataset.state).toBe('awaiting-approval');
    expect(card.querySelector<HTMLButtonElement>('[data-ref="allow"]')!.disabled).toBe(false);
  });

  it('a reloaded card shows the pictures the session kept without drawing them, and nothing for a preview that never ran', async () => {
    const client = new FakeChatClient();
    const kept: ChangePreview = { state: 'ready', same: false, before: { ...BEFORE_SIDE, image: 'before-kept.png' }, after: { ...AFTER_SIDE, image: 'after-kept.png' } };
    waitingSession(client, settled(kept));
    const host = variantsHost();
    const h = mount(client, {}, { variants: host });
    await opened(h);
    const card = h.$('[data-part="tool"]')!;
    // Collapsed with the card's details.
    expect(tilesOf(card)).toHaveLength(0);
    card.querySelector<HTMLButtonElement>('[data-ref="toggle"]')!.click();
    expect(tilesOf(card).map((t) => t.querySelector('img')!.getAttribute('src'))).toEqual([client.fileUrl('s', 'before-kept.png'), client.fileUrl('s', 'after-kept.png')]);
    expect(host.pictures).not.toHaveBeenCalled();
    expect(client.savePreviewPictures).not.toHaveBeenCalled();

    // Cancelled by the answer, a stop or a restart: no tile, no placeholder, no button, no section.
    for (const preview of [{ state: 'cancelled' }, { state: 'cancelled', estimateMs: 6200 }, { state: 'cancelled', before: BEFORE_SIDE }, undefined] as (ChangePreview | undefined)[]) {
      const other = new FakeChatClient();
      waitingSession(other, settled(preview, { state: 'error', error: 'The app restarted while this was running; its effect is unknown.', output: undefined }));
      const otherHost = variantsHost();
      const o = mount(other, {}, { variants: otherHost });
      await opened(o);
      const restored = o.$('[data-part="tool"]')!;
      restored.querySelector<HTMLButtonElement>('[data-ref="toggle"]')!.click();
      expect(restored.querySelector('[data-ref="preview"]')).toBeNull();
      expect(restored.querySelector('[data-ref="preview-placeholder"]')).toBeNull();
      expect([...restored.querySelectorAll('.chat-tool-section-label')].map((l) => l.textContent)).not.toContain('Before and after');
      expect(otherHost.pictures).not.toHaveBeenCalled();
    }

    // Built, never drawn, and the engine has let the builds go: the facts alone, no empty picture frames.
    const gone = new FakeChatClient();
    waitingSession(gone, settled(READY_PREVIEW));
    const goneHost = variantsHost({ 'build-before': null, 'build-after': null });
    const g = mount(gone, {}, { variants: goneHost });
    await opened(g);
    const facts = g.$('[data-part="tool"]')!;
    facts.querySelector<HTMLButtonElement>('[data-ref="toggle"]')!.click();
    await settle();
    expect(tilesOf(facts)).toHaveLength(0);
    expect(facts.querySelector('[data-ref="preview-placeholder"]')).toBeNull();
    expect(factsOf(facts)).toHaveLength(3);
    expect(gone.savePreviewPictures).not.toHaveBeenCalled();
  });

  it('words the facts as differences, each with its unit', () => {
    const base = { solidCount: 1, size: [60, 40, 30] as [number, number, number], volume: 72000, unit: 'mm' };
    // Material removed, on two axes; a body gone.
    expect(factChanges({ ...base, solidCount: 2 }, { solidCount: 1, size: [50, 40, 27.5], volume: 55000, unit: 'mm' })).toEqual([
      { label: 'Bodies', before: '2', after: '1', change: '−1', tone: 'less' },
      { label: 'Size', before: '60 × 40 × 30 mm', after: '50 × 40 × 27.5 mm', change: 'X −10, Z −2.5 mm', tone: 'less' },
      { label: 'Volume', before: '72,000 mm³', after: '55,000 mm³', change: '−17,000 mm³ (−24%)', tone: 'less' },
    ]);
    // Nothing moved: no difference to name. A hole moved keeps every number.
    expect(factChanges(base, base).map((f) => [f.change, f.tone])).toEqual([['', 'same'], ['', 'same'], ['', 'same']]);
    // Grew one way and shrank another: neither more nor less.
    expect(factChanges(base, { ...base, size: [70, 30, 30] })[1]).toMatchObject({ change: 'X +10, Y −10 mm', tone: 'same' });
    // A change too small for the digits shown is not called one; a small one is still signed.
    expect(factChanges(base, { ...base, volume: 72000.0004 })[2]).toMatchObject({ change: '', tone: 'same' });
    expect(factChanges(base, { ...base, volume: 72010 })[2]).toMatchObject({ before: '72,000 mm³', after: '72,010 mm³', change: '+10 mm³ (+<0.1%)' });
    // An assembly counts its instances; a side with no solid has no size or volume to compare.
    expect(factChanges({ ...base, instanceCount: 2 }, { solidCount: 0, size: null, volume: null, unit: 'mm', instanceCount: 3 })).toEqual([
      { label: 'Instances', before: '2', after: '3', change: '+1', tone: 'more' },
      { label: 'Bodies', before: '1', after: '0', change: '−1', tone: 'less' },
      { label: 'Size', before: '60 × 40 × 30 mm', after: 'none', change: '', tone: 'same' },
      { label: 'Volume', before: '72,000 mm³', after: 'none', change: '', tone: 'same' },
    ]);
    // A change of unit is shown, and not subtracted across.
    expect(factChanges(base, { solidCount: 1, size: [2.36, 1.57, 1.18], volume: 4.39, unit: 'in' }).map((f) => f.change)).toEqual(['', '', '']);
    expect([duration(850), duration(6240), duration(59960), duration(80000), duration(120000)]).toEqual(['850 ms', '6.2 s', '60 s', '1 min 20 s', '2 min']);
  });
});

describe('question cards (§22)', () => {
  const pressed = (card: Element, index: number) =>
    [...card.querySelectorAll<HTMLButtonElement>(`[data-ref="question"][data-index="${index}"] [data-ref="option"]`)]
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.dataset.label);
  const option = (card: Element, index: number, label: string) =>
    card.querySelector<HTMLButtonElement>(`[data-ref="question"][data-index="${index}"] [data-ref="option"][data-label="${label}"]`)!;
  const field = (card: Element, index: number) =>
    card.querySelector<HTMLInputElement>(`[data-ref="question"][data-index="${index}"] [data-ref="text"]`)!;
  const write = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('shows every question with its options and a field of its own; Send waits for an answer', async () => {
    const client = new FakeChatClient();
    askingSession(client);
    const h = mount(client);
    await opened(h);
    const card = h.$('[data-part="question"]')!;
    expect(card.dataset.state).toBe('awaiting-answer');
    expect([...card.querySelectorAll('[data-ref="question-text"]')].map((q) => q.textContent)).toEqual([
      'Which thread should the holes take?',
      'Which faces get a chamfer?',
      'How thick should the wall be?',
    ]);
    const first = [...card.querySelectorAll<HTMLButtonElement>('[data-ref="question"][data-index="0"] [data-ref="option"]')];
    expect(first.map((b) => b.textContent!.trim())).toEqual(['M4Fits the standoffs already in the model.', 'M5']);
    // Real buttons, in the tab order, saying whether they are picked.
    expect(first.every((b) => b.type === 'button' && b.tabIndex >= 0 && b.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(card.querySelectorAll('[data-ref="question"][data-index="2"] [data-ref="option"]')).toHaveLength(0);
    expect(field(card, 0).placeholder).toBe('Or in your own words…');
    expect(field(card, 2).placeholder).toBe('Your answer…');
    expect(card.querySelector<HTMLButtonElement>('[data-ref="question-send"]')!.disabled).toBe(true);
    expect(card.querySelector<HTMLButtonElement>('[data-ref="question-skip"]')!.disabled).toBe(false);
    expect(h.$('[data-ref="activity"]')!.textContent).toBe('Waiting for your answer…');
    expect(h.panel.el.dataset.status).toBe('awaiting-answer');
    expect(h.panel.el.dataset.busy).toBe('true');
  });

  it('shows a drawing as an image, never as markup of the page: a figure under the question, tiles for drawn options', async () => {
    const hostile = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 90" onload="window.__drawn = true"><script>window.__drawn = true</script><rect width="60" height="40"/></svg>';
    const plain = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 90"><circle cx="60" cy="45" r="30"/></svg>';
    const client = new FakeChatClient();
    askingSession(client, questionPart({
      questions: [
        { question: 'Which corner?', svg: plain, options: [{ label: 'Round', svg: hostile }, { label: 'Square', svg: plain }, { label: 'Either' }] },
        { question: 'Which thread?', options: [{ label: 'M4' }, { label: 'M5' }] },
      ],
    }));
    const h = mount(client);
    await opened(h);
    const card = h.$('[data-part="question"]')!;
    const source = (el: Element) => decodeURIComponent(el.querySelector('img')!.src.replace('data:image/svg+xml;charset=utf-8,', ''));

    const figure = card.querySelector('[data-ref="question"][data-index="0"] > [data-ref="question-drawing"]')!;
    expect(source(figure)).toBe(plain);
    // The label and description carry the meaning; the drawing is decoration to a screen reader.
    expect(figure.querySelector('img')!.alt).toBe('');

    const groups = [...card.querySelectorAll<HTMLElement>('.chat-question-options')];
    expect(groups.map((g) => g.dataset.drawn)).toEqual(['true', 'false']);
    expect(source(option(card, 0, 'Round').querySelector('[data-ref="option-drawing"]')!)).toBe(hostile);
    expect(option(card, 0, 'Either').querySelector('[data-ref="option-drawing"]')).toBeNull();
    expect(card.querySelectorAll('[data-ref="question"][data-index="1"] img')).toHaveLength(0);
    // Nothing of the drawing is an element of the page, and nothing in it ran.
    expect(card.querySelectorAll('svg rect, svg circle, script')).toHaveLength(0);
    expect((window as any).__drawn).toBeUndefined();

    // A drawn option is the same toggle button.
    option(card, 0, 'Round').click();
    expect(pressed(card, 0)).toEqual(['Round']);

    // A drawing the browser cannot read takes itself out; the option stays.
    option(card, 0, 'Square').querySelector('img')!.dispatchEvent(new Event('error'));
    expect(option(card, 0, 'Square').querySelector('[data-ref="option-drawing"]')).toBeNull();
    expect(option(card, 0, 'Square').textContent!.trim()).toBe('Square');
  });

  it('a settled card keeps the question\'s figure and drops the options with their drawings', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 90"><circle cx="60" cy="45" r="30"/></svg>';
    const client = new FakeChatClient();
    askingSession(client, questionPart({
      state: 'answered',
      questions: [{ question: 'Which corner?', svg, options: [{ label: 'Round', svg }, { label: 'Square', svg }] }],
      answers: [{ selected: ['Round'] }],
    }));
    const h = mount(client);
    await opened(h);
    const card = h.$('[data-part="question"]')!;
    expect(card.querySelectorAll('[data-ref="question-drawing"] img')).toHaveLength(1);
    expect(card.querySelectorAll('[data-ref="option-drawing"]')).toHaveLength(0);
    expect(card.querySelector('[data-ref="answer"]')!.textContent!.trim()).toBe('Round');
  });

  it('one option where the question takes one, several where it takes several; a second click takes a pick back', async () => {
    const client = new FakeChatClient();
    askingSession(client);
    const h = mount(client);
    await opened(h);
    const card = h.$('[data-part="question"]')!;
    option(card, 0, 'M4').click();
    option(card, 0, 'M5').click();
    expect(pressed(card, 0)).toEqual(['M5']);
    option(card, 0, 'M5').click();
    expect(pressed(card, 0)).toEqual([]);
    option(card, 1, 'Sides').click();
    option(card, 1, 'Top').click();
    expect(pressed(card, 1)).toEqual(['Top', 'Sides']);
    expect(card.querySelector<HTMLButtonElement>('[data-ref="question-send"]')!.disabled).toBe(false);
  });

  it('Send posts one answer per question, in order, and the card settles to what was answered', async () => {
    const client = new FakeChatClient();
    askingSession(client);
    const h = mount(client);
    await opened(h);
    const card = h.$('[data-part="question"]')!;
    option(card, 0, 'M4').click();
    option(card, 1, 'Sides').click();
    option(card, 1, 'Top').click();
    write(field(card, 1), '  only the outer edges ');
    card.querySelector<HTMLButtonElement>('[data-ref="question-send"]')!.click();
    await settle();
    expect(client.answerQuestion).toHaveBeenCalledWith('s', 'q1', {
      answers: [{ selected: ['M4'] }, { selected: ['Top', 'Sides'], text: 'only the outer edges' }, { selected: [] }],
    });
    expect(card.dataset.state).toBe('answered');
    expect(card.querySelectorAll('button, input')).toHaveLength(0);
    expect([...card.querySelectorAll('[data-ref="answer"]')].map((a) => a.textContent!.trim())).toEqual([
      'M4',
      'Top, Sides — only the outer edges',
      'Left open',
    ]);
    expect(h.panel.el.dataset.status).toBe('running');
  });

  it('Enter in a field sends; an empty card does not', async () => {
    const client = new FakeChatClient();
    askingSession(client, questionPart({ questions: [{ question: 'How thick should the wall be?' }] }));
    const h = mount(client);
    await opened(h);
    const card = h.$('[data-part="question"]')!;
    const input = field(card, 0);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(client.answerQuestion).not.toHaveBeenCalled();
    write(input, '2.5 mm');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(client.answerQuestion).toHaveBeenCalledWith('s', 'q1', { answers: [{ selected: [], text: '2.5 mm' }] });
    expect(card.querySelector('[data-ref="answer"]')!.textContent!.trim()).toBe('2.5 mm');
  });

  it('Skip leaves the choice to the agent, and the card says so', async () => {
    const client = new FakeChatClient();
    askingSession(client);
    const h = mount(client);
    await opened(h);
    const card = h.$('[data-part="question"]')!;
    card.querySelector<HTMLButtonElement>('[data-ref="question-skip"]')!.click();
    await settle();
    expect(client.answerQuestion).toHaveBeenCalledWith('s', 'q1', { skip: true });
    expect(card.dataset.state).toBe('skipped');
    expect(card.querySelector('[data-ref="outcome"]')!.textContent!.trim()).toBe('You skipped this; the agent decides.');
    expect(card.querySelectorAll('[data-ref="answer"]')).toHaveLength(0);
  });

  it('settled elsewhere (another tab, a stop): the controls go and the card says how it ended', async () => {
    const client = new FakeChatClient();
    askingSession(client);
    const h = mount(client);
    await opened(h);
    const card = h.$('[data-part="question"]')!;
    option(card, 0, 'M4').click();
    client.emit('s', { type: 'part-update', messageId: 'a1', partId: 'q1', patch: { state: 'unanswered', reason: 'Stopped before you answered.' } });
    expect(card.dataset.state).toBe('unanswered');
    expect(card.querySelectorAll('button, input')).toHaveLength(0);
    expect(card.querySelector('[data-ref="outcome"]')!.textContent!.trim()).toBe('Stopped before you answered.');
  });

  it('a reply the engine did not take: the controls come back with what was picked, and the reason shows', async () => {
    const client = new FakeChatClient();
    askingSession(client);
    let release!: () => void;
    client.answerQuestion.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ ok: false, status: 0, error: 'FluidCAD did not answer.' });
    }));
    const h = mount(client);
    await opened(h);
    const card = h.$('[data-part="question"]')!;
    option(card, 0, 'M5').click();
    card.querySelector<HTMLButtonElement>('[data-ref="question-send"]')!.click();
    await settle();
    // While it goes, everything waits.
    expect([...card.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')].every((c) => c.disabled)).toBe(true);
    release();
    await settle();
    expect(card.querySelector<HTMLButtonElement>('[data-ref="question-send"]')!.disabled).toBe(false);
    expect(option(card, 0, 'M5').disabled).toBe(false);
    expect(pressed(card, 0)).toEqual(['M5']);
    expect(h.$('[data-ref="status"]')!.textContent).toContain('FluidCAD did not answer.');
  });

  it('an answered question from a stored chat shows its answers and nothing to click', async () => {
    const client = new FakeChatClient();
    askingSession(client, questionPart({ state: 'answered', answers: [{ selected: ['M5'] }, { selected: [] }, { selected: [], text: '3 mm' }] }));
    const h = mount(client);
    await opened(h);
    const card = h.$('[data-part="question"]')!;
    expect([...card.querySelectorAll('[data-ref="answer"]')].map((a) => a.textContent!.trim())).toEqual(['M5', 'Left open', '3 mm']);
    expect(card.querySelectorAll('button, input')).toHaveLength(0);
  });
});

// --- Variants the agent proposes (propose_variants, §24) ---------------------

const RIB_TILE: VariantTile = {
  label: 'Rib',
  description: 'One rib under the arm.',
  state: 'ready',
  buildId: 'build-rib',
  sceneKind: 'part',
  facts: { solidCount: 1, size: [80, 40, 30.5], volume: 41200, unit: 'mm', sound: true },
};
const GUSSET_TILE: VariantTile = {
  label: 'Gusset',
  state: 'ready',
  buildId: 'build-gusset',
  sceneKind: 'part',
  facts: { solidCount: 2, size: [80, 40, 30], volume: 44012.345, unit: 'mm', sound: true },
};

function variantsPart(overrides: Partial<VariantsPart> = {}): VariantsPart {
  return {
    type: 'variants',
    id: 'v1',
    state: 'awaiting-choice',
    file: 'bracket.fluid.js',
    question: 'Which stiffener?',
    variants: [RIB_TILE, GUSSET_TILE],
    ...overrides,
  };
}

/** A session whose running turn holds `part`, as a snapshot holds it (a reload, a second tab). */
function proposingSession(client: FakeChatClient, part: VariantsPart = variantsPart()) {
  const waiting = part.state === 'awaiting-choice';
  const running = part.state === 'building';
  return client.addSession({
    id: 's',
    title: 'Bracket',
    status: waiting ? { state: 'awaiting-answer', turnId: 't1', questionIds: [part.id] } : running ? { state: 'running', turnId: 't1' } : { state: 'idle' },
    messages: [
      { id: 'u1', role: 'user', turnId: 't1', createdAt: '', parts: [{ type: 'text', id: 'u1t', text: 'stiffen the arm, show me options' }] },
      { id: 'a1', role: 'assistant', turnId: 't1', createdAt: '', parts: [part] },
    ],
    turns: [{ id: 't1', userMessageId: 'u1', revertible: false }],
  });
}

/** What draws the variants in a test: a picture per build id, and the ghost it was last asked to show. */
function variantsHost(pictures: Record<string, string | null> = {}) {
  const png = (name: string) => `data:image/png;base64,${btoa(name)}`;
  const host = {
    ghost: null as string | null,
    picture: vi.fn(async (buildId: string) => (buildId in pictures ? pictures[buildId] : png(buildId))),
    pictures: vi.fn(async (buildIds: string[]) => buildIds.map((buildId) => (buildId in pictures ? pictures[buildId] : png(buildId)))),
    showGhost: vi.fn(async (buildId: string) => {
      host.ghost = buildId;
      return true;
    }),
    hideGhost: vi.fn(() => {
      host.ghost = null;
    }),
    png,
  };
  return host;
}

describe('variants cards (§24)', () => {
  const tiles = (card: Element) => [...card.querySelectorAll<HTMLElement>('[data-ref="variant"]')];
  const tile = (card: Element, label: string) => tiles(card).find((t) => t.dataset.label === label)!;
  const pickOf = (card: Element, label: string) => tile(card, label).querySelector<HTMLButtonElement>('[data-ref="variant-pick"]')!;
  const showOf = (card: Element, label: string) => tile(card, label).querySelector<HTMLButtonElement>('[data-ref="variant-show"]');
  const pressed = (card: Element) => tiles(card).filter((t) => pickOf(card, t.dataset.label!).getAttribute('aria-pressed') === 'true').map((t) => t.dataset.label);
  const apply = (card: Element) => card.querySelector<HTMLButtonElement>('[data-ref="variants-apply"]')!;
  const skip = (card: Element) => card.querySelector<HTMLButtonElement>('[data-ref="variants-skip"]')!;
  const field = (card: Element) => card.querySelector<HTMLInputElement>('[data-ref="variants-text"]')!;
  const write = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const update = (client: FakeChatClient, patch: Partial<VariantsPart>) => client.emit('s', { type: 'part-update', messageId: 'a1', partId: 'v1', patch });

  it('says what a tile produces: bodies, overall size and volume, each with its unit', () => {
    expect(factLines(RIB_TILE.facts!)).toEqual(['1 body', '80 × 40 × 30.5 mm', '41,200 mm³']);
    expect(factLines(GUSSET_TILE.facts!)).toEqual(['2 bodies', '80 × 40 × 30 mm', '44,012 mm³']);
    expect(factLines({ solidCount: 6, size: [12.3456, 1, 0.5], volume: 0.012345678, unit: 'in', instanceCount: 3 })).toEqual(['3 instances, 6 bodies', '12.35 × 1 × 0.5 in', '0.012346 in³']);
    expect(factLines({ solidCount: 0, size: null, volume: null, unit: 'mm' })).toEqual(['0 bodies']);
  });

  it('shows the card while the variants build, and each tile fills in as its build ends', async () => {
    const client = new FakeChatClient();
    proposingSession(client, variantsPart({
      state: 'building',
      variants: [{ label: 'Rib', description: 'One rib under the arm.', state: 'building' }, { label: 'Gusset', state: 'queued' }],
    }));
    const host = variantsHost();
    const h = mount(client, {}, { variants: host });
    await opened(h);
    const card = h.$('[data-part="variants"]')!;
    expect(card.dataset.state).toBe('building');
    expect(card.querySelector('[data-ref="variants-question"]')!.textContent).toBe('Which stiffener?');
    expect(card.querySelector('[data-ref="variants-file"]')!.textContent).toBe('bracket.fluid.js');
    expect(tiles(card).map((t) => [t.dataset.label, t.dataset.state, t.querySelector('[data-ref="variant-placeholder"]')!.textContent!.trim()])).toEqual([
      ['Rib', 'building', 'Building…'],
      ['Gusset', 'queued', 'Queued'],
    ]);
    expect(card.querySelector('[data-ref="variants-progress"]')!.textContent).toContain('Building 1 of 2');
    // Nothing to choose yet: no pick, no field, no buttons. The turn runs; Stop is the composer's.
    expect(card.querySelectorAll('button, input')).toHaveLength(0);
    expect(h.panel.el.dataset.status).toBe('running');
    expect(host.picture).not.toHaveBeenCalled();

    // The first build ends: its tile has its facts, and this page draws its picture and hands it over.
    update(client, { variants: [RIB_TILE, { label: 'Gusset', state: 'building' }] });
    await settle();
    expect(card.querySelector('[data-ref="variants-progress"]')!.textContent).toContain('Building 2 of 2');
    expect(tile(card, 'Rib').dataset.state).toBe('ready');
    expect([...tile(card, 'Rib').querySelectorAll('[data-ref="variant-facts"] > span')].map((f) => f.textContent)).toEqual(['1 body', '80 × 40 × 30.5 mm', '41,200 mm³']);
    expect(host.picture).toHaveBeenCalledWith('build-rib');
    expect(tile(card, 'Rib').querySelector('img')!.getAttribute('src')).toBe(host.png('build-rib'));
    expect(client.saveVariantPicture).toHaveBeenCalledWith('s', 'v1', { label: 'Rib', image: { mediaType: 'image/png', base64: btoa('build-rib') } });
    expect(tile(card, 'Gusset').querySelector('[data-ref="variant-placeholder"]')!.textContent!.trim()).toBe('Building…');

    // Both built: the card waits for the user.
    client.emit('s', { type: 'part-update', messageId: 'a1', partId: 'v1', patch: { variants: [{ ...RIB_TILE, image: 'Rib.png' }, GUSSET_TILE] } });
    client.emit('s', { type: 'part-update', messageId: 'a1', partId: 'v1', patch: { state: 'awaiting-choice' } });
    client.emit('s', { type: 'status', status: { state: 'awaiting-answer', turnId: 't1', questionIds: ['v1'] } });
    await settle();
    expect(card.dataset.state).toBe('awaiting-choice');
    expect(h.panel.el.dataset.status).toBe('awaiting-answer');
    // Each build was drawn once, however often the card was painted.
    expect(host.picture.mock.calls.map((c) => c[0])).toEqual(['build-rib', 'build-gusset']);
    expect(tiles(card).map((t) => t.querySelector('img')?.getAttribute('src'))).toEqual([host.png('build-rib'), host.png('build-gusset')]);
    expect(apply(card).disabled).toBe(true);
    expect(skip(card).disabled).toBe(false);
  });

  it('shows the model\'s label and description as text, never as markup', async () => {
    const client = new FakeChatClient();
    const hostile = '<img src=x onerror="window.pwned = true"><b>Rib</b>';
    proposingSession(client, variantsPart({
      question: '<script>window.pwned = true</script>Which?',
      variants: [{ ...RIB_TILE, label: hostile, description: hostile }, { ...GUSSET_TILE, state: 'failed', error: hostile }],
    }));
    const h = mount(client, {}, { variants: variantsHost() });
    await opened(h);
    const card = h.$('[data-part="variants"]')!;
    expect(card.querySelector('[data-ref="variant-label"]')!.textContent).toBe(hostile);
    expect(card.querySelector('[data-ref="variant-description"]')!.textContent).toBe(hostile);
    expect(card.querySelector('[data-ref="variant-error"]')!.textContent!.trim()).toBe(hostile);
    expect(card.querySelector('[data-ref="variants-question"]')!.textContent).toBe('<script>window.pwned = true</script>Which?');
    expect(card.querySelectorAll('script, b, img[src="x"]')).toHaveLength(0);
    // The hostile label is still the pick that is posted.
    pickOf(card, hostile).click();
    apply(card).click();
    await settle();
    expect(client.chooseVariant).toHaveBeenCalledWith('s', 'v1', { pick: hostile });
    expect((window as any).pwned).toBeUndefined();
  });

  it('shows as many tiles as the agent sent, up to four, and any of them can be picked', async () => {
    const client = new FakeChatClient();
    const more: VariantTile[] = [
      { ...GUSSET_TILE, label: 'Web', buildId: 'build-web' },
      { ...GUSSET_TILE, label: 'Flange', buildId: 'build-flange' },
    ];
    proposingSession(client, variantsPart({ variants: [RIB_TILE, GUSSET_TILE, ...more] }));
    const host = variantsHost();
    const h = mount(client, {}, { variants: host });
    await opened(h);
    const card = h.$('[data-part="variants"]')!;
    expect(tiles(card).map((t) => [t.dataset.label, t.dataset.state])).toEqual([['Rib', 'ready'], ['Gusset', 'ready'], ['Web', 'ready'], ['Flange', 'ready']]);
    // Every tile gets its picture and its way into the viewport.
    await settle();
    expect(tiles(card).map((t) => t.querySelector('img')?.getAttribute('src'))).toEqual(['build-rib', 'build-gusset', 'build-web', 'build-flange'].map(host.png));
    expect(tiles(card).every((t) => showOf(card, t.dataset.label!) !== null)).toBe(true);
    expect(skip(card).title).toBe('Apply none of them; let the agent decide');
    pickOf(card, 'Web').click();
    pickOf(card, 'Flange').click();
    expect(pressed(card)).toEqual(['Flange']);
    expect(apply(card).title).toBe('Write “Flange” to bracket.fluid.js');
    apply(card).click();
    await settle();
    expect(client.chooseVariant).toHaveBeenCalledWith('s', 'v1', { pick: 'Flange' });
  });

  it('a pick is one tile, a second click takes it back, and Apply writes it: the card settles with the picked tile marked', async () => {
    const client = new FakeChatClient();
    proposingSession(client);
    const h = mount(client, {}, { variants: variantsHost() });
    await opened(h);
    const card = h.$('[data-part="variants"]')!;
    expect(skip(card).title).toBe('Apply neither; let the agent decide');
    expect(pressed(card)).toEqual([]);
    pickOf(card, 'Rib').click();
    pickOf(card, 'Gusset').click();
    expect(pressed(card)).toEqual(['Gusset']);
    pickOf(card, 'Gusset').click();
    expect(pressed(card)).toEqual([]);
    expect(apply(card).disabled).toBe(true);
    pickOf(card, 'Rib').click();
    expect(apply(card).textContent).toBe('Apply');
    expect(apply(card).title).toBe('Write “Rib” to bracket.fluid.js');
    apply(card).click();
    await settle();
    expect(client.chooseVariant).toHaveBeenCalledTimes(1);
    expect(client.chooseVariant).toHaveBeenCalledWith('s', 'v1', { pick: 'Rib' });
    expect(card.dataset.state).toBe('picked');
    // Settled: the tiles stay with their pictures, the picked one marked, and nothing to click.
    expect(card.querySelectorAll('button, input')).toHaveLength(0);
    expect(tiles(card).map((t) => [t.dataset.label, t.dataset.picked, !!t.querySelector('img')])).toEqual([['Rib', 'true', true], ['Gusset', 'false', true]]);
    expect(card.querySelector('[data-ref="variants-outcome"]')!.textContent!.trim()).toBe('You picked Rib.');
    // The write of the pick is the tool card that follows.
    expect(h.$('[data-part="tool"] [data-ref="title"]')!.textContent).toBe('Apply "Rib" to bracket.fluid.js');
    expect(h.panel.el.dataset.status).toBe('running');
  });

  it('a variant that did not build says why and cannot be picked', async () => {
    const client = new FakeChatClient();
    proposingSession(client, variantsPart({
      variants: [RIB_TILE, { ...GUSSET_TILE, state: 'failed', error: 'Fillet 1 does not build (line 7): the radius may be too large' }, ],
    }));
    const h = mount(client, {}, { variants: variantsHost() });
    await opened(h);
    const card = h.$('[data-part="variants"]')!;
    expect(tile(card, 'Gusset').dataset.state).toBe('failed');
    expect(tile(card, 'Gusset').querySelector('[data-ref="variant-error"]')!.textContent!.trim()).toBe('Fillet 1 does not build (line 7): the radius may be too large');
    expect(pickOf(card, 'Gusset').disabled).toBe(true);
    // What did build of it is still drawn.
    expect(tile(card, 'Gusset').querySelector('img')).not.toBeNull();
    pickOf(card, 'Gusset').click();
    expect(pressed(card)).toEqual([]);
    expect(pickOf(card, 'Rib').disabled).toBe(false);

    // One that did not compile has no build: no picture to draw, no viewport toggle.
    const noBuild = new FakeChatClient();
    proposingSession(noBuild, variantsPart({ variants: [RIB_TILE, { label: 'Gusset', state: 'failed', error: 'It does not compile: gusset is not defined (line 2)' }] }));
    const h2 = mount(noBuild, {}, { variants: variantsHost() });
    await opened(h2);
    const failed = tile(h2.$('[data-part="variants"]')!, 'Gusset');
    expect(failed.querySelector('[data-ref="variant-placeholder"]')!.textContent!.trim()).toBe('Did not build');
    expect(failed.querySelector('[data-ref="variant-show"]')).toBeNull();
  });

  it('the user\'s own words are an answer instead of a pick: whichever they touched last is what is sent', async () => {
    const client = new FakeChatClient();
    proposingSession(client);
    const h = mount(client, {}, { variants: variantsHost() });
    await opened(h);
    const card = h.$('[data-part="variants"]')!;
    pickOf(card, 'Rib').click();
    write(field(card), 'neither');
    // Typing takes the pick back, and the button now sends words.
    expect(pressed(card)).toEqual([]);
    expect(apply(card).textContent).toBe('Send');
    // Picking a tile empties the field.
    pickOf(card, 'Gusset').click();
    expect(field(card).value).toBe('');
    expect(apply(card).textContent).toBe('Apply');
    write(field(card), '  neither — make the base thicker ');
    field(card).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(client.chooseVariant).toHaveBeenCalledWith('s', 'v1', { text: 'neither — make the base thicker' });
    expect(card.dataset.state).toBe('answered');
    expect(card.querySelector('[data-ref="variants-outcome"]')!.textContent!.trim()).toBe('neither — make the base thicker');
    expect(tiles(card).map((t) => t.dataset.picked)).toEqual(['false', 'false']);
    expect(card.querySelectorAll('button, input')).toHaveLength(0);
  });

  it('Enter in an empty field sends nothing; Skip leaves the choice to the agent', async () => {
    const client = new FakeChatClient();
    proposingSession(client);
    const h = mount(client, {}, { variants: variantsHost() });
    await opened(h);
    const card = h.$('[data-part="variants"]')!;
    field(card).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(client.chooseVariant).not.toHaveBeenCalled();
    skip(card).click();
    await settle();
    expect(client.chooseVariant).toHaveBeenCalledWith('s', 'v1', { skip: true });
    expect(card.dataset.state).toBe('skipped');
    expect(card.querySelector('[data-ref="variants-outcome"]')!.textContent!.trim()).toBe('You skipped this; the agent decides.');
  });

  it('"Show in viewport" draws one variant over the model at a time, and it goes on toggle, pick, skip and when the panel closes', async () => {
    const client = new FakeChatClient();
    proposingSession(client);
    const host = variantsHost();
    const h = mount(client, {}, { variants: host });
    await opened(h);
    const card = h.$('[data-part="variants"]')!;
    const rib = showOf(card, 'Rib')!;
    const gusset = showOf(card, 'Gusset')!;
    expect(rib.textContent!.trim()).toBe('Show in viewport');
    expect([rib.getAttribute('aria-pressed'), gusset.getAttribute('aria-pressed')]).toEqual(['false', 'false']);
    // Looking closer is not picking.
    rib.click();
    await settle();
    expect(host.ghost).toBe('build-rib');
    expect(rib.getAttribute('aria-pressed')).toBe('true');
    expect(pressed(card)).toEqual([]);
    gusset.click();
    await settle();
    expect(host.ghost).toBe('build-gusset');
    expect([rib.getAttribute('aria-pressed'), gusset.getAttribute('aria-pressed')]).toEqual(['false', 'true']);
    gusset.click();
    await settle();
    expect(host.ghost).toBeNull();
    expect(gusset.getAttribute('aria-pressed')).toBe('false');

    // Closing the panel takes the variant out of the viewport; the card still waits.
    rib.click();
    await settle();
    h.panel.close();
    expect(host.ghost).toBeNull();
    h.panel.show();
    await settle();
    expect(showOf(card, 'Rib')!.getAttribute('aria-pressed')).toBe('false');

    // Answering the card takes it out too.
    showOf(card, 'Rib')!.click();
    await settle();
    expect(host.ghost).toBe('build-rib');
    pickOf(card, 'Gusset').click();
    apply(card).click();
    await settle();
    expect(card.dataset.state).toBe('picked');
    expect(host.ghost).toBeNull();
    expect(card.querySelector('[data-ref="variant-show"]')).toBeNull();
  });

  it('a variant shown in the viewport goes when the card is skipped, stopped, or leaves the screen', async () => {
    for (const leave of ['skip', 'stop', 'new chat'] as const) {
      const client = new FakeChatClient();
      proposingSession(client);
      const host = variantsHost();
      const h = mount(client, {}, { variants: host });
      await opened(h);
      const card = h.$('[data-part="variants"]')!;
      showOf(card, 'Rib')!.click();
      await settle();
      expect(host.ghost, leave).toBe('build-rib');
      if (leave === 'skip') {
        skip(card).click();
      } else if (leave === 'stop') {
        update(client, { state: 'unanswered', reason: 'Stopped before you chose.' });
      } else {
        h.$<HTMLButtonElement>('[data-ref="new-chat"]')!.click();
      }
      await settle();
      expect(host.ghost, leave).toBeNull();
    }
  });

  it('offers no viewport toggle for an assembly, without a host to draw it, or once the engine let the build go', async () => {
    const assembly = new FakeChatClient();
    proposingSession(assembly, variantsPart({ variants: [{ ...RIB_TILE, sceneKind: 'assembly' }, GUSSET_TILE] }));
    const h = mount(assembly, {}, { variants: variantsHost() });
    await opened(h);
    const card = h.$('[data-part="variants"]')!;
    expect(showOf(card, 'Rib')).toBeNull();
    expect(showOf(card, 'Gusset')).not.toBeNull();

    const bare = new FakeChatClient();
    proposingSession(bare);
    const plain = mount(bare);
    await opened(plain);
    expect(plain.$$('[data-ref="variant-show"]')).toHaveLength(0);

    const gone = new FakeChatClient();
    proposingSession(gone);
    const host = variantsHost();
    host.showGhost.mockImplementation(async () => false);
    const late = mount(gone, {}, { variants: host });
    await opened(late);
    const show = late.$<HTMLButtonElement>('[data-ref="variant-show"]')!;
    show.click();
    await settle();
    expect(show.getAttribute('aria-pressed')).toBe('false');
    expect(show.disabled).toBe(true);
    expect(show.title).toContain('no longer kept');
  });

  it('a reloaded card shows the pictures the session kept, without drawing them again', async () => {
    const client = new FakeChatClient();
    proposingSession(client, variantsPart({
      state: 'picked',
      picked: 'Gusset',
      variants: [{ ...RIB_TILE, image: 'rib-kept.png' }, { ...GUSSET_TILE, image: 'gusset-kept.png' }],
    }));
    const host = variantsHost();
    const h = mount(client, {}, { variants: host });
    await opened(h);
    const card = h.$('[data-part="variants"]')!;
    expect(tiles(card).map((t) => t.querySelector('img')!.getAttribute('src'))).toEqual([client.fileUrl('s', 'rib-kept.png'), client.fileUrl('s', 'gusset-kept.png')]);
    expect(host.picture).not.toHaveBeenCalled();
    expect(client.saveVariantPicture).not.toHaveBeenCalled();
    expect(tiles(card).map((t) => t.dataset.picked)).toEqual(['false', 'true']);
    expect(card.querySelectorAll('button, input')).toHaveLength(0);
  });

  it('a tile whose picture was never kept and whose build the engine let go says so', async () => {
    const client = new FakeChatClient();
    proposingSession(client, variantsPart({
      state: 'unanswered',
      reason: 'The app restarted before you chose.',
      variants: [{ ...RIB_TILE, image: 'rib-kept.png' }, GUSSET_TILE, ],
    }));
    const host = variantsHost({ 'build-gusset': null });
    const h = mount(client, {}, { variants: host });
    await opened(h);
    const card = h.$('[data-part="variants"]')!;
    expect(tile(card, 'Rib').querySelector('img')).not.toBeNull();
    expect(tile(card, 'Gusset').querySelector('img')).toBeNull();
    expect(tile(card, 'Gusset').querySelector('[data-ref="variant-placeholder"]')!.textContent!.trim()).toBe('No picture');
    expect(client.saveVariantPicture).not.toHaveBeenCalled();
    expect(card.querySelector('[data-ref="variants-outcome"]')!.textContent!.trim()).toBe('The app restarted before you chose.');
  });

  it('a second tab shows a picture another page drew, keeping what the user picked and typed', async () => {
    const client = new FakeChatClient();
    proposingSession(client);
    // This page cannot draw (its mesh fetch failed); another page's picture arrives as the tile's `image`.
    const h = mount(client, {}, { variants: variantsHost({ 'build-rib': null, 'build-gusset': null }) });
    await opened(h);
    const card = h.$('[data-part="variants"]')!;
    expect(tiles(card).map((t) => !!t.querySelector('img'))).toEqual([false, false]);
    pickOf(card, 'Rib').click();
    update(client, { variants: [{ ...RIB_TILE, image: 'Rib.png' }, GUSSET_TILE] });
    await settle();
    expect(tile(card, 'Rib').querySelector('img')!.getAttribute('src')).toBe(client.fileUrl('s', 'Rib.png'));
    expect(pressed(card)).toEqual(['Rib']);
  });

  it('settled elsewhere (another tab, a stop): the controls go and the card says how it ended', async () => {
    const client = new FakeChatClient();
    proposingSession(client);
    const h = mount(client, {}, { variants: variantsHost() });
    await opened(h);
    const card = h.$('[data-part="variants"]')!;
    pickOf(card, 'Rib').click();
    update(client, { state: 'unanswered', reason: 'Stopped before you chose.', variants: [RIB_TILE, { label: 'Gusset', state: 'cancelled' }] });
    await settle();
    expect(card.dataset.state).toBe('unanswered');
    expect(card.querySelectorAll('button, input')).toHaveLength(0);
    expect(card.querySelector('[data-ref="variants-outcome"]')!.textContent!.trim()).toBe('Stopped before you chose.');
    expect(tile(card, 'Gusset').querySelector('[data-ref="variant-placeholder"]')!.textContent!.trim()).toBe('Not built');

    update(client, { state: 'failed', reason: 'bracket.fluid.js changed after these were built, so "Rib" was not written.' });
    expect(card.querySelector<HTMLElement>('[data-ref="variants-outcome"]')!.dataset.kind).toBe('failed');
  });

  it('a reply the engine did not take: the controls come back with what was picked, and the reason shows', async () => {
    const client = new FakeChatClient();
    proposingSession(client);
    let release!: () => void;
    client.chooseVariant.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ ok: false, status: 0, error: 'FluidCAD did not answer.' });
    }));
    const h = mount(client, {}, { variants: variantsHost() });
    await opened(h);
    const card = h.$('[data-part="variants"]')!;
    pickOf(card, 'Gusset').click();
    apply(card).click();
    await settle();
    // While it goes, the pick, the field and the buttons wait.
    expect([pickOf(card, 'Rib'), pickOf(card, 'Gusset'), field(card), apply(card), skip(card)].every((c) => c.disabled)).toBe(true);
    release();
    await settle();
    expect(apply(card).disabled).toBe(false);
    expect(pressed(card)).toEqual(['Gusset']);
    expect(h.$('[data-ref="status"]')!.textContent).toContain('FluidCAD did not answer.');
  });
});

// --- Parameters the agent offers (offer_params, §26) -------------------------

// jsdom ships no CSS.escape, and a part's row key (`["Plate","Width"]`) needs
// its quotes escaped inside the attribute selector the panel's rows use.
if (typeof globalThis.CSS === 'undefined' || globalThis.CSS.escape('"') === '"') {
  (globalThis as any).CSS = { escape: (value: string) => value.replace(/["\\]/g, '\\$&') };
}

const PLATE_FILE = '/ws/plate.part.js';
const WIDTH: ParamCardDefinition = { label: 'Width', kind: 'part', body: 'Plate', defaultValue: 40, currentValue: 40, controlType: 'slider', min: 20, max: 80, step: 5 };
const DEPTH: ParamCardDefinition = { label: 'Depth', kind: 'part', body: 'Plate', defaultValue: 5, currentValue: 5, controlType: 'auto', description: 'Plate thickness' };
const STYLE: ParamCardDefinition = {
  label: 'Style',
  kind: 'part',
  body: 'Plate',
  defaultValue: 'round',
  currentValue: 'round',
  controlType: 'select',
  options: [{ label: 'Round', value: 'round' }, { label: 'Square', value: 'square' }],
};
const RIBBED: ParamCardDefinition = { label: 'Ribbed', kind: 'part', body: 'Plate', defaultValue: false, currentValue: false, controlType: 'checkbox' };

function paramsPart(overrides: Partial<ParamsPart> = {}): ParamsPart {
  return {
    type: 'params',
    id: 'p1',
    file: 'plate.part.js',
    absPath: PLATE_FILE,
    note: 'Wider plates need the ribs.',
    params: [
      { label: 'Width', part: 'Plate' },
      { label: 'Depth', part: 'Plate' },
      { label: 'Style', part: 'Plate' },
      { label: 'Ribbed', part: 'Plate' },
    ],
    ...overrides,
  };
}

/** A session whose last turn, ended, left `part` in the chat: a card is used after its turn. */
function offeringSession(client: FakeChatClient, part: ParamsPart = paramsPart()) {
  return client.addSession({
    id: 's',
    title: 'Plate',
    status: { state: 'idle' },
    messages: [
      { id: 'u1', role: 'user', turnId: 't1', createdAt: '', parts: [{ type: 'text', id: 'u1t', text: 'a plate, roughly 40 wide' }] },
      { id: 'a1', role: 'assistant', turnId: 't1', createdAt: '', parts: [part] },
    ],
    turns: [{ id: 't1', userMessageId: 'u1', revertible: false, endedAt: '2026-11-22T10:00:00.000Z', endReason: 'done' }],
  });
}

/**
 * The model on screen as the page gives it to a card, standing in for the
 * engine: a session value shows in the render that follows it, Reset puts
 * the file's value back, Keep makes the value the declared default.
 */
function paramsHost(model: Partial<ParamCardModel> = {}, options: { keep?: boolean; refuse?: Record<string, string> } = {}) {
  const listeners = new Set<() => void>();
  const same = (p: ParamCardDefinition, label: string, body?: string) => p.label === label && p.body === body;
  const host = {
    current: { file: PLATE_FILE, params: [WIDTH, DEPTH, STYLE, RIBBED], configuration: 'Default', ...model } as ParamCardModel,
    listeners,
    /** A render: the model on screen is now `next`. */
    render(next: Partial<ParamCardModel>) {
      host.current = { ...host.current, ...next };
      for (const listener of [...listeners]) {
        listener();
      }
    },
    model: () => host.current,
    onModelChange: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: vi.fn((label: string, value: unknown, body?: string) => {
      host.render({ params: host.current.params.map((p) => (same(p, label, body) ? { ...p, currentValue: value as never } : p)) });
    }),
    reset: vi.fn((params: { label: string; body?: string }[]) => {
      host.render({
        params: host.current.params.map((p) => (params.some((r) => same(p, r.label, r.body)) ? { ...p, currentValue: p.configuredValue ?? p.defaultValue } : p)),
      });
    }),
    keep: vi.fn(async (label: string, value: unknown, body: string | undefined, _configuration: string) => {
      const reason = options.refuse?.[label];
      if (reason) {
        return { success: false, reason };
      }
      host.render({ params: host.current.params.map((p) => (same(p, label, body) ? { ...p, defaultValue: value as never, currentValue: value as never } : p)) });
      return { success: true };
    }),
  };
  const deps: ParamCardHost = options.keep === false ? { model: host.model, onModelChange: host.onModelChange, set: host.set, reset: host.reset } : host;
  return { host, deps };
}

describe('parameter cards (§26)', () => {
  const rows = (card: Element) => [...card.querySelectorAll<HTMLElement>('[data-ref="param"]')];
  const row = (card: Element, label: string) => rows(card).find((r) => r.dataset.label === label)!;
  const control = <T extends HTMLElement = HTMLInputElement>(card: Element, label: string) => row(card, label).querySelector<T>('[data-param-key]')!;
  const status = (card: Element) => card.querySelector('[data-ref="params-status"]')!.textContent;
  const reset = (card: Element) => card.querySelector<HTMLButtonElement>('[data-ref="params-reset"]')!;
  const keep = (card: Element) => card.querySelector<HTMLButtonElement>('[data-ref="params-keep"]')!;
  const changed = (card: Element) => rows(card).filter((r) => r.dataset.changed === 'true').map((r) => r.dataset.label);
  /** Drag a slider to `value` and let go. */
  const slide = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const choose = (select: HTMLSelectElement, value: string) => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('draws a control per parameter, as the Parameters panel draws them, with the file and the note', async () => {
    const client = new FakeChatClient();
    offeringSession(client);
    const { host, deps } = paramsHost();
    const h = mount(client, {}, { params: deps });
    await opened(h);
    const card = h.$('[data-part="params"]')!;
    expect(card.dataset.live).toBe('true');
    expect(card.querySelector('[data-ref="params-file"]')!.textContent).toBe('plate.part.js');
    expect(card.querySelector('[data-ref="params-note"]')!.textContent).toBe('Wider plates need the ribs.');
    expect(rows(card).map((r) => r.dataset.label)).toEqual(['Width', 'Depth', 'Style', 'Ribbed']);

    // The panel's own rows: a slider with its range and the value beside it, a number field, a select, a switch.
    const width = control(card, 'Width');
    expect([width.type, width.min, width.max, width.step, width.value, width.dataset.paramType]).toEqual(['range', '20', '80', '5', '40', 'slider']);
    expect(row(card, 'Width').querySelector('[data-param-display]')!.textContent).toBe('40');
    const depth = control(card, 'Depth');
    expect([depth.type, depth.value, depth.dataset.paramType]).toEqual(['number', '5', 'number']);
    expect(row(card, 'Depth').textContent).toContain('Plate thickness');
    const style = control<HTMLSelectElement>(card, 'Style');
    expect([...style.options].map((o) => [o.value, o.textContent, o.selected])).toEqual([['round', 'Round', true], ['square', 'Square', false]]);
    const ribbed = control(card, 'Ribbed');
    expect([ribbed.type, ribbed.checked, ribbed.dataset.paramType]).toEqual(['checkbox', false, 'checkbox']);
    // No pencil: a card edits values, not declarations.
    expect(card.querySelector('[data-param-edit]')).toBeNull();

    // Nothing differs from the file yet: nothing to reset or keep. The turn is over, and the card is usable.
    expect(status(card)).toBe('The values are the file\'s.');
    expect([reset(card).disabled, keep(card).disabled]).toEqual([true, true]);
    expect(changed(card)).toEqual([]);
    expect(h.panel.el.dataset.status).toBe('idle');
    expect(host.set).not.toHaveBeenCalled();
  });

  it('a control sets a session value, typed as the parameter is, and the card follows the render', async () => {
    const client = new FakeChatClient();
    offeringSession(client);
    const { host, deps } = paramsHost();
    const h = mount(client, {}, { params: deps });
    await opened(h);
    const card = h.$('[data-part="params"]')!;
    const width = control(card, 'Width');

    // Dragging moves the number beside the slider; letting go sets the value.
    width.value = '55';
    width.dispatchEvent(new Event('input', { bubbles: true }));
    expect(row(card, 'Width').querySelector('[data-param-display]')!.textContent).toBe('55');
    expect(host.set).not.toHaveBeenCalled();
    width.dispatchEvent(new Event('change', { bubbles: true }));
    expect(host.set.mock.calls).toEqual([['Width', 55, 'Plate']]);
    // The render that followed: the same control (it kept the focus it had), its row marked, the count said.
    expect(control(card, 'Width')).toBe(width);
    expect(width.value).toBe('55');
    expect(changed(card)).toEqual(['Width']);
    expect(status(card)).toBe('1 value changed, on screen only.');
    expect([reset(card).disabled, keep(card).disabled]).toEqual([false, false]);

    choose(control<HTMLSelectElement>(card, 'Style'), 'square');
    control(card, 'Ribbed').click();
    expect(host.set.mock.calls.slice(1)).toEqual([['Style', 'square', 'Plate'], ['Ribbed', true, 'Plate']]);
    expect(changed(card)).toEqual(['Width', 'Style', 'Ribbed']);
    expect(status(card)).toBe('3 values changed, on screen only.');
    // Nothing was written, and the session was told nothing.
    expect(host.keep).not.toHaveBeenCalled();
    expect(client.paramsKept).not.toHaveBeenCalled();
  });

  it('shows a value set elsewhere, and leaves a field being typed into as the user has it', async () => {
    const client = new FakeChatClient();
    offeringSession(client);
    const { host, deps } = paramsHost();
    const h = mount(client, {}, { params: deps });
    await opened(h);
    const card = h.$('[data-part="params"]')!;
    const width = control(card, 'Width');
    const depth = control(card, 'Depth');

    // The Parameters panel (or a second tab) moved Width and Style: the card draws the render.
    host.render({ params: [{ ...WIDTH, currentValue: 70 }, DEPTH, { ...STYLE, currentValue: 'square' }, RIBBED] });
    expect(control(card, 'Width')).toBe(width);
    expect(width.value).toBe('70');
    expect(row(card, 'Width').querySelector('[data-param-display]')!.textContent).toBe('70');
    expect(control<HTMLSelectElement>(card, 'Style').value).toBe('square');
    expect(changed(card)).toEqual(['Width', 'Style']);

    // Typing a depth: a render that lands meanwhile does not overwrite the keystrokes.
    depth.focus();
    depth.value = '7';
    host.render({ params: [{ ...WIDTH, currentValue: 75 }, DEPTH, STYLE, RIBBED] });
    expect(depth.value).toBe('7');
    expect(width.value).toBe('75');
    // Leaving the field sends what was typed, as a number.
    depth.dispatchEvent(new Event('input', { bubbles: true }));
    depth.dispatchEvent(new Event('blur'));
    expect(host.set.mock.calls).toEqual([['Depth', 7, 'Plate']]);

    // The file's declaration changed (the agent gave Width another range): the control is drawn again.
    host.render({ params: [{ ...WIDTH, max: 120 }, DEPTH, STYLE, RIBBED] });
    expect(control(card, 'Width')).not.toBe(width);
    expect(control(card, 'Width').max).toBe('120');
  });

  it('Reset drops the session values of the card\'s changed parameters, and those only', async () => {
    const client = new FakeChatClient();
    // The card offers two of the model's four parameters.
    offeringSession(client, paramsPart({ params: [{ label: 'Width', part: 'Plate' }, { label: 'Style', part: 'Plate' }] }));
    const { host, deps } = paramsHost({ params: [{ ...WIDTH, currentValue: 60 }, { ...DEPTH, currentValue: 9 }, STYLE, RIBBED] });
    const h = mount(client, {}, { params: deps });
    await opened(h);
    const card = h.$('[data-part="params"]')!;
    expect(rows(card).map((r) => r.dataset.label)).toEqual(['Width', 'Style']);
    expect(changed(card)).toEqual(['Width']);

    reset(card).click();
    // Depth is changed too, but it is not this card's; Style has nothing to drop.
    expect(host.reset.mock.calls).toEqual([[[{ label: 'Width', body: 'Plate' }]]]);
    expect(control(card, 'Width').value).toBe('40');
    expect(changed(card)).toEqual([]);
    expect([reset(card).disabled, keep(card).disabled]).toEqual([true, true]);
    expect(host.current.params.find((p) => p.label === 'Depth')!.currentValue).toBe(9);
    expect(host.keep).not.toHaveBeenCalled();
    expect(client.paramsKept).not.toHaveBeenCalled();
  });

  it('Keep writes each changed value into the file, tells the session, and says what was kept', async () => {
    const client = new FakeChatClient();
    offeringSession(client);
    const { host, deps } = paramsHost({ params: [{ ...WIDTH, currentValue: 55 }, DEPTH, { ...STYLE, currentValue: 'square' }, RIBBED] });
    let release!: () => void;
    const first = new Promise<void>((resolve) => (release = resolve));
    const write = host.keep.getMockImplementation()!;
    host.keep.mockImplementationOnce(async (...args) => {
      await first;
      return write(...args);
    });
    const h = mount(client, {}, { params: deps });
    await opened(h);
    const card = h.$('[data-part="params"]')!;
    expect(keep(card).title).toBe('Write these values into the file, as the parameters\' defaults');

    keep(card).click();
    await settle();
    // One write at a time; while they go, neither button answers.
    expect(host.keep.mock.calls).toEqual([['Width', 55, 'Plate', 'Default']]);
    expect([reset(card).disabled, keep(card).disabled]).toEqual([true, true]);
    expect(keep(card).querySelector('.loading')).not.toBeNull();
    release();
    await settle();
    expect(host.keep.mock.calls).toEqual([['Width', 55, 'Plate', 'Default'], ['Style', 'square', 'Plate', 'Default']]);
    // The session is told what went into the file: the agent hears it with the next message.
    expect(client.paramsKept.mock.calls).toEqual([['s', 'p1', { kept: [{ label: 'Width', part: 'Plate', value: 55 }, { label: 'Style', part: 'Plate', value: 'square' }] }]]);
    // The values are the file's now: nothing differs, and the card says what it kept.
    expect(changed(card)).toEqual([]);
    expect(card.querySelector('[data-ref="params-kept"]')!.textContent).toBe('Kept in the file: Width 55, Style square');
    expect(card.querySelector('[data-ref="params-error"]')).toBeNull();
    expect([reset(card).disabled, keep(card).disabled]).toEqual([true, true]);
    expect(control(card, 'Width').value).toBe('55');
    // Keep is the user's own action: no turn started, nothing to approve.
    expect(h.panel.el.dataset.status).toBe('idle');
    expect(client.send).not.toHaveBeenCalled();
  });

  it('keeps into the configuration on screen, and a value the file refuses stays on screen with the reason', async () => {
    const client = new FakeChatClient();
    offeringSession(client);
    // The row "Large" is on screen: it sets Width to 60, and a session value sits on that and on Depth.
    const { host, deps } = paramsHost(
      { configuration: 'Large', params: [{ ...WIDTH, configuredValue: 60, currentValue: 65 }, { ...DEPTH, currentValue: 8 }, STYLE, RIBBED] },
      { refuse: { Depth: 'the default of Depth is not a plain value' } },
    );
    const h = mount(client, {}, { params: deps });
    await opened(h);
    const card = h.$('[data-part="params"]')!;
    // A value that is the row's own is not a change, whatever the literal says.
    host.render({ params: [{ ...WIDTH, configuredValue: 60, currentValue: 60 }, { ...DEPTH, currentValue: 8 }, STYLE, RIBBED] });
    expect(changed(card)).toEqual(['Depth']);
    host.render({ params: [{ ...WIDTH, configuredValue: 60, currentValue: 65 }, { ...DEPTH, currentValue: 8 }, STYLE, RIBBED] });
    expect(changed(card)).toEqual(['Width', 'Depth']);
    expect(status(card)).toBe('2 values changed from Large, on screen only.');
    expect(keep(card).title).toBe('Write these values into the configuration Large');

    keep(card).click();
    await settle();
    expect(host.keep.mock.calls).toEqual([['Width', 65, 'Plate', 'Large'], ['Depth', 8, 'Plate', 'Large']]);
    // Only what was written is reported, with its configuration.
    expect(client.paramsKept.mock.calls).toEqual([['s', 'p1', { kept: [{ label: 'Width', part: 'Plate', value: 65, configuration: 'Large' }] }]]);
    expect(card.querySelector('[data-ref="params-kept"]')!.textContent).toBe('Kept in the file: Width 65 (Large)');
    // The refused value was set again (the write may have dropped it), and the card says why it is not in the file.
    expect(host.set.mock.calls).toEqual([['Depth', 8, 'Plate']]);
    expect(card.querySelector('[data-ref="params-error"]')!.textContent).toBe('Not written: Depth (the default of Depth is not a plain value).');
    expect(control(card, 'Depth').value).toBe('8');
    expect(keep(card).disabled).toBe(false);
  });

  it('a parameter the model no longer declares is unavailable, and so is the whole card while another file is on screen', async () => {
    const client = new FakeChatClient();
    offeringSession(client);
    const { host, deps } = paramsHost({ params: [{ ...WIDTH, currentValue: 55 }, DEPTH, STYLE, RIBBED] });
    const h = mount(client, {}, { params: deps });
    await opened(h);
    const card = h.$('[data-part="params"]')!;

    // The agent rewrote the file: Depth is gone, and a part named Lid now has a Width of its own.
    host.render({ params: [{ ...WIDTH, currentValue: 55 }, { ...WIDTH, body: 'Lid', currentValue: 30, defaultValue: 30 }, STYLE, RIBBED] });
    expect(rows(card).map((r) => [r.dataset.label, r.dataset.missing ?? 'live'])).toEqual([['Width', 'live'], ['Depth', 'true'], ['Style', 'live'], ['Ribbed', 'live']]);
    expect(row(card, 'Depth').querySelector('[data-ref="param-why"]')!.textContent).toBe('No longer in the model');
    expect(row(card, 'Depth').querySelector('input, select, button')).toBeNull();
    // The Plate's Width is still the card's, not the Lid's.
    expect(control(card, 'Width').value).toBe('55');
    expect([card.dataset.live, reset(card).disabled]).toEqual(['true', false]);

    // Another file comes on screen: no control to drag and no value (the card has none of its own), and what to do.
    host.render({ file: '/ws/other.part.js', params: [{ ...WIDTH, body: 'Other', currentValue: 99 }] });
    expect(card.dataset.live).toBe('false');
    expect(card.querySelectorAll('[data-param-key]')).toHaveLength(0);
    expect(rows(card).map((r) => r.textContent)).toEqual(['Width', 'Depth', 'Style', 'Ribbed']);
    expect(status(card)).toBe('Open plate.part.js to use these controls.');
    expect([reset(card), keep(card)]).toEqual([null, null]);

    // No model at all, then the card's file again: the controls are back, at the values the model has.
    host.render({ file: null, params: [] });
    expect(status(card)).toBe('Open plate.part.js to use these controls.');
    host.render({ file: 'virtual:live-render:/ws/plate.part.js', params: [WIDTH, DEPTH, STYLE, RIBBED] });
    expect(card.dataset.live).toBe('true');
    expect(rows(card).every((r) => r.dataset.missing === undefined)).toBe(true);
    expect(control(card, 'Width').value).toBe('40');

    // The file declares none of them any more.
    host.render({ params: [] });
    expect(card.dataset.live).toBe('false');
    expect(status(card)).toBe('The model no longer declares these parameters.');
    expect([reset(card), keep(card)]).toEqual([null, null]);
  });

  it('an old chat\'s card reopens on the model as it is now, with what was kept', async () => {
    const client = new FakeChatClient();
    offeringSession(client, paramsPart({ kept: [{ label: 'Width', part: 'Plate', value: 55 }, { label: 'Style', part: 'Plate', value: 'square', configuration: 'Large' }] }));
    // Since the card was offered, the file's Width became 55 (the kept value) and a session value moved it to 60.
    const { deps } = paramsHost({ params: [{ ...WIDTH, defaultValue: 55, currentValue: 60 }, DEPTH, STYLE, RIBBED] }, { keep: false });
    const h = mount(client, {}, { params: deps });
    await opened(h);
    const card = h.$('[data-part="params"]')!;
    expect(control(card, 'Width').value).toBe('60');
    expect(changed(card)).toEqual(['Width']);
    expect(card.querySelector('[data-ref="params-kept"]')!.textContent).toBe('Kept in the file: Width 55, Style square (Large)');
    // A host that cannot edit source offers Reset and no Keep.
    expect(reset(card).disabled).toBe(false);
    expect(keep(card)).toBeNull();

    // Kept in another tab: this card says so from the event.
    client.emit('s', { type: 'part-update', messageId: 'a1', partId: 'p1', patch: { kept: [{ label: 'Width', part: 'Plate', value: 60 }] } });
    await settle();
    expect(card.querySelector('[data-ref="params-kept"]')!.textContent).toBe('Kept in the file: Width 60');
    expect(control(card, 'Width').value).toBe('60');
  });

  it('without a model to read, lists the parameters by name', async () => {
    const client = new FakeChatClient();
    offeringSession(client);
    const h = mount(client);
    await opened(h);
    const card = h.$('[data-part="params"]')!;
    expect(card.dataset.live).toBe('false');
    expect(rows(card).map((r) => r.textContent)).toEqual(['Width', 'Depth', 'Style', 'Ribbed']);
    expect(card.querySelectorAll('input, select, button')).toHaveLength(0);
    expect(status(card)).toBe('The controls need the model on screen.');
  });

  it('takes labels, option texts and the note as text, and a range that is not a number as no range', async () => {
    const client = new FakeChatClient();
    const markup = '<img src=x onerror="window.pwned=1">';
    const hostile: ParamCardDefinition = {
      label: `W"${markup}`,
      kind: 'part',
      body: `P${markup}`,
      defaultValue: 4,
      currentValue: 4,
      controlType: 'slider',
      min: `0" autofocus onfocus="window.pwned=1` as never,
      max: 10,
      description: markup,
    };
    const select: ParamCardDefinition = { ...STYLE, label: 'Kind', options: [{ label: markup, value: `a"${markup}` }], currentValue: `a"${markup}`, defaultValue: `a"${markup}` };
    offeringSession(client, paramsPart({
      note: markup,
      file: `plate${markup}.part.js`,
      params: [
        { label: hostile.label, part: hostile.body },
        { label: 'Kind', part: 'Plate' },
        { label: `Gone${markup}`, part: `P${markup}` },
      ],
    }));
    const { host, deps } = paramsHost({ params: [hostile, select] });
    const h = mount(client, {}, { params: deps });
    await opened(h);
    const card = h.$('[data-part="params"]')!;
    // Nothing of it became an element or an attribute.
    expect(card.querySelectorAll('img')).toHaveLength(0);
    expect(card.querySelector('[onerror], [onfocus], [autofocus]')).toBeNull();
    expect(card.querySelector('[data-ref="params-note"]')!.textContent).toBe(markup);
    expect(card.querySelector('[data-ref="params-file"]')!.textContent).toBe(`plate${markup}.part.js`);
    const slider = rows(card)[0].querySelector<HTMLInputElement>('[data-param-key]')!;
    expect(slider.dataset.paramLabel).toBe(hostile.label);
    // The range that was no number is left out (the slider's own default), the one that was stays.
    expect([slider.min, slider.max]).toEqual(['0', '10']);
    expect(rows(card)[0].textContent).toContain(markup);
    expect([...rows(card)[1].querySelectorAll('option')].map((o) => [o.textContent, o.value])).toEqual([[markup, `a"${markup}`]]);
    expect(rows(card)[2].textContent).toBe(`Gone${markup}No longer in the model`);
    // The control still names its parameter exactly.
    slide(slider, '7');
    expect(host.set.mock.calls).toEqual([[hostile.label, 7, hostile.body]]);
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it('stops following the model when its chat leaves the screen', async () => {
    const client = new FakeChatClient();
    offeringSession(client);
    client.addSession({ id: 'other', title: 'Other', updatedAt: '2026-11-16T10:00:00.000Z' });
    const { host, deps } = paramsHost();
    const h = mount(client, {}, { params: deps });
    await opened(h);
    expect(host.listeners.size).toBe(1);
    await h.panel.state.openSession('other');
    await settle();
    expect(h.$('[data-part="params"]')).toBeNull();
    expect(host.listeners.size).toBe(0);
    // Back on the chat, its card follows again; closing the panel for good lets go.
    await h.panel.state.openSession('s');
    await settle();
    expect(host.listeners.size).toBe(1);
    h.panel.destroy();
    expect(host.listeners.size).toBe(0);
  });
});

describe('the permission mode chip', () => {
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
