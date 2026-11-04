// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GeneratedCatalogEntry, PackageRef } from '../src/api';
import { CustomFeaturesMenu } from '../src/interactive/create-feature/schema/custom-features-menu';
import { GeneratedDefinitionsMenu } from '../src/interactive/generated/generated-menu';
import { Navbar } from '../src/ui/navbar/navbar';

// The assembly bar's Generate Parts dropdown (generators S6): a group of its own in
// assembly mode only — generated definitions never on the part bar, the
// part bar's custom features never on the assembly bar — listing generated
// parts and assemblies grouped by package with the part bar's headings and
// pins, a cell opening its definition's dialog.

beforeAll(() => {
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
  (globalThis as any).cancelAnimationFrame ??= (id: number) => clearTimeout(id);
});

const menus: CustomFeaturesMenu[] = [];

afterEach(() => {
  for (const menu of menus.splice(0)) {
    menu.close();
  }
  document.body.innerHTML = '';
});

function entry(exportName: string, id: string, label: string, pkg?: PackageRef, kind: 'part' | 'assembly' = 'assembly'): GeneratedCatalogEntry {
  const file = pkg ? `/lib/${pkg.name}/${exportName}.js` : `/ws/${exportName}.assembly.js`;
  return {
    file, path: pkg ? `${pkg.name}/${exportName}.js` : `${exportName}.assembly.js`, exportName, kind, unit: 'mm',
    schema: { kind, definitionKind: 'generated', id, label, params: {}, layout: [], connectors: [], assetBase: { layout: 'definition' } },
    assetUrls: { definition: {}, class: {} },
    ...(pkg ? { package: pkg } : {}),
  };
}

const ACME: PackageRef = { name: '@acme/cabinets', version: '1.2.0', availability: 'dependency' };
const GEARS: PackageRef = { name: '@acme/gears', version: '0.3.0', availability: 'library' };

function mount(entries: GeneratedCatalogEntry[] = []) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const navbar = new Navbar(container);
  // The part bar's groups first, then the assembly bar's, as the page builds them.
  navbar.addGroup('create', { immune: true });
  const partMenu = new CustomFeaturesMenu(navbar);
  navbar.addGroup('assembly-insert', { mode: 'assembly' });
  const fetch = vi.fn(async () => entries);
  const generated = new GeneratedDefinitionsMenu(navbar, fetch);
  menus.push(partMenu, generated.menu);
  const wrap = container.querySelector<HTMLElement>('[data-tool="assembly-custom"]')!;
  const host = wrap.parentElement!;
  const panel = () => document.querySelector<HTMLElement>('[data-role="assembly-custom-menu"]');
  return { container, navbar, partMenu, generated, fetch, wrap, host, panel };
}

const hidden = (el: HTMLElement) => el.classList.contains('hidden');

