// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CustomFeaturesMenu, type CustomFeatureCellSpec } from '../src/interactive/create-feature/schema/custom-features-menu';
import { FinishSketchButton } from '../src/interactive/create-feature/finish-sketch-button';
import { Navbar } from '../src/ui/navbar/navbar';
import { viewportChrome } from '../src/ui/viewport-chrome';

// The toolbar's Custom button and its dropdown on their own: where the
// group sits, the grid's order, what opens and closes it, the armed look,
// the sketch swap, cells coming and going under an open dropdown, and the
// dropdown staying on screen. The catalog's use of it (which entries go in,
// a cell opening its dialog) is in schema-feature-service.test.ts.

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
const mounted: CustomFeaturesMenu[] = [];

afterEach(() => {
  for (const menu of mounted.splice(0)) {
    menu.close();
  }
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const navbar = new Navbar(container);
  // The page's tool groups, in the order the page builds them, before the menu.
  const groups = {
    create: navbar.addGroup('create', { immune: true }),
    modify: navbar.addGroup('modify'),
    repeat: navbar.addGroup('repeat'),
    connector: navbar.addGroup('connector', { mode: 'all' }),
  };
  const menu = new CustomFeaturesMenu(navbar);
  mounted.push(menu);
  const wrap = container.querySelector<HTMLElement>('[data-tool="custom-features"]')!;
  const button = wrap.querySelector('button')!;
  const host = wrap.parentElement!;
  const panel = () => document.querySelector<HTMLElement>('[data-role="custom-features-menu"]');
  const cellButton = (id: string) => panel()!.querySelector<HTMLButtonElement>(`[data-tool="feature:${id}"] button`)!;
  return { container, navbar, groups, menu, wrap, button, host, panel, cellButton };
}

const spec = (id: string, label: string, extra: Partial<CustomFeatureCellSpec> = {}): CustomFeatureCellSpec => ({
  id, label, iconSrc: `api/features/asset?id=${id}`, tip: label, group: 'create', ...extra,
});

const hidden = (el: HTMLElement) => el.classList.contains('hidden');
const press = (target: EventTarget) => target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
const escape = (target: EventTarget = document.body) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

describe('the Custom features button', () => {
  it('sits last on the bar in a group of its own, shown only while it lists a feature', () => {
    const { groups, host, menu } = mount();
    const track = [...groups.create.parentElement!.children];
    expect(track.indexOf(host)).toBe(track.indexOf(groups.connector) + 2);
    expect(track.at(-1)).toBe(host);
    expect(hidden(host)).toBe(true);

    const standoff = menu.add(spec('acme.standoff', 'Standoff'));
    expect(hidden(host)).toBe(false);
    expect(menu.isVisible).toBe(true);
    standoff.remove();
    expect(hidden(host)).toBe(true);
    expect(menu.isVisible).toBe(false);
  });

  it('says what it is on hover, and opens a dropdown below it', () => {
    const { wrap, button, menu, panel } = mount();
    menu.add(spec('acme.standoff', 'Standoff'));
    expect(wrap.dataset.tip).toBe('Custom features');
    expect(button.getAttribute('aria-label')).toBe('Custom features');
    expect(button.textContent!.trim()).toBe('Custom');
    expect(panel()).toBeNull();

    button.click();
    expect(menu.isOpen).toBe(true);
    expect(panel()).not.toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    // The hover tooltip would sit on the dropdown.
    expect(wrap.classList.contains('tooltip')).toBe(false);

    button.click();
    expect(menu.isOpen).toBe(false);
    expect(panel()).toBeNull();
    expect(wrap.classList.contains('tooltip')).toBe(true);
  });

  it('lists create-group features first, then modify, each by label, in three columns', () => {
    const { button, menu, panel } = mount();
    menu.add(spec('acme.taper', 'Taper', { group: 'modify' }));
    menu.add(spec('acme.standoff', 'Standoff'));
    menu.add(spec('acme.chamferAll', 'Chamfer all', { group: 'modify' }));
    menu.add(spec('acme.boltCircle', 'Bolt circle'));
    menu.add(spec('acme.boss', 'Boss'));
    expect(menu.entries.map(c => c.spec.label)).toEqual(['Bolt circle', 'Boss', 'Standoff', 'Chamfer all', 'Taper']);

    button.click();
    const grid = panel()!.firstElementChild as HTMLElement;
    expect(grid.className).toContain('grid-cols-[repeat(3,');
    expect([...grid.children].map(cell => cell.textContent)).toEqual(['Bolt circle', 'Boss', 'Standoff', 'Chamfer all', 'Taper']);
    // Each cell: the feature's icon over its label, the label truncating with the whole of it on hover.
    const cell = grid.children[0] as HTMLElement;
    expect(cell.dataset.tool).toBe('feature:acme.boltCircle');
    expect(cell.title).toBe('Bolt circle');
    expect(cell.querySelector('img')!.getAttribute('src')).toBe('api/features/asset?id=acme.boltCircle');
    expect(cell.querySelector('img')!.getAttribute('onerror')).toContain('icons/solid.png');
    expect(cell.querySelector('span')!.className).toContain('truncate');
  });

  it("opens a cell's feature and closes", () => {
    const { button, menu, cellButton } = mount();
    const standoff = menu.add(spec('acme.standoff', 'Standoff'));
    const boss = menu.add(spec('acme.boss', 'Boss'));
    standoff.onClick = vi.fn();
    boss.onClick = vi.fn();
    button.click();
    cellButton('acme.boss').click();
    expect(boss.onClick).toHaveBeenCalledOnce();
    expect(standoff.onClick).not.toHaveBeenCalled();
    expect(menu.isOpen).toBe(false);
  });

  it('closes on Escape, which goes no further — a dialog under it stays open', () => {
    const { button, menu } = mount();
    menu.add(spec('acme.standoff', 'Standoff'));
    const dialogEscape = vi.fn();
    document.addEventListener('keydown', dialogEscape);
    button.click();
    escape();
    expect(menu.isOpen).toBe(false);
    expect(dialogEscape).not.toHaveBeenCalled();
    // Closed, Escape is the dialog's again.
    escape();
    expect(dialogEscape).toHaveBeenCalledOnce();
    document.removeEventListener('keydown', dialogEscape);
  });

  it('closes on a press or a wheel anywhere but the dropdown', () => {
    const { button, menu, panel, cellButton } = mount();
    menu.add(spec('acme.standoff', 'Standoff'));
    button.click();
    press(cellButton('acme.standoff'));
    panel()!.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    expect(menu.isOpen).toBe(true);
    press(document.body);
    expect(menu.isOpen).toBe(false);

    button.click();
    document.body.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    expect(menu.isOpen).toBe(false);
  });

  it('closes when a dialog opens — not when one closes', () => {
    const { button, menu } = mount();
    menu.add(spec('acme.standoff', 'Standoff'));
    viewportChrome.setDialogOpen('fluidcad-test-open', true);
    button.click();
    viewportChrome.setDialogOpen('fluidcad-test-open', false);
    expect(menu.isOpen).toBe(true);
    viewportChrome.setDialogOpen('fluidcad-test-other', true);
    expect(menu.isOpen).toBe(false);
    viewportChrome.setDialogOpen('fluidcad-test-other', false);
  });

  it("reads as armed while one of its features' dialogs is open", () => {
    const { button, menu } = mount();
    const standoff = menu.add(spec('acme.standoff', 'Standoff'));
    const boss = menu.add(spec('acme.boss', 'Boss'));
    expect(button.className).toContain('btn-ghost');
    standoff.setActive(true);
    expect(menu.isActive).toBe(true);
    expect(button.className).toContain('btn-primary');
    // Handing over from one feature's dialog to another's stays armed.
    boss.setActive(true);
    standoff.setActive(false);
    expect(button.className).toContain('btn-primary');
    boss.setActive(false);
    expect(menu.isActive).toBe(false);
    expect(button.className).toContain('btn-ghost');
    // An armed feature that leaves the catalog takes the armed look with it.
    boss.setActive(true);
    boss.remove();
    expect(button.className).toContain('btn-ghost');
  });

  it('leaves the bar with the create buttons while a sketch is up, closing the dropdown', () => {
    const { groups, host, button, menu } = mount();
    menu.add(spec('acme.standoff', 'Standoff'));
    const finish = new FinishSketchButton(groups.create, () => [menu]);
    button.click();
    finish.setVisible(true);
    expect(hidden(host)).toBe(true);
    expect(menu.isOpen).toBe(false);
    menu.open();
    expect(menu.isOpen).toBe(false);
    // A feature arriving mid-sketch stays off the bar.
    menu.add(spec('acme.boss', 'Boss'));
    expect(hidden(host)).toBe(true);
    finish.setVisible(false);
    expect(hidden(host)).toBe(false);
  });

  it('keeps an open dropdown in step as cells come, go and change', () => {
    const { host, button, menu, panel } = mount();
    const standoff = menu.add(spec('acme.standoff', 'Standoff'));
    const boss = menu.add(spec('acme.boss', 'Boss'));
    button.click();
    const labels = () => [...panel()!.firstElementChild!.children].map(cell => cell.textContent);

    menu.add(spec('acme.boltCircle', 'Bolt circle'));
    expect(labels()).toEqual(['Bolt circle', 'Boss', 'Standoff']);
    // A changed feature is a new cell where the old one was taken out.
    standoff.remove();
    menu.add(spec('acme.standoff', 'Anchor post'));
    expect(labels()).toEqual(['Anchor post', 'Bolt circle', 'Boss']);
    boss.remove();
    expect(labels()).toEqual(['Anchor post', 'Bolt circle']);
    expect(menu.isOpen).toBe(true);

    for (const cell of menu.entries) {
      cell.remove();
    }
    expect(menu.isOpen).toBe(false);
    expect(hidden(host)).toBe(true);
    // Removing twice is harmless.
    boss.remove();
    expect(menu.entries).toEqual([]);
  });

  it('greys an entry it can not offer, its tooltip saying why', () => {
    const { button, menu, cellButton } = mount();
    const broken = menu.add(spec('acme.standoff', 'Standoff', {
      tip: "Standoff can't be offered: the feature id 'acme.standoff' is used by more than one builder",
      disabled: true,
    }));
    broken.onClick = vi.fn();
    button.click();
    const cell = cellButton('acme.standoff');
    expect(cell.disabled).toBe(true);
    expect(cell.className).toContain('pointer-events-none');
    expect(cell.parentElement!.title).toBe("Standoff can't be offered: the feature id 'acme.standoff' is used by more than one builder");
    cell.click();
    expect(broken.onClick).not.toHaveBeenCalled();
    // An entry with no id still lists.
    menu.add(spec(null as unknown as string, 'bolt-boss', { tip: "bolt-boss can't be offered: boom", disabled: true, id: null }));
    expect(menu.entries.map(c => c.spec.label)).toEqual(['bolt-boss', 'Standoff']);
  });

  it('hangs centred under the button and stays on screen at narrow widths', () => {
    const { button, menu, panel } = mount();
    menu.add(spec('acme.standoff', 'Standoff'));
    // A fixed box shrinks to fit the room right of where it stands, as a browser lays it out.
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return Math.max(0, Math.min(270, window.innerWidth - (parseFloat(this.style.left) || 0)));
    });
    const at = (left: number) => vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(
      { left, right: left + 40, width: 40, top: 54, bottom: 104, height: 50, x: left, y: 54, toJSON: () => ({}) },
    );
    const windowWidth = (width: number) => Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
    const original = window.innerWidth;
    try {
      windowWidth(1024);
      at(300);
      button.click();
      expect(panel()!.style.left).toBe(`${300 + 20 - 135}px`);
      expect(panel()!.style.top).toBe('110px');
      menu.close();

      // Near the right edge of a narrow window: pulled in, whole, to keep its right edge on screen.
      windowWidth(320);
      at(250);
      button.click();
      expect(panel()!.style.left).toBe(`${320 - 270 - 8}px`);
      // The window narrowing under an open dropdown that stood further right: measured whole again.
      menu.close();
      windowWidth(1024);
      at(900);
      button.click();
      windowWidth(320);
      at(250);
      window.dispatchEvent(new Event('resize'));
      expect(panel()!.style.left).toBe(`${320 - 270 - 8}px`);
      // The window widening moves it back under the button.
      windowWidth(1024);
      window.dispatchEvent(new Event('resize'));
      expect(panel()!.style.left).toBe(`${250 + 20 - 135}px`);
      menu.close();

      // Near the left edge (the bar scrolled): pulled in from the left.
      at(0);
      button.click();
      expect(panel()!.style.left).toBe('8px');
      expect(panel()!.className).toContain('max-w-[calc(100vw-16px)]');
    } finally {
      windowWidth(original);
    }
  });
});

