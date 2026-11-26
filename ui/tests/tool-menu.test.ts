// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ToolMenu, type ToolMenuCellSpec } from '../src/interactive/create-feature/tool-menu';
import { Navbar } from '../src/ui/navbar/navbar';
import { toolIndex } from '../src/ui/quick-find/tool-index';
import { viewportChrome } from '../src/ui/viewport-chrome';
import { TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_BASE } from '../src/ui/toolbar-styles';

// A toolbar dropdown of built-in tools (Curves, Surfaces) on its own: where
// its group sits, the grid's order, what opens and closes it, the armed and
// greyed looks, the sketch swap, the empty state, and Quick Find's view of
// its cells. The Helix cell's dialog is in helix-menu.test.ts.

beforeAll(() => {
  // jsdom has no ResizeObserver/rAF; the scroller only measures with them.
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
  (globalThis as any).cancelAnimationFrame ??= (id: number) => clearTimeout(id);
});

/** Every menu a test mounts — closed afterwards, so no dropdown's document listeners outlive its test. */
const mounted: ToolMenu[] = [];

afterEach(() => {
  for (const menu of mounted.splice(0)) {
    menu.close();
  }
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/** The menu a test builds: `curves` by default, its Quick Find bench the label. */
function menuOn(navbar: Navbar, tool = 'curves', label = 'Curves') {
  const menu = new ToolMenu(navbar, {
    group: tool,
    before: 'modify',
    label,
    icon: tool,
    tip: `${label} tools`,
    tool,
    bench: label,
    quickFindPrefix: 'part',
    emptyText: 'No tools yet',
  });
  mounted.push(menu);
  return menu;
}

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const navbar = new Navbar(container);
  // The page's tool groups that are there when the menus are built.
  const groups = {
    create: navbar.addGroup('create', { immune: true }),
    sketch: navbar.addGroup('sketch', { exclusive: true, visible: false }),
    modify: navbar.addGroup('modify'),
    repeat: navbar.addGroup('repeat'),
  };
  const menu = menuOn(navbar);
  const wrap = container.querySelector<HTMLElement>('[data-tool="curves"]')!;
  const button = wrap.querySelector('button')!;
  const host = wrap.parentElement!;
  const panel = () => document.querySelector<HTMLElement>('[data-role="curves-menu"]');
  const cellButton = (id: string) => panel()!.querySelector<HTMLButtonElement>(`[data-tool="${id}"] button`)!;
  return { container, navbar, groups, menu, wrap, button, host, panel, cellButton };
}

const spec = (id: string, label: string, extra: Partial<ToolMenuCellSpec> = {}): ToolMenuCellSpec => ({
  id, label, iconSrc: `icons/${id}.png`, tip: `${label} tip`, ...extra,
});

const hidden = (el: HTMLElement) => el.classList.contains('hidden');
const press = (target: EventTarget) => target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
const escape = (target: EventTarget = document.body) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

describe('a tool menu', () => {
  it('sits ahead of the modify group in a group of its own, a second one after it', () => {
    const { navbar, groups, host } = mount();
    const surfaces = menuOn(navbar, 'surfaces', 'Surfaces');
    const surfacesHost = document.querySelector<HTMLElement>('[data-tool="surfaces"]')!.parentElement!;
    const track = [...groups.create.parentElement!.children];
    // Each host follows its divider: create, curves, surfaces, then modify.
    expect(track.indexOf(host)).toBeGreaterThan(track.indexOf(groups.create));
    expect(track.indexOf(surfacesHost)).toBe(track.indexOf(host) + 2);
    expect(track.indexOf(groups.modify)).toBeGreaterThan(track.indexOf(surfacesHost));
    expect(surfaces.isVisible).toBe(true);
  });

  it('stays on the bar with nothing listed, its dropdown saying so', () => {
    const { menu, host, button, panel } = mount();
    expect(hidden(host)).toBe(false);
    expect(menu.isVisible).toBe(true);
    button.click();
    expect(menu.isOpen).toBe(true);
    expect(panel()!.querySelector('[data-ref="empty"]')!.textContent).toBe('No tools yet');
    expect(panel()!.querySelector('button')).toBeNull();
  });

  it('lists its cells by order, cells without one after them in the order they came', () => {
    const { menu, button, panel } = mount();
    menu.add(spec('projected-curve', 'Project', { order: 20 }));
    menu.add(spec('composite', 'Composite'));
    menu.add(spec('helix', 'Helix', { order: 0 }));
    menu.add(spec('curve', 'Curve'));
    menu.add(spec('intersection-curve', 'Intersect', { order: 10 }));
    expect(menu.entries.map(c => c.spec.label)).toEqual(['Helix', 'Intersect', 'Project', 'Composite', 'Curve']);
    button.click();
    const tools = [...panel()!.querySelectorAll<HTMLElement>('[data-tool]')].map(el => el.dataset.tool);
    expect(tools).toEqual(['helix', 'intersection-curve', 'projected-curve', 'composite', 'curve']);
    expect(panel()!.querySelector('[data-ref="empty"]')).toBeNull();
  });

  it('runs the launcher on a cell click and closes', () => {
    const { menu, button, cellButton } = mount();
    const cell = menu.add(spec('helix', 'Helix', { order: 0 }));
    const onClick = vi.fn();
    cell.onClick = onClick;
    button.click();
    cellButton('helix').click();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(menu.isOpen).toBe(false);
  });

  it('closes on Escape and on a press outside, not on a press inside', () => {
    const { menu, button, panel } = mount();
    menu.add(spec('helix', 'Helix'));
    button.click();
    press(panel()!);
    expect(menu.isOpen).toBe(true);
    escape();
    expect(menu.isOpen).toBe(false);
    expect(panel()).toBeNull();

    button.click();
    press(document.body);
    expect(menu.isOpen).toBe(false);
    button.click();
    button.click();
    expect(menu.isOpen).toBe(false);
  });

  it('closes when a dialog opens', () => {
    const { menu, button } = mount();
    menu.add(spec('helix', 'Helix'));
    button.click();
    viewportChrome.setDialogOpen('tool-menu-test', true);
    expect(menu.isOpen).toBe(false);
    viewportChrome.setDialogOpen('tool-menu-test', false);
  });

  it('leaves the bar while a sketch is up, closing its dropdown, and comes back', () => {
    const { menu, host, button } = mount();
    menu.add(spec('helix', 'Helix'));
    button.click();
    menu.setSketchHidden(true);
    expect(hidden(host)).toBe(true);
    expect(menu.isOpen).toBe(false);
    button.click();
    expect(menu.isOpen).toBe(false);
    menu.setSketchHidden(false);
    expect(hidden(host)).toBe(false);
  });

  it('looks armed while one of its tools is active', () => {
    const { menu, button, cellButton } = mount();
    const helix = menu.add(spec('helix', 'Helix'));
    menu.add(spec('curve', 'Curve'));
    expect(button.className).toBe(TOOLBAR_BTN_BASE);
    helix.setActive(true);
    expect(button.className).toBe(TOOLBAR_BTN_ACTIVE);
    expect(menu.isActive).toBe(true);
    button.click();
    expect(cellButton('helix').className).toContain('btn-primary');
    expect(cellButton('curve').className).not.toContain('btn-primary');
    helix.setActive(false);
    expect(button.className).toBe(TOOLBAR_BTN_BASE);
  });

  it('greys a cell its dialog disables, and takes a removed cell out', () => {
    const { menu, button, cellButton, panel } = mount();
    const helix = menu.add(spec('helix', 'Helix', { description: 'Build a helix' }));
    button.click();
    expect(cellButton('helix').disabled).toBe(false);
    expect(cellButton('helix').closest<HTMLElement>('[data-tool]')!.title).toBe('Build a helix');
    helix.setDisabled(true);
    expect(cellButton('helix').disabled).toBe(true);
    expect(helix.disabled).toBe(true);
    helix.setDisabled(false);
    expect(cellButton('helix').disabled).toBe(false);

    helix.remove();
    expect(menu.entries).toEqual([]);
    expect(panel()!.querySelector('[data-ref="empty"]')).not.toBeNull();
    expect(toolIndex.get('part:helix')).toBeNull();
  });

  it('lists each cell in Quick Find under its bench as part:<id>, shown while the menu is closed', () => {
    const { menu } = mount();
    const cell = menu.add(spec('intersection-curve', 'Intersect', { description: 'Curve where two surfaces meet' }));
    const onClick = vi.fn();
    cell.onClick = onClick;
    const entry = toolIndex.get('part:intersection-curve')!;
    expect(entry).not.toBeNull();
    expect(entry.bench).toBe('Curves');
    expect(entry.label).toBe('Intersect');
    expect(entry.tip).toBe('Curve where two surfaces meet');
    expect(entry.iconSrc).toBe('icons/intersection-curve.png');
    expect(menu.isOpen).toBe(false);
    expect(entry.isAvailable()).toBe(true);
    expect(entry.isDisabled!()).toBe(false);

    cell.setDisabled(true);
    expect(entry.isDisabled!()).toBe(true);
    cell.setDisabled(false);
    cell.setActive(true);
    expect(entry.isActive!()).toBe(true);
    cell.setActive(false);

    menu.setSketchHidden(true);
    expect(entry.isAvailable()).toBe(false);
    menu.setSketchHidden(false);

    entry.run();
    expect(onClick).toHaveBeenCalledTimes(1);
    cell.remove();
    expect(toolIndex.get('part:intersection-curve')).toBeNull();
  });

  it('is off the bar in assembly mode, its tools with it', () => {
    const { navbar, menu, host } = mount();
    menu.add(spec('intersection-curve', 'Intersect'));
    navbar.setMode('assembly');
    expect(hidden(host)).toBe(true);
    expect(toolIndex.get('part:intersection-curve')!.isAvailable()).toBe(false);
    navbar.setMode('part');
    expect(hidden(host)).toBe(false);
  });
});
