// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { START_SCREEN_PROTOCOL, guardedHost, type ProjectDialogs, type StartScreenBridge, type WindowState } from '../../src/start/host';
import { StartScreen } from '../../src/start/start-screen';

function fakeBridge(overrides: Partial<StartScreenBridge> = {}) {
  const pushed: { state?: (state: unknown) => void; changed?: () => void } = {};
  const bridge: StartScreenBridge = {
    hello: vi.fn(async () => ({ ok: true, appVersion: '0.0.45', platform: 'linux', home: '/home/you', projectsRoot: null })),
    windowState: vi.fn(async () => ({ phase: 'home' })),
    onWindowState: vi.fn((handler) => (pushed.state = handler)),
    cancelOpen: vi.fn(async () => undefined),
    retryOpen: vi.fn(async () => undefined),
    appearance: vi.fn(async () => ({ theme: 'fluidcad-light' })),
    list: vi.fn(async () => ({
      projects: [
        {
          path: '/home/you/cad/bracket',
          name: 'bracket',
          engine: '0.0.45',
          engineSource: 'pin',
          latest: true,
          upgradeTo: null,
          lastOpenedAt: new Date().toISOString(),
          open: false,
          thumbnail: null,
        },
      ],
    })),
    feed: vi.fn(async () => ({
      tutorials: [{ id: 't', title: 'First part', description: '', url: 'https://fluidcad.io/t', thumbnail: '' }],
      notifications: [{ id: 'n', body: '<p>Hi <a href="https://fluidcad.io">there</a></p>', expiresAt: null, minVersion: null }],
    })),
    dismissNotification: vi.fn(async () => undefined),
    open: vi.fn(async () => undefined),
    openDialog: vi.fn(async () => undefined),
    newProject: vi.fn(async () => undefined),
    close: vi.fn(async () => ({ ok: true })),
    forget: vi.fn(async () => undefined),
    openLink: vi.fn(async () => undefined),
    engineOptions: vi.fn(),
    previewUpgrade: vi.fn(),
    applyPin: vi.fn(),
    onUpgradeProgress: vi.fn(),
    onChanged: vi.fn((handler) => (pushed.changed = handler)),
    ...overrides,
  };
  return { bridge, pushed };
}

async function start(overrides: Partial<StartScreenBridge> = {}) {
  const { bridge, pushed } = fakeBridge(overrides);
  const root = document.createElement('div');
  document.body.appendChild(root);
  await new StartScreen(root, guardedHost(bridge)).start();
  return { root, bridge, pushed };
}

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
});

