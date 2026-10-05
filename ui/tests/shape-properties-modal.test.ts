// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShapePropertiesModal } from '../src/ui/shape-properties-modal';
import { globalMaterials } from '../src/ui/settings/global-materials';
import type { EngineClient } from '../src/engine-client';
import type { Material, PartProperties, ShapeProperties } from '../src/api';
import type { SceneObjectRender, SourceLocation } from '../src/types';

// Shape Properties, Part | Solid (part-materials stage 2). Solid mode keeps
// today's panel except that density is never typed: a solid inside a part
// with a `.material()` shows that material and its density read-only, a
// solid outside any part picks from the merged list. Part mode is read-only
// throughout and sums the part's final solids through the server.

const FILE = '/ws/bracket.part.js';

const MATERIALS: Material[] = [
  { id: 'fluidcad-steel', name: 'Steel', density: 7.87, densityUnit: 'g/cm³', source: 'builtin' },
  { id: 'fluidcad-aluminum', name: 'Aluminum', density: 2.7, densityUnit: 'g/cm³', source: 'builtin' },
  { id: 'alloy-steel', name: 'Alloy Steel', density: 0.0077, densityUnit: 'g/mm³', source: 'project' },
];

const loc = (line: number): SourceLocation => ({ filePath: FILE, line, column: 1 });

function part(id: string, line: number, material?: string): SceneObjectRender {
  return {
    id, name: `part-${id}`, type: 'part', isContainer: true,
    object: { name: `part-${id}`, material },
    sceneShapes: [], ownShapes: [], visible: true, sourceLocation: loc(line),
  } as unknown as SceneObjectRender;
}

function solid(id: string, line: number, shapeId: string, parentId?: string): SceneObjectRender {
  return {
    id, name: 'extrude', type: 'extrude', parentId, visible: true,
    sceneShapes: [{ shapeId, shapeType: 'solid', meshes: [] }], ownShapes: [],
    sourceLocation: loc(line),
  } as unknown as SceneObjectRender;
}

/** Part A (steel) with one solid, part B (unknown material) with two, part C (no material), a top-level solid. */
const SCENE: SceneObjectRender[] = [
  part('A', 1, 'fluidcad-steel'), solid('a1', 2, 'sA1', 'A'),
  part('B', 10, 'unobtainium'), solid('b1', 11, 'sB1', 'B'), solid('b2', 12, 'sB2', 'B'),
  part('C', 20), solid('c1', 21, 'sC1', 'C'),
  solid('top', 30, 'sTop'),
];

const SHAPE_PROPS: ShapeProperties = { volumeMm3: 1000, surfaceAreaMm2: 600, centroid: { x: 5, y: 5, z: 5 }, unit: 'mm' };

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function mount(opts: { partProps?: (partId: string) => PartProperties | null; noPartProps?: boolean } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const getPartProperties = vi.fn(async (partId: string) => opts.partProps ? opts.partProps(partId) : null);
  const client = {
    getMaterials: vi.fn(async () => MATERIALS),
    getShapeProperties: vi.fn(async () => SHAPE_PROPS),
    ...(opts.noPartProps ? {} : { getPartProperties }),
    editor: null,
  } as unknown as EngineClient;
  const modal = new ShapePropertiesModal(container, client);
  modal.setSceneProvider(() => SCENE);
  let tracked: SourceLocation | null = null;
  modal.setSelectedPartProvider(() => tracked);
  const partSelections: (string | null)[] = [];
  modal.setPartSelectionHandler((row) => partSelections.push(row?.id ?? null));
  container.querySelector<HTMLButtonElement>('button[title="Shape Properties"]')!.click();

  const q = <T extends HTMLElement>(sel: string) => container.querySelector<T>(sel);
  const tab = (label: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('[data-ref="mode"] button')).find((b) => b.textContent === label)!;
  const text = (ref: string) => q(`[data-ref="${ref}"]`)!.textContent;
  const hidden = (ref: string) => q(`[data-ref="${ref}"]`)!.classList.contains('hidden');
  return {
    container, client, modal, getPartProperties, partSelections, q, tab, text, hidden,
    track: (l: SourceLocation | null) => { tracked = l; },
    calculate: async () => { q<HTMLButtonElement>('[data-action="calculate"]')!.click(); await flush(); },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  globalMaterials.update({});
});