describe('features from packages', () => {
  it('lists the workspace first, then each package under its own heading, a library one marked', () => {
    const h = mount();
    h.menu.add(spec('acme.boss', 'Boss', { package: { name: '@acme/kit', version: '0.1.0', availability: 'dependency' } }));
    h.menu.add(spec('ws.taper', 'Taper'));
    h.menu.add(spec('beta.gear', 'Gear', { package: { name: '@beta/gears', version: '2.0.0', availability: 'library' } }));
    h.menu.add(spec('ws.bracket', 'Bracket'));
    h.button.click();
    const panel = h.panel()!;
    const groups = [...panel.querySelectorAll<HTMLElement>('[data-group]')];
    expect(groups.map(g => g.dataset.group)).toEqual(['workspace', '@acme/kit', '@beta/gears']);
    expect(groups.map(g => [...g.children].map(c => c.textContent))).toEqual([['Bracket', 'Taper'], ['Boss'], ['Gear']]);
    expect(groups.every(g => g.className.includes('grid-cols-[repeat(3,'))).toBe(true);
    const headings = [...panel.querySelectorAll<HTMLElement>('[data-group-heading]')];
    expect(headings.map(x => x.textContent)).toEqual(['This project', '@acme/kit0.1.0', '@beta/gears2.0.0not in this project']);
    expect(panel.querySelectorAll('[data-ref="not-in-project"]')).toHaveLength(1);
  });

  it('keeps the plain grid, with no headings, while no package is listed', () => {
    const h = mount();
    h.menu.add(spec('ws.taper', 'Taper'));
    h.button.click();
    expect(h.panel()!.querySelector('[data-group-heading]')).toBeNull();
    expect(h.panel()!.firstElementChild!.className).toContain('grid-cols-[repeat(3,');
  });

  it('moves a cell to its package\'s group when its package changes under an open dropdown', () => {
    const h = mount();
    h.menu.add(spec('ws.taper', 'Taper'));
    const boss = h.menu.add(spec('acme.boss', 'Boss', { package: { name: '@acme/kit', version: '0.1.0', availability: 'library' } }));
    h.button.click();
    expect(h.panel()!.querySelector('[data-ref="not-in-project"]')).not.toBeNull();
    boss.setPackage({ name: '@acme/kit', version: '0.1.0', availability: 'dependency' });
    expect(h.panel()!.querySelector('[data-ref="not-in-project"]')).toBeNull();
    expect(boss.el.title).toBe('Boss\nFrom @acme/kit 0.1.0.');
    expect(h.cellButton('acme.boss')).not.toBeNull();
  });
});

