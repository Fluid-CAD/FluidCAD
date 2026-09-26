// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { engineChipState } from '../../src/start/engine-chip';
import type { StartProject } from '../../src/start/host';
import { projectCard } from '../../src/start/project-card';
import { ProjectGrid } from '../../src/start/project-grid';
import { closePopupMenu } from '../../src/ui/popup-menu';

function project(overrides: Partial<StartProject> = {}): StartProject {
  return {
    path: '/home/you/cad/bracket',
    name: 'bracket',
    engine: '0.0.45',
    engineSource: 'pin',
    latest: true,
    upgradeTo: null,
    lastOpenedAt: new Date().toISOString(),
    open: false,
    thumbnail: null,
    ...overrides,
  };
}

function handlers() {
  return {
    open: vi.fn(async () => undefined),
    changeEngine: vi.fn(),
    forget: vi.fn(async () => undefined),
  };
}

function mount(entry: StartProject, h = handlers()) {
  const card = projectCard(entry, { home: '/home/you', menuHost: document.body }, h);
  document.body.appendChild(card);
  return { card, h };
}

afterEach(() => {
  closePopupMenu();
  document.body.innerHTML = '';
});

describe('engine chip', () => {
  it('has one state per situation, in priority order', () => {
    expect(engineChipState(project({ open: true, upgradeTo: '0.0.46' }))).toBe('open');
    expect(engineChipState(project({ engine: null, engineSource: null }))).toBe('unpinned');
    expect(engineChipState(project({ engineSource: 'own', upgradeTo: '0.0.46' }))).toBe('own');
    expect(engineChipState(project({ engine: '0.0.42', latest: false, upgradeTo: '0.0.45' }))).toBe('update');
    expect(engineChipState(project())).toBe('latest');
    expect(engineChipState(project({ engine: '0.0.44', latest: false }))).toBe('pinned');
  });

  it('labels each state', () => {
    const label = (entry: StartProject) => mount(entry).card.querySelector<HTMLElement>('[data-chip]')!.textContent;
    expect(label(project({ open: true }))).toBe('open');
    expect(label(project({ engine: null, engineSource: null }))).toBe('unpinned');
    expect(label(project({ engine: '0.0.41', engineSource: 'own' }))).toBe('0.0.41');
    expect(label(project({ engine: '0.0.42', latest: false, upgradeTo: '0.0.45' }))).toBe('0.0.42 · update');
    expect(label(project())).toBe('latest (0.0.45)');
    expect(label(project({ engine: '0.0.44', latest: false }))).toBe('0.0.44');
  });

  it('opens the engine dialog from the update chip without opening the project', () => {
    const { card, h } = mount(project({ engine: '0.0.42', latest: false, upgradeTo: '0.0.45' }));
    const chip = card.querySelector<HTMLButtonElement>('[data-chip="update"]')!;
    chip.click();
    chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.changeEngine).toHaveBeenCalledTimes(1);
    expect(h.open).not.toHaveBeenCalled();
  });
});

describe('project card', () => {
  it('shows the name, the ~ path, when it was opened and a placeholder without a preview', () => {
    const { card } = mount(project());
    expect(card.textContent).toContain('bracket');
    expect(card.querySelector('bdi')!.textContent).toBe('~/cad/bracket');
    expect(card.textContent).toContain('Opened just now');
    expect(card.textContent).toContain('No preview yet');
    expect(card.querySelector('img')).toBeNull();
  });

  it('shows the preview when there is one', () => {
    const { card } = mount(project({ thumbnail: 'fluidcad-app://thumbnails/abc.png?v=1' }));
    expect(card.querySelector('img')!.getAttribute('src')).toBe('fluidcad-app://thumbnails/abc.png?v=1');
  });

  it('opens on click, Enter and Space, and is busy until the open settles', async () => {
    let finish: () => void = () => undefined;
    const h = handlers();
    h.open.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    const { card } = mount(project(), h);
    card.click();
    expect(card.dataset.busy).toBe('');
    card.click();
    expect(h.open).toHaveBeenCalledTimes(1);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(card.dataset.busy).toBeUndefined();
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    finish();
    await Promise.resolve();
    await Promise.resolve();
    card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(h.open).toHaveBeenCalledTimes(3);
  });

  it('offers Change engine version and Remove from recent in its ⋯ menu', () => {
    const { card, h } = mount(project());
    card.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click();
    const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')];
    expect(rows.map((row) => row.textContent!.trim())).toEqual(['Change engine version…', 'Remove from recent']);
    expect(h.open).not.toHaveBeenCalled();
    rows[1].click();
    expect(h.forget).toHaveBeenCalledWith(expect.objectContaining({ path: '/home/you/cad/bracket' }));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('disables Change engine version for a project on its own install, and says why', () => {
    const { card } = mount(project({ engine: '0.0.41', engineSource: 'own' }));
    card.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click();
    const change = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(change.disabled).toBe(true);
    expect(change.title).toContain('its lockfile decides');
  });
});

describe('project grid', () => {
  it('shows the empty state before the first project', () => {
    const grid = new ProjectGrid(handlers(), document.body);
    document.body.appendChild(grid.element);
    grid.render([], '/home/you');
    expect(grid.element.querySelector('[data-empty]')!.classList.contains('hidden')).toBe(false);
    expect(grid.element.querySelector('[data-project-grid]')!.classList.contains('hidden')).toBe(true);
    expect(grid.element.textContent).toContain('No projects yet');
  });

  it('shows every stored recent, not just the first row', () => {
    const grid = new ProjectGrid(handlers(), document.body);
    grid.render(
      Array.from({ length: 12 }, (_, i) => project({ path: `/p/${i}`, name: `part-${i}` })),
      '/home/you',
    );
    expect(grid.element.querySelectorAll('[data-project-path]')).toHaveLength(12);
    expect(grid.element.querySelector('[data-empty]')!.classList.contains('hidden')).toBe(true);
  });
});