describe('shape properties — Part | Solid tabs', () => {
  it('opens on Solid and switches the form with the tab', async () => {
    const h = mount();
    await flush();
    expect(h.modal.mode).toBe('solid');
    expect(h.text('placeholder')).toContain('Select a shape');

    h.tab('Part').click();
    expect(h.modal.mode).toBe('part');
    expect(h.text('placeholder')).toContain('Select a part');
    expect(h.hidden('form')).toBe(true);

    h.tab('Solid').click();
    expect(h.modal.mode).toBe('solid');
    expect(h.text('placeholder')).toContain('Select a shape');
  });

  it('has no density input anywhere — density is a read-only row', async () => {
    const h = mount();
    await flush();
    h.modal.setSelectedShape('sTop');
    expect(h.q('[data-ref="density"]')).toBeNull();
    expect(h.q('input[type="number"]')).toBeNull();
    expect(h.q('[data-ref="density-value"]')).not.toBeNull();
  });
});

describe('shape properties — Solid mode', () => {
  it('shows the enclosing part\'s material and density read-only', async () => {
    const h = mount();
    await flush();
    h.modal.setSelectedShape('sA1');
    expect(h.hidden('form')).toBe(false);
    expect(h.hidden('material-select-block')).toBe(true);
    expect(h.hidden('material-row')).toBe(false);
    expect(h.text('material-value')).toBe('Steel');
    expect(h.text('density-value')).toBe('7.87 g/cm³');
  });

  it('computes mass from the part\'s density: 1000 mm³ of steel', async () => {
    const h = mount();
    await flush();
    h.modal.setSelectedShape('sA1');
    await h.calculate();
    expect(h.client.getShapeProperties).toHaveBeenCalledWith('sA1');
    expect(h.text('vol')).toBe('1000.0000 mm³');
    expect(h.text('area')).toBe('600.0000 mm²');
    expect(h.text('mass')).toBe('7.8700 g');
  });

  it('names an unknown part material and leaves mass blank', async () => {
    const h = mount();
    await flush();
    h.modal.setSelectedShape('sB1');
    expect(h.text('material-value')).toBe('Unknown material: unobtainium');
    expect(h.text('density-value')).toBe('—');
    await h.calculate();
    expect(h.text('mass')).toBe('—');
  });

  it('offers the grouped dropdown for a solid outside any part, and for one whose part has no material', async () => {
    const h = mount();
    await flush();
    h.modal.setSelectedShape('sTop');
    expect(h.hidden('material-select-block')).toBe(false);
    expect(h.hidden('material-row')).toBe(true);
    const select = h.q<HTMLSelectElement>('[data-ref="material"]')!;
    expect(Array.from(select.querySelectorAll('optgroup')).map((g) => g.label)).toEqual(['Built-in', 'Custom']);
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['fluidcad-steel', 'fluidcad-aluminum', 'alloy-steel']);
    // The first entry is the default; the density row follows the pick.
    expect(h.text('density-value')).toBe('7.87 g/cm³');
    select.value = 'alloy-steel';
    select.dispatchEvent(new Event('change'));
    expect(h.text('density-value')).toBe('0.0077 g/mm³');
    await h.calculate();
    // 1000 mm³ × 0.0077 g/mm³
    expect(h.text('mass')).toBe('7.7000 g');

    h.modal.setSelectedShape('sC1');
    expect(h.hidden('material-select-block')).toBe(false);
    expect(h.hidden('material-row')).toBe(true);
  });
});

