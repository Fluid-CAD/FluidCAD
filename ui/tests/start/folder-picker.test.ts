// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FolderPicker } from '../../src/start/folder-picker';
import type { FolderCheck, FolderListing, ProjectDialogs } from '../../src/start/host';

/**
 * The page's own folder picker, for a browser under `npx fluidcad`: browse,
 * pick a project to open, or name a new one and see what it would create.
 */

const CAD: FolderListing = {
  path: '/home/you/cad',
  project: false,
  parent: '/home/you',
  home: '/home/you',
  roots: ['/'],
  entries: [
    { name: 'bracket', path: '/home/you/cad/bracket', project: true },
    { name: 'old stuff', path: '/home/you/cad/old stuff', project: false },
  ],
};

const OLD: FolderListing = { ...CAD, path: '/home/you/cad/old stuff', parent: '/home/you/cad', entries: [] };

function dialogs(checks: Record<string, FolderCheck['state']> = {}) {
  const page: Extract<ProjectDialogs, { kind: 'page' }> = {
    kind: 'page',
    browse: vi.fn(async (path: string | null) => {
      if (path === null || path === CAD.path) {
        return CAD;
      }
      if (path === OLD.path) {
        return OLD;
      }
      throw new Error(`${path} does not exist.`);
    }),
    check: vi.fn(async (parent: string, name: string) => ({ path: `${parent}/${name}`, state: checks[name] ?? 'missing' })),
    create: vi.fn(async () => undefined),
  };
  return page;
}

