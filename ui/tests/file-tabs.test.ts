// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { FileTabs, type FileTab, type FileTabsHandlers } from '../src/editor/tabs';
import { renamedBasename, editableNameOf } from '../src/editor/tab-rename';

// The strip's scroller measures itself through ResizeObserver, which jsdom
// doesn't ship.
beforeAll(() => {
  (globalThis as any).ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

/** Tabs laid out in a row, 100px each, in DOM order — jsdom has no layout. */
const TAB_WIDTH = 100;
function layoutTrack(track: HTMLElement): void {
  for (const child of Array.from(track.children)) {
    (child as HTMLElement).getBoundingClientRect = () => {
      const index = Array.from(track.children).indexOf(child);
      const left = index * TAB_WIDTH;
      return { left, right: left + TAB_WIDTH, width: TAB_WIDTH, top: 0, bottom: 40, height: 40, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
    };
  }
}

const TABS: FileTab[] = [
  { absPath: '/ws/bracket.part.js', relPath: 'bracket.part.js', kind: 'model', dirty: false },
  { absPath: '/ws/rig.assembly.js', relPath: 'rig.assembly.js', kind: 'model', dirty: false },
  { absPath: '/ws/init.js', relPath: 'init.js', kind: 'source', dirty: false },
];

type Harness = {
  container: HTMLElement;
  track: HTMLElement;
  tabEls(): HTMLElement[];
  handlers: FileTabsHandlers & { onActivate: ReturnType<typeof vi.fn>; onReorder: ReturnType<typeof vi.fn>; onRename: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> };
};

const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const el of mounted) {
    el.remove();
  }
  mounted.length = 0;
  document.querySelectorAll('[role="menu"]').forEach((menu) => menu.remove());
});

function mount(overrides: Partial<FileTabsHandlers> = {}, enabled = true): Harness {
  const container = document.createElement('div');
  container.id = 'fluidcad-viewer';
  document.body.appendChild(container);
  mounted.push(container);
  const handlers = {
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onReorder: vi.fn(),
    onRename: vi.fn(),
    ...overrides,
  } as Harness['handlers'];
  const tabs = new FileTabs(container, handlers, enabled);
  tabs.setTabs(TABS, TABS[0].absPath, TABS[0].absPath);
  const track = container.querySelector<HTMLElement>('.w-max')!;
  return {
    container,
    track,
    handlers,
    tabEls: () => Array.from(track.children) as HTMLElement[],
  };
}

function pointer(type: string, target: EventTarget, clientX: number, extra: MouseEventInit = {}): void {
  // jsdom has no PointerEvent; a MouseEvent under the pointer type name reaches
  // the same listeners, and the reorder only reads clientX/button/pointerId.
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 20, button: 0, ...extra });
  (event as any).pointerId = 1;
  target.dispatchEvent(event);
}

describe('FileTabs drag reorder', () => {
  it('reports the new order after dragging a tab past its neighbour', () => {
    const h = mount();
    layoutTrack(h.track);
    const [first] = h.tabEls();
    pointer('pointerdown', first, 50);
    pointer('pointermove', window, 60); // under the threshold: not yet a drag
    expect(h.handlers.onReorder).not.toHaveBeenCalled();
    pointer('pointermove', window, 170); // past the second tab's midpoint
    expect(h.tabEls().map((el) => el.dataset.tabKey)).toEqual([
      '/ws/rig.assembly.js',
      '/ws/bracket.part.js',
      '/ws/init.js',
    ]);
    pointer('pointerup', window, 170);
    expect(h.handlers.onReorder).toHaveBeenCalledWith([
      '/ws/rig.assembly.js',
      '/ws/bracket.part.js',
      '/ws/init.js',
    ]);
  });

  it('swallows the click that ends a drag, but not a plain click', () => {
    const h = mount();
    layoutTrack(h.track);
    const [first] = h.tabEls();
    pointer('pointerdown', first, 50);
    pointer('pointermove', window, 260);
    pointer('pointerup', window, 260);
    first.click();
    expect(h.handlers.onActivate).not.toHaveBeenCalled();
    first.click();
    expect(h.handlers.onActivate).toHaveBeenCalledWith('/ws/bracket.part.js');
  });

  it('does not report an unchanged order, and a press without travel is a click', () => {
    const h = mount();
    layoutTrack(h.track);
    const [first] = h.tabEls();
    pointer('pointerdown', first, 50);
    pointer('pointerup', window, 50);
    first.click();
    expect(h.handlers.onReorder).not.toHaveBeenCalled();
    expect(h.handlers.onActivate).toHaveBeenCalledTimes(1);
  });

  it('restores the order when the gesture is cancelled', () => {
    const h = mount();
    layoutTrack(h.track);
    const [first] = h.tabEls();
    pointer('pointerdown', first, 50);
    pointer('pointermove', window, 260);
    pointer('pointercancel', window, 260);
    expect(h.tabEls().map((el) => el.dataset.tabKey)).toEqual(TABS.map((tab) => tab.absPath));
    expect(h.handlers.onReorder).not.toHaveBeenCalled();
  });

  it('is off when the host offers no reorder handler', () => {
    const h = mount({ onReorder: undefined });
    layoutTrack(h.track);
    const [first] = h.tabEls();
    expect(first.dataset.tabKey).toBeUndefined();
    pointer('pointerdown', first, 50);
    pointer('pointermove', window, 260);
    pointer('pointerup', window, 260);
    expect(h.tabEls().map((el) => el.title)).toEqual(TABS.map((tab) => tab.relPath));
  });
});