describe('StartScreen', () => {
  it('introduces itself, then draws the projects, the feed and the saved theme', async () => {
    const { root, bridge } = await start();
    expect(bridge.hello).toHaveBeenCalledWith(START_SCREEN_PROTOCOL);
    expect(root.querySelectorAll('[data-project-path]')).toHaveLength(1);
    expect(root.querySelector('[data-notice-id="n"]')!.textContent).toContain('Hi there');
    expect(root.textContent).toContain('Learn FluidCAD');
    expect(document.documentElement.getAttribute('data-theme')).toBe('fluidcad-light');
  });

  it('stops at a protocol mismatch and says so', async () => {
    const { root, bridge } = await start({ hello: vi.fn(async () => ({ ok: false, appVersion: '0.0.46', platform: 'linux', home: '/h', projectsRoot: null })) });
    expect(bridge.list).not.toHaveBeenCalled();
    expect(root.querySelector('[role="alert"]')!.textContent).toContain('does not match the app');
  });

  it('shows a contract error as one line instead of a half-drawn page', async () => {
    const { root } = await start({ list: vi.fn(async () => ({ projects: [{ name: 1 }] })) });
    const alert = root.querySelector('[role="alert"]')!;
    expect(alert.classList.contains('hidden')).toBe(false);
    expect(alert.textContent).toContain('The app and its start screen disagree (list().projects[0].path: expected a string)');
  });

  it('survives an unreachable feed', async () => {
    const { root } = await start({ feed: vi.fn(async () => Promise.reject(new Error('offline'))) });
    expect(root.querySelector('[role="alert"]')!.classList.contains('hidden')).toBe(true);
    expect(root.querySelectorAll('[data-project-path]')).toHaveLength(1);
  });

  it('dims everything behind the opening overlay, and brings it back', async () => {
    const { root, pushed, bridge } = await start();
    const opening: WindowState = { phase: 'opening', project: { path: '/p', name: 'bracket' }, status: { step: 'resolving' } };
    pushed.state!(opening);
    const main = root.querySelector('main')!;
    expect(main.inert).toBe(true);
    expect(root.textContent).toContain('Opening bracket…');
    [...root.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click();
    expect(bridge.cancelOpen).toHaveBeenCalled();
    pushed.state!({ phase: 'home' });
    expect(main.inert).toBe(false);
  });

  it('re-reads the recents when the shell says they changed, and everything on focus', async () => {
    const { bridge, pushed } = await start();
    pushed.changed!();
    await Promise.resolve();
    expect(bridge.list).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(bridge.list).toHaveBeenCalledTimes(3);
    expect(bridge.appearance).toHaveBeenCalledTimes(2);
    expect(bridge.feed).toHaveBeenCalledTimes(2);
  });

  it('opens a notice link in the browser rather than navigating', async () => {
    const { root, bridge } = await start();
    const link = root.querySelector<HTMLAnchorElement>('[data-notice-id="n"] a')!;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(bridge.openLink).toHaveBeenCalledWith('https://fluidcad.io');
  });

  it('dismisses a notice and remembers it', async () => {
    const { root, bridge } = await start();
    root.querySelector<HTMLButtonElement>('[data-notice-id="n"] button')!.click();
    expect(root.querySelector('[data-notice-id="n"]')).toBeNull();
    expect(bridge.dismissNotification).toHaveBeenCalledWith('n');
  });

  it("uses the desktop app's native dialogs for Open and New Project", async () => {
    const { root, bridge } = await start();
    const button = (label: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === label)!;
    button('Open Project').click();
    await vi.waitFor(() => expect(bridge.openDialog).toHaveBeenCalled());
    // One native dialog at a time: the buttons wait for it.
    await vi.waitFor(() => expect(button('New Project').disabled).toBe(false));
    button('New Project').click();
    await vi.waitFor(() => expect(bridge.newProject).toHaveBeenCalled());
    expect(root.querySelector('#fluidcad-folder-picker-title')).toBeNull();
  });

  it("draws its own folder picker for a host without native dialogs, as a browser's is", async () => {
    const { bridge } = fakeBridge();
    const listing = { path: '/home/you/cad', project: false, parent: '/home/you', home: '/home/you', roots: ['/'], entries: [] };
    const dialogs: ProjectDialogs = {
      kind: 'page',
      browse: vi.fn(async () => listing),
      check: vi.fn(async () => ({ path: '/home/you/cad/bracket', state: 'missing' as const })),
      create: vi.fn(async () => undefined),
    };
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new StartScreen(root, { ...guardedHost(bridge), dialogs }).start();
    [...root.querySelectorAll('button')].find((b) => b.textContent === 'New Project')!.click();
    await vi.waitFor(() => expect(dialogs.browse).toHaveBeenCalled());
    const title = root.querySelector('#fluidcad-folder-picker-title')!;
    expect(title.textContent).toBe('New project');
    expect(title.closest('[role="dialog"]')!.classList.contains('hidden')).toBe(false);
  });

  it('says why a project could not be closed', async () => {
    const { root } = await start({
      list: vi.fn(async () => ({
        projects: [
          { path: '/home/you/cad/bracket', name: 'bracket', engine: '0.0.45', engineSource: 'pin', latest: true, upgradeTo: null, lastOpenedAt: new Date().toISOString(), open: true, thumbnail: null },
        ],
      })),
      close: vi.fn(async () => ({ ok: false, error: 'bracket has unsaved changes in bracket.part.js. Save them in its tab, then close it.' })),
    });
    root.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click();
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent!.includes('Close project'))!.click();
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')!.textContent).toContain('bracket has unsaved changes'));
  });
});

