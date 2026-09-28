import { describe, expect, it, vi } from 'vitest';
import { ContractError } from '../../src/start/contract-guards';
import type { WindowState } from '../../src/start/host';
import { HttpStartHost, type HttpHostEnvironment } from '../../src/start/http-host';
import type { ProjectTabs } from '../../src/start/project-tabs';

/**
 * The start screen's host under `npx fluidcad`: the launcher's API over HTTP,
 * the event stream, and the tab a project opens in.
 */

const BRACKET = '/home/you/cad/bracket';
const project = { path: BRACKET, name: 'bracket' };

type Reply = { status?: number; body: unknown } | Error;

function fakeEnvironment(search = '', replies: Record<string, Reply> = {}) {
  const calls: { method: string; url: string; body: unknown; headers: Record<string, string> }[] = [];
  const listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  const timers: (() => void)[] = [];
  const visible: (() => void)[] = [];
  const tabs = { show: vi.fn(() => true), close: vi.fn(), reopen: vi.fn() };
  const env: HttpHostEnvironment = {
    search,
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers as Record<string, string> });
      const reply = replies[`${method} ${url}`] ?? replies[`${method} ${url.split('?')[0]}`] ?? { body: { ok: true } };
      if (reply instanceof Error) {
        throw reply;
      }
      return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
    }) as typeof fetch,
    openEvents: () => ({
      readyState: 1,
      addEventListener: (type: string, listener: any) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
    }) as unknown as EventSource,
    tabs: tabs as unknown as ProjectTabs,
    navigate: vi.fn(),
    closeTab: vi.fn(),
    openExternal: vi.fn(),
    onVisible: (handler) => visible.push(handler),
    setTimer: (handler) => {
      timers.push(handler);
    },
  };
  const emit = (type: string, data?: unknown) => {
    for (const listener of listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data: JSON.stringify(data ?? null) }));
    }
  };
  const runTimers = () => {
    for (const timer of timers.splice(0)) {
      timer();
    }
  };
  return { env, calls, emit, runTimers, visible, tabs };
}