describe('the assembly bar\'s Generate Parts dropdown', () => {
  it('reads "Generate Parts" on the assembly bar while the part bar\'s button keeps "Custom"', async () => {
    const { generated, wrap } = mount([entry('crate', 'crate', 'Crate')]);
    await generated.refresh();
    const button = wrap.querySelector('button')!;
    expect(button.textContent!.trim()).toBe('Generate Parts');
    expect(button.getAttribute('aria-label')).toBe('Generate parts and assemblies from installed packages');
    expect(wrap.dataset.tip).toBe('Generate parts and assemblies from installed packages');
    const partButton = document.querySelector<HTMLElement>('[data-tool="custom-features"] button')!;
    expect(partButton.textContent!.trim()).toBe('Custom');
  });

  it('shows in assembly mode only, beside the assembly tools, and never on the part bar', async () => {
    const { navbar, generated, host, partMenu } = mount([entry('crate', 'crate', 'Crate')]);
    await generated.refresh();
    expect(hidden(host)).toBe(true);
    navbar.setMode('assembly');
    expect(hidden(host)).toBe(false);
    partMenu.add({ id: 'standoff', label: 'Standoff', iconSrc: '', tip: 'Standoff', group: 'create' });
    const partHost = document.querySelector<HTMLElement>('[data-tool="custom-features"]')!.parentElement!;
    expect(hidden(partHost)).toBe(true);
    navbar.setMode('part');
    expect(hidden(host)).toBe(true);
    expect(hidden(partHost)).toBe(false);
    // The part bar's dropdown lists features, never a generated definition.
    expect(partMenu.entries.map(cell => cell.spec.label)).toEqual(['Standoff']);
  });

  it('lists generated parts and assemblies by package: the project\'s first, then each package with its pin', async () => {
    const { navbar, generated, wrap, panel } = mount([
      entry('rack', 'rack', 'Rack', GEARS, 'part'),
      entry('wardrobe', '@acme/cabinets:wardrobe-unit', 'Wardrobe', ACME),
      entry('crate', 'crate', 'Crate'),
      entry('chest', '@acme/cabinets:chest-unit', 'Chest', ACME),
    ]);
    navbar.setMode('assembly');
    await generated.refresh();
    wrap.querySelector('button')!.click();
    const headings = [...panel()!.querySelectorAll<HTMLElement>('[data-group-heading]')].map(h => h.dataset.groupHeading);
    expect(headings).toEqual(['workspace', '@acme/cabinets', '@acme/gears']);
    const grids = [...panel()!.querySelectorAll<HTMLElement>('[data-group]')].map(grid =>
      [grid.dataset.group, [...grid.querySelectorAll('button')].map(b => b.textContent)]);
    expect(grids).toEqual([
      ['workspace', ['Crate']],
      ['@acme/cabinets', ['Chest', 'Wardrobe']],
      ['@acme/gears', ['Rack']],
    ]);
    expect(panel()!.querySelectorAll('[data-ref="pin"]')).toHaveLength(2);
    expect(panel()!.querySelector('[data-tool="generated:crate"]')).not.toBeNull();
  });

  it('opens a definition\'s dialog from its cell, armed while it is open', async () => {
    const { navbar, generated, wrap, panel } = mount([entry('crate', 'crate', 'Crate')]);
    navbar.setMode('assembly');
    await generated.refresh();
    const opened = vi.fn();
    generated.onOpen = opened;
    wrap.querySelector('button')!.click();
    panel()!.querySelector<HTMLButtonElement>('[data-tool="generated:crate"] button')!.click();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls[0][0].id).toBe('crate');
    expect(panel()).toBeNull();
    generated.setActive(opened.mock.calls[0][0]);
    expect(generated.menu.isActive).toBe(true);
    generated.setActive(null);
    expect(generated.menu.isActive).toBe(false);
  });

  it('refreshes on open, keeping the cells whose entry didn\'t change', async () => {
    const entries = [entry('crate', 'crate', 'Crate')];
    const { navbar, generated, wrap, fetch } = mount(entries);
    navbar.setMode('assembly');
    await generated.ensureLoaded();
    await generated.ensureLoaded();
    expect(fetch).toHaveBeenCalledTimes(1);
    const cell = generated.menu.entries[0];
    entries.push(entry('chest', 'chest', 'Chest'));
    wrap.querySelector('button')!.click();
    await vi.waitFor(() => expect(generated.menu.entries).toHaveLength(2));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(generated.menu.entries).toContain(cell);
  });

  it('says nothing is installed only once a list has arrived', async () => {
    const { navbar, generated, host } = mount([]);
    navbar.setMode('assembly');
    generated.setEmptyAction(() => {});
    expect(hidden(host)).toBe(true);
    await generated.refresh();
    expect(hidden(host)).toBe(false);
  });

  it('finds the definition that made a record: the project\'s own before a package\'s, fetched again when missing', async () => {
    const entries = [entry('gear', 'gear', 'Library gear', GEARS), entry('mygear', 'gear', 'My gear')];
    const { generated, fetch } = mount(entries);
    expect((await generated.find('gear'))?.label).toBe('My gear');
    expect(await generated.find('rack')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('pins a package onto the assembly bar, ahead of its Custom button, in a group of the assembly bench', async () => {
    const { navbar, generated, host } = mount([entry('wardrobe', 'wardrobe', 'Wardrobe', ACME)]);
    navbar.setMode('assembly');
    await generated.refresh();
    const changed = vi.fn();
    generated.menu.onToolbarPackagesChange = changed;
    generated.menu.pin('@acme/cabinets');
    expect(changed).toHaveBeenCalledWith(['@acme/cabinets']);
    const pinned = host.previousElementSibling?.previousElementSibling as HTMLElement;
    expect(pinned.dataset.package).toBe('@acme/cabinets');
    expect(hidden(pinned)).toBe(false);
    navbar.setMode('part');
    expect(hidden(pinned)).toBe(true);
  });
});