describe('StartScreen: a projects folder', () => {
  it('lists the folder, offers New Project by name only, and no Open Project', async () => {
    const { bridge } = fakeBridge({
      hello: vi.fn(async () => ({ ok: true, appVersion: '0.0.45', platform: 'linux', home: '/home/you', projectsRoot: '/home/you/cad' })),
    });
    const listing = { path: '/home/you/cad', project: false, parent: null, home: '/home/you/cad', roots: ['/home/you/cad'], entries: [] };
    const dialogs: ProjectDialogs = {
      kind: 'page',
      browse: vi.fn(async () => listing),
      check: vi.fn(async () => ({ path: '/home/you/cad/arm', state: 'missing' as const })),
      create: vi.fn(async () => undefined),
    };
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new StartScreen(root, { ...guardedHost(bridge), dialogs }).start();

    const buttons = [...root.querySelectorAll('header button')];
    expect(buttons.find((b) => b.textContent === 'Open Project')!.classList.contains('hidden')).toBe(true);
    expect([...root.querySelectorAll('header span')].map((span) => span.textContent)).toContain('Projects in ~/cad.');
    expect(root.querySelector('section h2')!.textContent).toBe('Projects');
    // A folder's listing is not a recents list: nothing to remove a project from.
    root.querySelector<HTMLButtonElement>('[data-project-path] button[aria-haspopup="menu"]')!.click();
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim());
    expect(items).not.toContain('Remove from recent');
    expect(items).toContain('Change engine version…');

    buttons.find((b) => b.textContent === 'New Project')!.click();
    await vi.waitFor(() => expect(dialogs.browse).toHaveBeenCalledWith('/home/you/cad'));
    const picker = root.querySelector('#fluidcad-folder-picker-title')!.closest('[role="dialog"]')!;
    expect(picker.classList.contains('hidden')).toBe(false);
    expect(picker.querySelector('[data-ref="nav"]')!.classList.contains('hidden')).toBe(true);
    expect(picker.querySelector('[data-ref="list"]')!.classList.contains('hidden')).toBe(true);
    expect(picker.querySelector('[data-ref="name-row"]')!.classList.contains('hidden')).toBe(false);
  });
});

describe('StartScreen: filtering projects', () => {
  const project = (name: string) => ({
    path: `/home/you/cad/${name}`,
    name,
    engine: '0.0.45',
    engineSource: 'pin' as const,
    latest: true,
    upgradeTo: null,
    lastOpenedAt: new Date().toISOString(),
    open: false,
    thumbnail: null,
  });

  it('narrows the grid by name, keeps the text across a refresh, and says when nothing matches', async () => {
    const { root, bridge, pushed } = await start({ list: vi.fn(async () => ({ projects: [project('bracket'), project('Arm'), project('armrest')] })) });
    const filter = root.querySelector<HTMLInputElement>('[data-project-filter]')!;
    const names = () => [...root.querySelectorAll<HTMLElement>('[data-project-path]')].map((card) => card.dataset.projectPath!.split('/').pop());
    expect(filter.classList.contains('hidden')).toBe(false);
    expect(names()).toEqual(['bracket', 'Arm', 'armrest']);

    filter.value = 'ARM';
    filter.dispatchEvent(new Event('input'));
    expect(names()).toEqual(['Arm', 'armrest']);

    // The list is re-read (a project closed, a preview landed): the filter stays.
    pushed.changed!();
    await vi.waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(names()).toEqual(['Arm', 'armrest']));
    expect(filter.value).toBe('ARM');

    filter.value = 'wheel';
    filter.dispatchEvent(new Event('input'));
    expect(names()).toEqual([]);
    const noMatch = root.querySelector<HTMLElement>('[data-no-match]')!;
    expect(noMatch.classList.contains('hidden')).toBe(false);
    expect(noMatch.textContent).toBe('No project is named "wheel". Clear the filter to see every project.');
    expect(root.querySelector('[data-empty]')!.classList.contains('hidden')).toBe(true);

    filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(filter.value).toBe('');
    expect(names()).toEqual(['bracket', 'Arm', 'armrest']);
    expect(noMatch.classList.contains('hidden')).toBe(true);
  });

  it('shows no filter before the first project', async () => {
    const { root } = await start({ list: vi.fn(async () => ({ projects: [] })) });
    expect(root.querySelector('[data-project-filter]')!.classList.contains('hidden')).toBe(true);
    expect(root.querySelector('[data-empty]')!.classList.contains('hidden')).toBe(false);
  });
});

