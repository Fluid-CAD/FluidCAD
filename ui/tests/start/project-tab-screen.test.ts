// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContractError } from '../../src/start/contract-guards';
import { START_SCREEN_PROTOCOL, type StartScreenHost, type WindowState } from '../../src/start/host';
import { ProjectTabScreen, type TabOpening } from '../../src/start/project-tab-screen';

/**
 * The tab `npx fluidcad` opens a project in: the opening panel alone, from
 * its first frame.
 */

const project = { path: '/home/you/cad/bracket', name: 'bracket' };
const opening: TabOpening = { phase: 'opening', project, status: { step: 'resolving' } };

function fakeHost(overrides: Partial<StartScreenHost> = {}) {
  const pushed: { state?: (state: WindowState) => void } = {};
  const host = {
    hello: vi.fn(async () => ({ ok: true, appVersion: '0.0.45', platform: 'linux', home: '/home/you', projectsRoot: null })),
    windowState: vi.fn(async (): Promise<WindowState> => opening),
    onWindowState: vi.fn((handler: (state: WindowState) => void) => (pushed.state = handler)),
    cancelOpen: vi.fn(async () => undefined),
    retryOpen: vi.fn(async () => undefined),
    list: vi.fn(),
    feed: vi.fn(),
    appearance: vi.fn(),
    ...overrides,
  } as unknown as StartScreenHost & Record<'hello' | 'windowState' | 'cancelOpen' | 'retryOpen' | 'list' | 'feed' | 'appearance', ReturnType<typeof vi.fn>>;
  return { host, pushed };
}

function mount(overrides: Partial<StartScreenHost> = {}, first: TabOpening = opening) {
  const { host, pushed } = fakeHost(overrides);
  const root = document.createElement('div');
  document.body.appendChild(root);
  const screen = new ProjectTabScreen(root, host, first);
  return { root, host, pushed, screen };
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  return [...root.querySelectorAll('button')].find((b) => b.textContent === label)!;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('ProjectTabScreen', () => {
  it('draws the opening panel before it has asked the start server anything, and none of the start screen', () => {
    const { root, host } = mount();
    expect(root.textContent).toContain('Opening bracket…');
    expect(root.querySelector('[data-status]')!.getAttribute('data-status')).toBe('resolving');
    expect(root.querySelector('main')).toBeNull();
    expect(root.textContent).not.toContain('New Project');
    expect(host.hello).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button(root, 'Cancel'));
  });

  it('says a new project is being set up from the first frame', () => {
    const { root } = mount({}, { phase: 'opening', project, status: { step: 'creating' } });
    expect(root.querySelector('[data-status]')!.getAttribute('data-status')).toBe('creating');
  });

  it('introduces itself, opens the project, follows its progress, and never asks for the recents or the feed', async () => {
    const { root, host, pushed, screen } = mount();
    await screen.start();
    expect(host.hello).toHaveBeenCalledWith(START_SCREEN_PROTOCOL);
    expect(host.windowState).toHaveBeenCalledTimes(1);
    pushed.state!({ phase: 'opening', project, status: { step: 'starting', version: '0.0.45', source: 'builtin' } });
    expect(root.textContent).toContain('Starting engine 0.0.45…');
    expect(host.list).not.toHaveBeenCalled();
    expect(host.feed).not.toHaveBeenCalled();
    expect(host.appearance).not.toHaveBeenCalled();
  });

  it("cancels through the host, and retries a failed open on the start server", async () => {
    const { root, host, pushed, screen } = mount();
    await screen.start();
    button(root, 'Cancel').click();
    expect(host.cancelOpen).toHaveBeenCalledTimes(1);

    pushed.state!({ phase: 'failed', project, message: 'The engine did not start.' });
    expect(root.textContent).toContain('bracket could not be opened');
    expect(root.textContent).toContain('The engine did not start.');
    button(root, 'Try again').click();
    expect(host.retryOpen).toHaveBeenCalledTimes(1);
    expect(host.windowState).toHaveBeenCalledTimes(1);
  });

  it('shows a call that did not go through on the panel, and asks again on Try again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const windowState = vi
      .fn<() => Promise<WindowState>>()
      .mockRejectedValueOnce(new Error('FluidCAD is not running any more.'))
      .mockResolvedValueOnce({ phase: 'opening', project, status: { step: 'starting', version: '0.0.45', source: 'cache' } });
    const { root, host, screen } = mount({ windowState });
    await screen.start();
    expect(root.querySelector('[data-message]')!.textContent).toBe('Something went wrong: FluidCAD is not running any more.');

    button(root, 'Try again').click();
    expect(root.textContent).toContain('Opening bracket…');
    await vi.waitFor(() => expect(root.textContent).toContain('Starting engine 0.0.45…'));
    expect(host.retryOpen).not.toHaveBeenCalled();
    expect(windowState).toHaveBeenCalledTimes(2);
  });

  it('stops at a protocol mismatch, or a reply it cannot read, and says so', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mismatch = mount({ hello: vi.fn(async () => ({ ok: false, appVersion: '0.0.46', platform: 'linux', home: '/h', projectsRoot: null })) });
    await mismatch.screen.start();
    expect(mismatch.host.windowState).not.toHaveBeenCalled();
    expect(mismatch.root.querySelector('[data-message]')!.textContent).toContain('does not match the app');

    const unreadable = mount({ windowState: vi.fn(async () => Promise.reject(new ContractError('session', 'an object'))) });
    await unreadable.screen.start();
    expect(unreadable.root.querySelector('[data-message]')!.textContent).toContain(
      'The app and its start screen disagree (session: expected an object)',
    );
  });
});