function openMenu(h: Harness, tab: HTMLElement): HTMLElement {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 20 });
  tab.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  const menu = h.container.querySelector<HTMLElement>('[role="menu"]');
  expect(menu).not.toBeNull();
  return menu!;
}

function menuRow(menu: HTMLElement, label: string): HTMLButtonElement {
  const row = Array.from(menu.querySelectorAll('button')).find((button) => button.textContent?.trim() === label);
  expect(row, `menu row "${label}"`).toBeDefined();
  return row!;
}

describe('FileTabs rename', () => {
  it('right-click ▸ Rename turns the label into a field holding the stem, and Enter commits the file name', () => {
    const h = mount();
    const [bracket] = h.tabEls();
    const menu = openMenu(h, bracket);
    menuRow(menu, 'Rename').click();
    expect(h.container.querySelector('[role="menu"]')).toBeNull();

    const field = h.tabEls()[0].querySelector<HTMLInputElement>('[data-rename-input]');
    expect(field).not.toBeNull();
    expect(field!.value).toBe('bracket');
    expect(document.activeElement).toBe(field);

    field!.value = 'arm';
    field!.dispatchEvent(new Event('input', { bubbles: true }));
    field!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.handlers.onRename).toHaveBeenCalledWith('/ws/bracket.part.js', 'arm.part.js');
    // The label is back while the owner does the rename.
    expect(h.tabEls()[0].querySelector('[data-rename-input]')).toBeNull();
    expect(h.tabEls()[0].textContent).toContain('bracket');
  });

  it('Escape cancels without renaming', () => {
    const h = mount();
    menuRow(openMenu(h, h.tabEls()[2]), 'Rename').click();
    const field = h.tabEls()[2].querySelector<HTMLInputElement>('[data-rename-input]')!;
    field.value = 'helpers.js';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(h.handlers.onRename).not.toHaveBeenCalled();
    expect(h.tabEls()[2].querySelector('[data-rename-input]')).toBeNull();
  });

  it('an unchanged name commits nothing', () => {
    const h = mount();
    menuRow(openMenu(h, h.tabEls()[0]), 'Rename').click();
    const field = h.tabEls()[0].querySelector<HTMLInputElement>('[data-rename-input]')!;
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.handlers.onRename).not.toHaveBeenCalled();
  });

  it('the field survives a strip re-render mid-edit, keeping the draft', () => {
    const h = mount();
    const tabs = new FileTabs(h.container, h.handlers, true);
    tabs.setTabs(TABS, TABS[0].absPath, TABS[0].absPath);
    const track = h.container.querySelectorAll<HTMLElement>('.w-max')[1];
    const tabEl = track.children[0] as HTMLElement;
    menuRow(openMenu({ ...h, track } as Harness, tabEl), 'Rename').click();
    const field = track.children[0].querySelector<HTMLInputElement>('[data-rename-input]')!;
    field.value = 'ar';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    // A dirty-state change re-renders the strip.
    tabs.setTabs(TABS.map((tab, i) => (i === 0 ? { ...tab, dirty: true } : tab)), TABS[0].absPath, TABS[0].absPath);
    const rebuilt = track.children[0].querySelector<HTMLInputElement>('[data-rename-input]')!;
    expect(rebuilt).not.toBe(field);
    expect(rebuilt.value).toBe('ar');
    expect(document.activeElement).toBe(rebuilt);
    // The torn-down field's blur must not commit.
    expect(h.handlers.onRename).not.toHaveBeenCalled();
  });

  it('the menu also closes the tab, and is absent without handlers', () => {
    const h = mount();
    menuRow(openMenu(h, h.tabEls()[1]), 'Close').click();
    expect(h.handlers.onClose).toHaveBeenCalledWith('/ws/rig.assembly.js');

    const bare = mount({ onRename: undefined, onClose: undefined });
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 20 });
    bare.tabEls()[0].dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(bare.container.querySelector('[role="menu"]')).toBeNull();
  });
});

describe('renamedBasename', () => {
  it('keeps a model suffix the field never showed', () => {
    expect(editableNameOf('bracket.part.js')).toBe('bracket');
    expect(renamedBasename('bracket.part.js', 'arm')).toBe('arm.part.js');
    expect(renamedBasename('rig.assembly.js', ' frame ')).toBe('frame.assembly.js');
    expect(renamedBasename('main.fluid.js', 'plate')).toBe('plate.fluid.js');
  });

  it('lets a typed model suffix change the kind', () => {
    expect(renamedBasename('bracket.part.js', 'bracket.assembly.js')).toBe('bracket.assembly.js');
    expect(renamedBasename('bracket.part.js', 'bracket.part.js')).toBeNull();
  });

  it('treats a helper name as the whole file name, defaulting the extension', () => {
    expect(editableNameOf('init.js')).toBe('init.js');
    expect(renamedBasename('init.js', 'helpers')).toBe('helpers.js');
    expect(renamedBasename('init.js', 'helpers.mjs')).toBe('helpers.mjs');
    expect(renamedBasename('init.js', 'init.js')).toBeNull();
  });

  it('rejects an empty or folder-only name', () => {
    expect(renamedBasename('init.js', '   ')).toBeNull();
    expect(renamedBasename('init.js', 'sub/')).toBeNull();
  });
});