describe('StartScreen: paging projects', () => {
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  /** Twenty projects, listed oldest first on purpose: the grid orders them itself. */
  const many = () =>
    Array.from({ length: 20 }, (_, i) => ({
      path: `/home/you/cad/part-${i + 1}`,
      name: `part-${i + 1}`,
      engine: '0.0.45',
      engineSource: 'pin' as const,
      latest: true,
      upgradeTo: null,
      lastOpenedAt: hoursAgo(20 - i),
      open: false,
      thumbnail: null,
    }));
  const names = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLElement>('[data-project-path]')].map((card) => card.dataset.projectPath!.split('/').pop());

  it('shows eight at a time, most recently opened first, and turns pages', async () => {
    const { root } = await start({ list: vi.fn(async () => ({ projects: many() })) });
    const pager = root.querySelector<HTMLElement>('[data-pager]')!;
    const range = () => root.querySelector('[data-page-range]')!.textContent;
    const prev = root.querySelector<HTMLButtonElement>('[data-page-prev]')!;
    const next = root.querySelector<HTMLButtonElement>('[data-page-next]')!;
    expect(pager.classList.contains('hidden')).toBe(false);
    expect(names(root)).toEqual(['part-20', 'part-19', 'part-18', 'part-17', 'part-16', 'part-15', 'part-14', 'part-13']);
    expect(range()).toBe('1–8 of 20');
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);

    next.click();
    expect(names(root)).toEqual(['part-12', 'part-11', 'part-10', 'part-9', 'part-8', 'part-7', 'part-6', 'part-5']);
    expect(range()).toBe('9–16 of 20');
    next.click();
    expect(names(root)).toEqual(['part-4', 'part-3', 'part-2', 'part-1']);
    expect(range()).toBe('17–20 of 20');
    expect(next.disabled).toBe(true);
    prev.click();
    expect(range()).toBe('9–16 of 20');
  });

  it('keeps the page across a refresh, clamps it when the list shrinks, and starts over on a filter', async () => {
    const projects = many();
    const list = vi.fn(async () => ({ projects }));
    const { root, bridge, pushed } = await start({ list });
    const range = () => root.querySelector('[data-page-range]')!.textContent;
    root.querySelector<HTMLButtonElement>('[data-page-next]')!.click();
    root.querySelector<HTMLButtonElement>('[data-page-next]')!.click();
    expect(range()).toBe('17–20 of 20');

    pushed.changed!();
    await vi.waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(range()).toBe('17–20 of 20'));

    // Four projects gone: the third page no longer exists, so the last one that does shows.
    projects.splice(0, 4);
    pushed.changed!();
    await vi.waitFor(() => expect(range()).toBe('9–16 of 16'));

    const filter = root.querySelector<HTMLInputElement>('[data-project-filter]')!;
    filter.value = 'part-1';
    filter.dispatchEvent(new Event('input'));
    expect(range()).toBe('1–8 of 10');
    expect(names(root)[0]).toBe('part-19');

    filter.value = 'part-2';
    filter.dispatchEvent(new Event('input'));
    // One match: no pages to turn.
    expect(root.querySelector('[data-pager]')!.classList.contains('hidden')).toBe(true);
    expect(names(root)).toEqual(['part-20']);
  });

  it('shows no pager while everything fits on one page', async () => {
    const { root } = await start({ list: vi.fn(async () => ({ projects: many().slice(0, 8) })) });
    expect(root.querySelector('[data-pager]')!.classList.contains('hidden')).toBe(true);
    expect(names(root).length).toBe(8);
  });
});