describe('the Custom button with no custom features (H11)', () => {
  it('stays on the bar, says none are installed, and opens the Hub panel from its button', () => {
    const { host, menu, button, panel } = mount();
    const openHub = vi.fn();
    menu.setEmptyAction(openHub);
    expect(hidden(host)).toBe(false);
    expect(menu.isVisible).toBe(true);
    button.click();
    expect(panel()!.querySelector('[data-ref="empty"]')!.textContent).toContain('No custom features installed. Check FluidCAD Hub');
    panel()!.querySelector<HTMLButtonElement>('[data-ref="open-hub"]')!.click();
    expect(openHub).toHaveBeenCalledTimes(1);
    expect(menu.isOpen).toBe(false);
  });

  it('still leaves the bar during a sketch, and lists features again once one arrives', () => {
    const { host, menu, button, panel } = mount();
    menu.setEmptyAction(() => undefined);
    menu.setSketchHidden(true);
    expect(hidden(host)).toBe(true);
    menu.setSketchHidden(false);
    expect(hidden(host)).toBe(false);
    menu.add(spec('acme.standoff', 'Standoff'));
    button.click();
    expect(panel()!.querySelector('[data-ref="empty"]')).toBeNull();
    expect(panel()!.querySelector('[data-tool="feature:acme.standoff"]')).not.toBeNull();
  });
});
