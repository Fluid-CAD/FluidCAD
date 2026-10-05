// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetMaterialDialog } from '../src/ui/set-material-dialog';
import type { EngineClient } from '../src/engine-client';
import type { Material } from '../src/api';
import type { SceneObjectRender } from '../src/types';

// The Set material dialog: a part row's pick over the merged list in two
// groups (built-ins, then the custom ones: the project's own and the user's
// global list), a filter, the current material checked, None to take the
// chain off, and Apply dispatching the acked set-part-material edit. A
// global entry is copied into the project by the server, not here.

const FILE = '/ws/bracket.part.js';
const loc = (line: number) => ({ filePath: FILE, line, column: 1 });

const MATERIALS: Material[] = [
  { id: 'fluidcad-steel', name: 'Steel', density: 7.87, densityUnit: 'g/cm³', source: 'builtin' },
  { id: 'fluidcad-pla', name: 'PLA', density: 1.24, densityUnit: 'g/cm³', source: 'builtin' },
  { id: 'alloy-steel', name: 'Alloy Steel', density: 7.7, densityUnit: 'g/cm³', source: 'project' },
  { id: 'acme-pla', name: 'ACME PLA+', density: 1.27, densityUnit: 'kg/m³', source: 'global' },
];

function part(id: string, line: number, material?: string): SceneObjectRender {
  return {
    id, name: `part-${id}`, type: 'part', isContainer: true, object: { name: `Bracket ${id}`, material },
    sceneShapes: [], ownShapes: [], visible: true, sourceLocation: loc(line),
  } as unknown as SceneObjectRender;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function mount(opts: { onManage?: () => void; editor?: boolean; materials?: () => Promise<Material[] | null> } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = { setPartMaterial: vi.fn(async () => ({ success: true })) };
  const client = {
    getMaterials: vi.fn(opts.materials ?? (async () => MATERIALS)),
    editor: opts.editor === false ? null : editor,
  } as unknown as EngineClient;
  const dialog = new SetMaterialDialog(container, client, { onManage: opts.onManage });
  const overlay = container.querySelector<HTMLElement>('[role="dialog"]')!;
  const rows = () => Array.from(overlay.querySelectorAll<HTMLButtonElement>('[role="option"]'));
  const labels = () => rows().map((r) => r.querySelector('span:nth-child(2)')!.textContent);
  const groups = () => Array.from(overlay.querySelectorAll<HTMLElement>('[data-ref="list"] > div:not([data-ref])')).map((g) => g.textContent);
  const checked = () => rows().filter((r) => r.querySelector('svg') !== null).map((r) => r.dataset.materialId);
  const selected = () => rows().filter((r) => r.getAttribute('aria-selected') === 'true').map((r) => r.dataset.materialId);
  const row = (id: string) => rows().find((r) => r.dataset.materialId === id)!;
  const apply = () => overlay.querySelector<HTMLButtonElement>('[data-ref="apply"]')!;
  const open = async (p: SceneObjectRender) => {
    dialog.open(p);
    await flush();
  };
  return { container, dialog, overlay, editor, client, rows, labels, groups, checked, selected, row, apply, open };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('SetMaterialDialog', () => {
  it('lists None, then the built-ins and the custom materials with the current one first in its group, and names the part in the subtitle', async () => {
    const h = mount();
    await h.open(part('A', 1, 'alloy-steel'));
    expect(h.overlay.classList.contains('hidden')).toBe(false);
    expect(h.overlay.querySelector('[data-ref="subtitle"]')!.textContent).toBe('Bracket A');
    expect(h.labels()).toEqual(['None', 'Steel', 'PLA', 'Alloy Steel', 'ACME PLA+']);
    expect(h.groups()).toEqual(['Built-in', 'Custom']);
    expect(h.checked()).toEqual(['alloy-steel']);
    expect(h.selected()).toEqual(['alloy-steel']);
    // A project entry says so; a global one carries no tag (it is copied on pick).
    expect(h.row('alloy-steel').textContent).toContain('in project');
    expect(h.row('acme-pla').textContent).not.toContain('in project');
    expect(h.row('acme-pla').textContent).toContain('1.27 kg/m³');
    // Nothing to apply until the pick changes.
    expect(h.apply().disabled).toBe(true);
  });

  it('applies a pick through the acked edit with the row\'s source location and closes', async () => {
    const h = mount();
    await h.open(part('A', 1, 'alloy-steel'));
    h.row('acme-pla').click();
    expect(h.selected()).toEqual(['acme-pla']);
    expect(h.checked()).toEqual(['alloy-steel']);
    expect(h.apply().disabled).toBe(false);
    h.apply().click();
    expect(h.editor.setPartMaterial).toHaveBeenCalledWith(loc(1), 'acme-pla');
    expect(h.overlay.classList.contains('hidden')).toBe(true);
  });

  it('None sends null; a part without a material has None checked; a double-click applies at once', async () => {
    const h = mount();
    await h.open(part('C', 20));
    expect(h.checked()).toEqual(['']);
    expect(h.apply().disabled).toBe(true);
    h.row('fluidcad-pla').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(h.editor.setPartMaterial).toHaveBeenCalledWith(loc(20), 'fluidcad-pla');

    await h.open(part('A', 1, 'fluidcad-steel'));
    h.row('').click();
    h.apply().click();
    expect(h.editor.setPartMaterial).toHaveBeenLastCalledWith(loc(1), null);
  });

  it('moves the current material to the top of its own group, listed once', async () => {
    const h = mount();
    await h.open(part('A', 1, 'fluidcad-pla'));
    expect(h.labels()).toEqual(['None', 'PLA', 'Steel', 'Alloy Steel', 'ACME PLA+']);
    expect(h.rows().filter((r) => r.dataset.materialId === 'fluidcad-pla')).toHaveLength(1);
    await h.open(part('A', 1, 'acme-pla'));
    expect(h.labels()).toEqual(['None', 'Steel', 'PLA', 'ACME PLA+', 'Alloy Steel']);
  });

  it('shows an unknown current id as a checked, unpickable row', async () => {
    const h = mount();
    await h.open(part('B', 10, 'unobtainium'));
    expect(h.labels()).toEqual(['None', 'Unknown material: unobtainium', 'Steel', 'PLA', 'Alloy Steel', 'ACME PLA+']);
    const unknown = h.row('unobtainium');
    expect(unknown.disabled).toBe(true);
    expect(h.checked()).toEqual(['unobtainium']);
  });

  it('filters by name or id, keeping None and the current material, and reports no match', async () => {
    const h = mount();
    await h.open(part('A', 1, 'fluidcad-steel'));
    const filter = h.overlay.querySelector<HTMLInputElement>('[data-ref="filter"]')!;
    filter.value = 'pla';
    filter.dispatchEvent(new Event('input'));
    expect(h.labels()).toEqual(['None', 'Steel', 'PLA', 'ACME PLA+']);
    filter.value = 'alloy';
    filter.dispatchEvent(new Event('input'));
    expect(h.labels()).toEqual(['None', 'Steel', 'Alloy Steel']);
    expect(h.groups()).toEqual(['Built-in', 'Custom']);
    filter.value = 'zzz';
    filter.dispatchEvent(new Event('input'));
    expect(h.labels()).toEqual(['None', 'Steel']);
    expect(h.groups()).toEqual(['Built-in']);
    expect(h.overlay.querySelector('[data-ref="empty"]')).toBeNull();
  });

  it('Escape and Cancel close without writing; Enter applies the selection', async () => {
    const h = mount();
    await h.open(part('A', 1, 'fluidcad-steel'));
    h.row('fluidcad-pla').click();
    h.overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(h.overlay.classList.contains('hidden')).toBe(true);
    expect(h.editor.setPartMaterial).not.toHaveBeenCalled();

    await h.open(part('A', 1, 'fluidcad-steel'));
    h.overlay.querySelector<HTMLButtonElement>('[data-ref="cancel"]')!.click();
    expect(h.overlay.classList.contains('hidden')).toBe(true);
    expect(h.editor.setPartMaterial).not.toHaveBeenCalled();

    await h.open(part('A', 1, 'fluidcad-steel'));
    h.row('fluidcad-pla').click();
    h.overlay.querySelector<HTMLInputElement>('[data-ref="filter"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.editor.setPartMaterial).toHaveBeenCalledWith(loc(1), 'fluidcad-pla');
  });

  it('says it is loading until the list arrives, never calling the current id unknown before then', async () => {
    let resolve!: (list: Material[] | null) => void;
    const h = mount({ materials: () => new Promise<Material[] | null>((r) => { resolve = r; }) });
    h.dialog.open(part('A', 1, 'fluidcad-pine'));
    await flush();
    expect(h.overlay.querySelector('[data-ref="loading"]')!.textContent).toBe('Loading materials…');
    expect(h.rows()).toEqual([]);
    expect(h.apply().disabled).toBe(true);
    // Enter while loading applies nothing.
    h.overlay.querySelector<HTMLInputElement>('[data-ref="filter"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.editor.setPartMaterial).not.toHaveBeenCalled();
    resolve([...MATERIALS, { id: 'fluidcad-pine', name: 'Wood (Pine)', density: 0.53, densityUnit: 'g/cm³', source: 'builtin' }]);
    await flush();
    expect(h.overlay.querySelector('[data-ref="loading"]')).toBeNull();
    expect(h.checked()).toEqual(['fluidcad-pine']);
    expect(h.labels()).not.toContain('Unknown material: fluidcad-pine');
  });

  it('reports a failed request with a Retry instead of an empty list, and retries', async () => {
    let answer: Material[] | null = null;
    const h = mount({ materials: async () => answer });
    await h.open(part('A', 1, 'fluidcad-steel'));
    const failed = h.overlay.querySelector<HTMLElement>('[data-ref="failed"]')!;
    expect(failed.textContent).toContain('Could not load the materials list.');
    expect(h.rows()).toEqual([]);
    expect(h.apply().disabled).toBe(true);
    answer = MATERIALS;
    h.overlay.querySelector<HTMLButtonElement>('[data-ref="retry"]')!.click();
    await flush();
    expect(h.client.getMaterials).toHaveBeenCalledTimes(2);
    expect(h.labels()).toEqual(['None', 'Steel', 'PLA', 'Alloy Steel', 'ACME PLA+']);
    expect(h.checked()).toEqual(['fluidcad-steel']);
  });

  it('re-reads the list on every open and offers Manage materials… only with a handler', async () => {
    const onManage = vi.fn();
    const h = mount({ onManage });
    await h.open(part('A', 1));
    await h.open(part('A', 1));
    expect(h.client.getMaterials).toHaveBeenCalledTimes(2);
    const manage = h.overlay.querySelector<HTMLButtonElement>('[data-ref="manage"]')!;
    expect(manage.classList.contains('hidden')).toBe(false);
    manage.click();
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(h.overlay.classList.contains('hidden')).toBe(true);

    const bare = mount();
    expect(bare.overlay.querySelector<HTMLButtonElement>('[data-ref="manage"]')!.classList.contains('hidden')).toBe(true);
  });
});