describe('HttpStartHost on the start screen', () => {
  it('is home, and asks the start server for everything with its header', async () => {
    const { env, calls } = fakeEnvironment('', {
      'GET api/start/projects': { body: { projects: [] } },
      'POST api/start/hello': { body: { ok: true, appVersion: '0.0.46', platform: 'linux', home: '/home/you', projectsRoot: null } },
    });
    const host = new HttpStartHost(env);
    expect(await host.windowState()).toEqual({ phase: 'home' });
    expect(await host.hello(2)).toMatchObject({ ok: true, appVersion: '0.0.46' });
    expect(await host.list()).toEqual({ projects: [] });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['POST api/start/hello', 'GET api/start/projects']);
    expect(calls[0].body).toEqual({ protocol: 2 });
    expect(calls.every((call) => call.headers['x-fluidcad-launcher'] === '1')).toBe(true);
  });

  it('checks every reply, and puts refusals and a vanished server into words', async () => {
    const { env } = fakeEnvironment('', {
      'GET api/start/projects': { body: { projects: 'nope' } },
      'POST api/start/forget': { status: 400, body: { error: 'Expected a project path as a non-empty string.' } },
      'GET api/start/feed': new TypeError('fetch failed'),
    });
    const host = new HttpStartHost(env);
    await expect(host.list()).rejects.toBeInstanceOf(ContractError);
    await expect(host.forget('')).rejects.toThrow('Expected a project path as a non-empty string.');
    await expect(host.feed()).rejects.toThrow('FluidCAD is not running any more. Run npx fluidcad again to start it.');
  });

  it('opens a project that is not open in its tab, and brings an open one forward, starting it again if it stopped', async () => {
    const { env, calls, tabs } = fakeEnvironment('', {
      'GET api/start/projects': {
        body: {
          projects: [
            { path: BRACKET, name: 'bracket', engine: null, engineSource: null, latest: false, upgradeTo: null, lastOpenedAt: '', open: true, thumbnail: null },
          ],
        },
      },
    });
    const host = new HttpStartHost(env);
    await host.open('/home/you/cad/lantern');
    expect(tabs.show).toHaveBeenLastCalledWith('/home/you/cad/lantern', { running: false });
    expect(calls).toHaveLength(0);

    await host.list();
    await host.open(BRACKET);
    expect(tabs.show).toHaveBeenLastCalledWith(BRACKET, { running: true });
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: 'api/sessions', body: { path: BRACKET } });
  });

  it('says so when the browser blocks the tab', async () => {
    const { env, tabs } = fakeEnvironment();
    tabs.show.mockReturnValue(false);
    const host = new HttpStartHost(env);
    await expect(host.open(BRACKET)).rejects.toThrow('The browser blocked the new tab');
  });

  it("closes a project's tab once the project is closed, and sends it to reopen after a pin change", async () => {
    const { env, tabs } = fakeEnvironment('', {
      'POST api/start/close': { body: { ok: false, error: 'bracket has unsaved changes.' } },
      'GET api/start/projects': {
        body: {
          projects: [
            { path: BRACKET, name: 'bracket', engine: '0.0.45', engineSource: 'pin', latest: true, upgradeTo: null, lastOpenedAt: '', open: true, thumbnail: null },
          ],
        },
      },
      'POST api/start/apply-pin': { body: { ok: true } },
    });
    const host = new HttpStartHost(env);
    expect(await host.close(BRACKET)).toEqual({ ok: false, error: 'bracket has unsaved changes.' });
    expect(tabs.close).not.toHaveBeenCalled();

    await host.list();
    expect(await host.applyPin(BRACKET, '0.0.46')).toEqual({ ok: true, error: undefined });
    expect(tabs.reopen).toHaveBeenCalledWith(BRACKET);
  });

  it('asks for fresh previews whenever the start screen comes back into view', () => {
    const { env, calls, visible } = fakeEnvironment();
    new HttpStartHost(env);
    visible.forEach((handler) => handler());
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: 'api/start/refresh-previews' });
  });

  it("browses folders and checks names through the start server, and opens a new project's tab to set it up", async () => {
    const listing = { path: '/home/you/cad', project: false, parent: '/home/you', home: '/home/you', roots: ['/'], entries: [] };
    const { env, calls, tabs } = fakeEnvironment('', {
      'GET api/folders': { body: listing },
      'POST api/folders/check': { body: { path: `${BRACKET}`, state: 'missing' } },
    });
    const host = new HttpStartHost(env);
    if (host.dialogs.kind !== 'page') {
      throw new Error('expected the page dialogs');
    }
    expect(await host.dialogs.browse(null)).toEqual(listing);
    expect(await host.dialogs.browse('/home/you/cad')).toEqual(listing);
    expect(calls.map((call) => call.url)).toEqual(['api/folders', 'api/folders?path=%2Fhome%2Fyou%2Fcad']);
    expect(await host.dialogs.check('/home/you/cad', 'bracket')).toEqual({ path: BRACKET, state: 'missing' });
    expect(calls.at(-1)!.body).toEqual({ parent: '/home/you/cad', name: 'bracket' });
    await host.dialogs.create(BRACKET);
    expect(tabs.show).toHaveBeenCalledWith(BRACKET, { running: false, create: true });
  });

  it('opens links in a new browser tab, http(s) only', async () => {
    const { env } = fakeEnvironment();
    const host = new HttpStartHost(env);
    await host.openLink('https://fluidcad.io/docs');
    await host.openLink('javascript:alert(1)');
    expect(env.openExternal).toHaveBeenCalledTimes(1);
    expect(env.openExternal).toHaveBeenCalledWith('https://fluidcad.io/docs');
  });
});