describe('shape properties — Part mode', () => {
  const partProps = (partId: string): PartProperties | null => {
    if (partId === 'A') {
      return {
        partId, name: 'part-A', shapeIds: ['sA1'], solidCount: 1,
        volumeMm3: 2000, surfaceAreaMm2: 1200, centroid: { x: 1, y: 2, z: 3 },
        material: { id: 'fluidcad-steel', name: 'Steel', density: 7.87, densityUnit: 'g/cm³', source: 'builtin', densityGcm3: 7.87 },
        massG: 15.74, unit: 'mm',
      };
    }
    if (partId === 'B') {
      return {
        partId, name: 'part-B', shapeIds: ['sB1', 'sB2'], solidCount: 2,
        volumeMm3: 3000, surfaceAreaMm2: 1800, centroid: { x: 0, y: 0, z: 0 },
        material: { id: 'unobtainium' }, warning: 'Unknown material: unobtainium', unit: 'mm',
      };
    }
    return null;
  };

  it('follows the timeline\'s selected part and calculates through the server', async () => {
    const h = mount({ partProps });
    await flush();
    h.track(loc(1));
    h.tab('Part').click();
    expect(h.hidden('form')).toBe(false);
    expect(h.q('[data-ref="material"]')!.closest('[data-ref="material-select-block"]')!.classList.contains('hidden')).toBe(true);
    expect(h.text('material-value')).toBe('Steel');
    expect(h.text('density-value')).toBe('7.87 g/cm³');
    expect(h.partSelections.at(-1)).toBe('A');

    await h.calculate();
    expect(h.getPartProperties).toHaveBeenCalledWith('A');
    expect(h.text('vol')).toBe('2000.0000 mm³');
    expect(h.text('area')).toBe('1200.0000 mm²');
    expect(h.text('mass')).toBe('15.7400 g');
    expect(h.text('centroid')).toBe('(1.0000, 2.0000, 3.0000) mm');
  });

  it('selects the part of a clicked solid, reads its solids, and shows an unknown material with no mass', async () => {
    const h = mount({ partProps });
    await flush();
    h.tab('Part').click();
    expect(h.hidden('form')).toBe(true);

    const picked = h.modal.selectPartOfShape('sB2');
    expect(picked?.id).toBe('B');
    expect(ShapePropertiesModal.partSolidShapeIds(picked!, SCENE)).toEqual(['sB1', 'sB2']);
    expect(h.text('material-value')).toBe('Unknown material: unobtainium');
    expect(h.text('density-value')).toBe('—');

    await h.calculate();
    expect(h.getPartProperties).toHaveBeenCalledWith('B');
    expect(h.text('vol')).toBe('3000.0000 mm³');
    expect(h.text('mass')).toBe('—');
  });

  it('shows "None" for a part without a material, and no dropdown', async () => {
    const h = mount({ partProps });
    await flush();
    h.tab('Part').click();
    h.modal.selectPartOfShape('sC1');
    expect(h.hidden('material-select-block')).toBe(true);
    expect(h.text('material-value')).toBe('None');
    expect(h.text('density-value')).toBe('—');
  });

  it('falls back to the timeline\'s part for a solid outside any part', async () => {
    const h = mount({ partProps });
    await flush();
    h.track(loc(20));
    h.tab('Part').click();
    expect(h.modal.selectedPart?.id).toBe('C');
    expect(h.modal.selectPartOfShape('sTop')?.id).toBe('C');
    expect(h.modal.selectPartOfShape(null)?.id).toBe('C');
  });

  it('re-adopts the part by source identity after a render and refreshes the material rows', async () => {
    const h = mount({ partProps });
    await flush();
    h.tab('Part').click();
    h.modal.selectPartOfShape('sC1');
    expect(h.text('material-value')).toBe('None');

    // Set material… re-rendered: new ids, C now carries aluminum.
    const next: SceneObjectRender[] = [part('C2', 20, 'fluidcad-aluminum'), solid('c1b', 21, 'sC1b', 'C2')];
    h.modal.setSceneProvider(() => next);
    h.modal.onSceneRendered();
    expect(h.modal.selectedPart?.id).toBe('C2');
    expect(h.text('material-value')).toBe('Aluminum');
    expect(h.text('density-value')).toBe('2.7 g/cm³');
    expect(h.partSelections.at(-1)).toBe('C2');
  });

  it('reports a host without part properties instead of calculating', async () => {
    const h = mount({ noPartProps: true });
    await flush();
    h.tab('Part').click();
    h.modal.selectPartOfShape('sA1');
    await h.calculate();
    expect(h.hidden('error')).toBe(false);
    expect(h.text('error')).toContain('not available');
  });
});