function picker(checks: Record<string, FolderCheck['state']> = {}) {
  const page = dialogs(checks);
  const handlers = { open: vi.fn(), create: vi.fn() };
  const view = new FolderPicker(page, handlers);
  document.body.appendChild(view.element);
  const q = <T extends HTMLElement>(selector: string) => view.element.querySelector<T>(selector)!;
  return {
    view,
    page,
    handlers,
    rows: () => [...view.element.querySelectorAll<HTMLButtonElement>('[data-path]')],
    action: () => q<HTMLButtonElement>('[data-ref="action"]'),
    status: () => q<HTMLElement>('[data-ref="status"]'),
    name: () => q<HTMLInputElement>('[data-ref="name"]'),
    path: () => q<HTMLInputElement>('[data-ref="path"]'),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('FolderPicker: Open', () => {
  it('starts where the launcher suggests, projects marked', async () => {
    const p = picker();
    await p.view.show('open');
    expect(p.page.browse).toHaveBeenCalledWith(null);
    expect(p.path().value).toBe('/home/you/cad');
    expect(p.rows().map((row) => row.textContent!.replace(/\s+/g, ' ').trim())).toEqual(['bracketproject', 'old stuff']);
    expect(p.action().textContent).toBe('Open cad');
    expect(p.status().textContent).toContain('holds no FluidCAD project yet');
  });

  it('opens the folder selected, or a project double-clicked, inside the click', async () => {
    const p = picker();
    await p.view.show('open');
    p.rows()[0].click();
    expect(p.action().textContent).toBe('Open bracket');
    expect(p.status().textContent).toBe('Opens bracket in a new tab.');
    p.action().click();
    expect(p.handlers.open).toHaveBeenCalledWith('/home/you/cad/bracket');
    expect(p.view.isOpen()).toBe(false);

    await p.view.show('open');
    p.rows()[0].dispatchEvent(new MouseEvent('dblclick'));
    expect(p.handlers.open).toHaveBeenCalledTimes(2);
  });

  it('looks inside a folder on double-click, and goes back up', async () => {
    const p = picker();
    await p.view.show('open');
    p.rows()[1].dispatchEvent(new MouseEvent('dblclick'));
    await vi.waitFor(() => expect(p.path().value).toBe('/home/you/cad/old stuff'));
    expect(p.view.element.textContent).toContain('No folders here.');
    expect(p.handlers.open).not.toHaveBeenCalled();
  });

  it('says when a typed folder does not exist, and keeps what it showed', async () => {
    const p = picker();
    await p.view.show('open');
    p.path().value = '/nowhere';
    p.path().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await vi.waitFor(() => expect(p.status().textContent).toBe('/nowhere does not exist.'));
    expect(p.status().dataset.tone).toBe('error');
    expect(p.rows()).toHaveLength(2);
  });

  it('starts next time where it was last', async () => {
    const p = picker();
    await p.view.show('open');
    p.rows()[1].dispatchEvent(new MouseEvent('dblclick'));
    await vi.waitFor(() => expect(p.path().value).toBe('/home/you/cad/old stuff'));
    p.view.close();
    await p.view.show('open');
    expect(p.page.browse).toHaveBeenLastCalledWith('/home/you/cad/old stuff');
  });

  it('closes on Escape', async () => {
    const p = picker();
    await p.view.show('open');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(p.view.isOpen()).toBe(false);
  });
});

describe('FolderPicker: New project', () => {
  async function typeName(p: ReturnType<typeof picker>, name: string) {
    p.name().value = name;
    p.name().dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(200);
  }

  it('says what a name would create, and creates only a new or empty folder', async () => {
    const p = picker({ lantern: 'project', notes: 'not-empty', 'a/b': 'invalid-name', empty: 'empty' });
    await p.view.show('create');
    expect(p.action().disabled).toBe(true);
    expect(p.status().textContent).toBe('Name the project. The name becomes its folder.');

    await typeName(p, 'lantern');
    expect(p.status().textContent).toContain('already holds a project');
    expect(p.action().disabled).toBe(true);

    await typeName(p, 'notes');
    expect(p.status().textContent).toContain('is not empty');
    await typeName(p, 'a/b');
    expect(p.status().textContent).toContain('cannot use');

    await typeName(p, 'empty');
    expect(p.status().textContent).toBe('Sets the project up in the empty folder ~/cad/empty.');
    expect(p.action().disabled).toBe(false);

    await typeName(p, 'bracket');
    expect(p.status().textContent).toBe('Creates ~/cad/bracket and opens it in a new tab.');
    expect(p.page.check).toHaveBeenLastCalledWith('/home/you/cad', 'bracket');
    p.action().click();
    expect(p.handlers.create).toHaveBeenCalledWith('/home/you/cad/bracket');
    expect(p.view.isOpen()).toBe(false);
  });

  it('creates on Enter in the name, once the name checks out', async () => {
    const p = picker();
    await p.view.show('create');
    await typeName(p, 'bracket');
    p.name().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(p.handlers.create).toHaveBeenCalledWith('/home/you/cad/bracket');
  });

  it('ignores a check that a newer one overtook', async () => {
    const p = picker();
    let release: (value: FolderCheck) => void = () => undefined;
    (p.page.check as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<FolderCheck>((resolve) => (release = resolve)),
    );
    await p.view.show('create');
    await typeName(p, 'slow');
    await typeName(p, 'bracket');
    release({ path: '/home/you/cad/slow', state: 'not-empty' });
    await vi.advanceTimersByTimeAsync(0);
    expect(p.status().textContent).toBe('Creates ~/cad/bracket and opens it in a new tab.');
  });
});

describe('FolderPicker: New project in a projects folder', () => {
  const ROOT: FolderListing = {
    path: '/srv/cad',
    project: false,
    parent: null,
    home: '/srv/cad',
    roots: ['/srv/cad'],
    entries: [{ name: 'bracket', path: '/srv/cad/bracket', project: true }],
  };

  it('asks for a name only, and creates the project in the folder', async () => {
    const page = dialogs({ bracket: 'project' });
    (page.browse as ReturnType<typeof vi.fn>).mockImplementation(async (path: string | null) => {
      if (path !== ROOT.path) {
        throw new Error(`${path} cannot be listed.`);
      }
      return ROOT;
    });
    const handlers = { open: vi.fn(), create: vi.fn() };
    const view = new FolderPicker(page, handlers);
    document.body.appendChild(view.element);
    const q = <T extends HTMLElement>(selector: string) => view.element.querySelector<T>(selector)!;

    await view.show('create', ROOT.path);
    expect(page.browse).toHaveBeenCalledWith(ROOT.path);
    // Nothing to browse: no path bar, no folder list, only the name.
    expect(q('[data-ref="nav"]').classList.contains('hidden')).toBe(true);
    expect(q('[data-ref="list"]').classList.contains('hidden')).toBe(true);
    expect(q('[data-ref="name-row"]').classList.contains('hidden')).toBe(false);
    expect(q('[data-ref="lede"]').textContent).toContain('Name the project');
    expect(document.activeElement).toBe(q('[data-ref="name"]'));
    // The launcher's folder is not a place to come back to next time.
    expect(localStorage.getItem('fluidcad.start.lastFolder')).toBeNull();

    const name = q<HTMLInputElement>('[data-ref="name"]');
    name.value = 'bracket';
    name.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(200);
    expect(q('[data-ref="status"]').textContent).toBe('bracket already holds a project. Choose another name, or open that one.');
    expect(q<HTMLButtonElement>('[data-ref="action"]').disabled).toBe(true);

    name.value = 'arm';
    name.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(200);
    expect(page.check).toHaveBeenLastCalledWith(ROOT.path, 'arm');
    expect(q('[data-ref="status"]').textContent).toBe('Creates arm and opens it in a new tab.');
    q<HTMLButtonElement>('[data-ref="action"]').click();
    expect(handlers.create).toHaveBeenCalledWith('/srv/cad/arm');
    expect(view.isOpen()).toBe(false);
  });
});