describe("HttpStartHost in a project's tab", () => {
  const search = `?project=${encodeURIComponent(BRACKET)}&create=1`;

  it('listens first, then opens the project, and draws its progress', async () => {
    const opening = { phase: 'opening', project, status: { step: 'creating' } };
    const { env, calls, emit } = fakeEnvironment(search, { 'POST api/sessions': { body: opening } });
    const host = new HttpStartHost(env);
    const states: WindowState[] = [];
    host.onWindowState((state) => states.push(state));

    const answer = host.windowState();
    await Promise.resolve();
    expect(calls).toHaveLength(0);
    emit('open');
    expect(await answer).toEqual({ phase: 'opening', project, status: { step: 'creating' } });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'api/sessions', body: { path: BRACKET, create: true } });

    emit('session', { path: '/home/you/cad/lantern', view: { phase: 'failed', project: { path: '/home/you/cad/lantern', name: 'lantern' }, message: 'x' } });
    emit('session', { path: BRACKET, view: { phase: 'opening', project, status: { step: 'resolving' } } });
    expect(states).toEqual([{ phase: 'opening', project, status: { step: 'resolving' } }]);
  });

  it("goes to the engine's page once the project runs, and only once", async () => {
    const running = { phase: 'running', project, url: '/p/bracket/', version: '0.0.46', source: 'builtin' };
    const { env, emit } = fakeEnvironment(search, { 'POST api/sessions': { body: { phase: 'opening', project, status: { step: 'resolving' } } } });
    const host = new HttpStartHost(env);
    emit('open');
    await host.windowState();
    emit('session', { path: BRACKET, view: running });
    emit('session', { path: BRACKET, view: running });
    expect(env.navigate).toHaveBeenCalledTimes(1);
    expect(env.navigate).toHaveBeenCalledWith('/p/bracket/');
  });

  it("refuses to send the tab anywhere but a localhost engine", async () => {
    const { env, emit } = fakeEnvironment(search, {
      'POST api/sessions': { body: { phase: 'running', project, url: 'https://evil.example/', version: '0.0.46', source: 'builtin' } },
    });
    const host = new HttpStartHost(env);
    emit('open');
    await expect(host.windowState()).rejects.toBeInstanceOf(ContractError);
    expect(env.navigate).not.toHaveBeenCalled();
  });

  it('closes itself on cancel, or shows the start screen when the browser keeps it open', async () => {
    const { env, calls, emit, runTimers } = fakeEnvironment(search, { 'POST api/sessions': { body: { phase: 'opening', project, status: { step: 'resolving' } } } });
    const host = new HttpStartHost(env);
    emit('open');
    await host.windowState();
    await host.cancelOpen();
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: 'api/sessions/cancel', body: { path: BRACKET } });
    expect(env.closeTab).toHaveBeenCalled();
    runTimers();
    expect(env.navigate).toHaveBeenCalledWith('/');
  });

  it('leaves when its project is closed from elsewhere', async () => {
    const { env, emit } = fakeEnvironment(search, { 'POST api/sessions': { body: { phase: 'opening', project, status: { step: 'resolving' } } } });
    const host = new HttpStartHost(env);
    emit('open');
    await host.windowState();
    emit('session', { path: BRACKET, view: { phase: 'closed', project } });
    expect(env.closeTab).toHaveBeenCalled();
  });

  it('asks where its project is now and then, in case an event went missing', async () => {
    const { env, calls, emit, runTimers } = fakeEnvironment(search, {
      'POST api/sessions': { body: { phase: 'opening', project, status: { step: 'resolving' } } },
      'GET api/sessions': { body: { phase: 'running', project, url: '/p/bracket/', version: '0.0.46', source: 'cache' } },
    });
    const host = new HttpStartHost(env);
    emit('open');
    await host.windowState();
    runTimers();
    await vi.waitFor(() => expect(env.navigate).toHaveBeenCalledWith('/p/bracket/'));
    expect(calls.at(-1)).toMatchObject({ method: 'GET', url: `api/sessions?path=${encodeURIComponent(BRACKET)}` });
  });

  it('does not ask for previews: its page is about to be the project', () => {
    const { env, visible } = fakeEnvironment(search);
    new HttpStartHost(env);
    expect(visible).toHaveLength(0);
  });
});