describe('Shape Properties — Manage materials…', () => {
  const manageBtn = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('[data-action="manage-materials"]')!;

  it('shows the link under the dropdown in an editor-backed host and opens the handler', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const client = {
      getMaterials: vi.fn(async () => MATERIALS),
      getShapeProperties: vi.fn(async () => SHAPE_PROPS),
      editor: { setPartMaterial: vi.fn() },
    } as unknown as EngineClient;
    const modal = new ShapePropertiesModal(container, client);
    await flush();
    // An <option> would be pickable as a material; the entry is a button under the select.
    expect(manageBtn(container).classList.contains('hidden')).toBe(true);
    const onManage = vi.fn();
    modal.setManageMaterialsHandler(onManage);
    expect(manageBtn(container).classList.contains('hidden')).toBe(false);
    expect(container.querySelector('[data-ref="material"] option[value=""]')).toBeNull();
    manageBtn(container).click();
    expect(onManage).toHaveBeenCalledTimes(1);
  });

  it('keeps the link hidden in a read-only host', async () => {
    const h = mount();
    await flush();
    h.modal.setManageMaterialsHandler(() => undefined);
    expect(manageBtn(h.container).classList.contains('hidden')).toBe(true);
  });

  it('reloadMaterials refills the dropdown from the given list and re-fetches without one', async () => {
    const h = mount();
    await flush();
    h.modal.setSelectedShape('sTop');
    const options = () => Array.from(h.container.querySelectorAll<HTMLOptionElement>('[data-ref="material"] option')).map((o) => o.value);
    expect(options()).toEqual(['fluidcad-steel', 'fluidcad-aluminum', 'alloy-steel']);

    await h.modal.reloadMaterials([...MATERIALS, { id: 'pine', name: 'Pine', density: 0.5, densityUnit: 'g/cm³', source: 'project' }]);
    expect(options()).toEqual(['fluidcad-steel', 'fluidcad-aluminum', 'alloy-steel', 'pine']);
    expect(h.client.getMaterials).toHaveBeenCalledTimes(1);

    // A transient pick that vanished falls back to the first entry.
    h.q<HTMLSelectElement>('[data-ref="material"]')!.value = 'pine';
    h.q<HTMLSelectElement>('[data-ref="material"]')!.dispatchEvent(new Event('change'));
    expect(h.text('density-value')).toBe('0.5 g/cm³');
    vi.mocked(h.client.getMaterials).mockResolvedValueOnce(MATERIALS);
    await h.modal.reloadMaterials();
    expect(h.client.getMaterials).toHaveBeenCalledTimes(2);
    expect(options()).toEqual(['fluidcad-steel', 'fluidcad-aluminum', 'alloy-steel']);
    expect(h.text('density-value')).toBe('7.87 g/cm³');
  });

  it('follows Settings → Materials: the user\'s own entries join the Custom group as soon as the store changes', async () => {
    const h = mount();
    await flush();
    h.modal.setSelectedShape('sTop');
    const options = () => Array.from(h.container.querySelectorAll<HTMLOptionElement>('[data-ref="material"] option')).map((o) => o.value);
    globalMaterials.update({ 'acme-pla': { name: 'ACME PLA+', density: 1.27, densityUnit: 'kg/m³' }, 'alloy-steel': { name: 'Shadowed', density: 1 } });
    await flush();
    // The project's alloy-steel wins over the global one with the same id.
    expect(options()).toEqual(['fluidcad-steel', 'fluidcad-aluminum', 'alloy-steel', 'acme-pla']);
    const custom = h.container.querySelector<HTMLOptGroupElement>('[data-ref="material"] optgroup[label="Custom"]')!;
    expect(Array.from(custom.querySelectorAll('option')).map((o) => o.textContent)).toEqual(['Alloy Steel', 'ACME PLA+']);
    globalMaterials.update({});
    await flush();
    expect(options()).toEqual(['fluidcad-steel', 'fluidcad-aluminum', 'alloy-steel']);
  });
});
