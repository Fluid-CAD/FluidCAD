// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TopBarActions } from '../src/ui/top-bar-actions';
import { normalizeAssemblyPayload } from '../src/scene/assembly-payload';
import type { SceneObjectRender, SerializedAssembly } from '../src/types';

// The top bar's Export list in an assembly: it leads with "Whole assembly"
// (every instance where it sits) and lists only the parts that are actually
// inserted — an assembly file registers every part it might use, and the
// render carries them all, but the un-inserted ones are not in the assembly.
// A part scene has neither behaviour.
//
// Either kind of scene leads its solids with a "Whole part" row per part
// that holds more than one of them: the part's solids together, in one file.

function part(id: string, name: string, shapeId: string): SceneObjectRender[] {
  // The solid hangs off a feature under the part, as a real render nests it,
  // so the filter has to follow the part's subtree.
  return [
    { id, name, type: 'part', parentId: null, sceneShapes: [], ownShapes: [] } as unknown as SceneObjectRender,
    {
      id: `${id}-extrude`,
      name: `${name} body`,
      hasCustomName: true,
      type: 'extrusion',
      parentId: id,
      sceneShapes: [{ shapeId, shapeType: 'solid', meshes: [] }],
      ownShapes: [],
    } as unknown as SceneObjectRender,
  ];
}

/** A part row and one feature under it holding `shapeIds`, unnamed — so the solids read `Solid <n> (<part>)`. */
function partOf(id: string, name: string, ...shapeIds: string[]): SceneObjectRender[] {
  return [
    { id, name, type: 'part', parentId: null, sceneShapes: [], ownShapes: [] } as unknown as SceneObjectRender,
    feature(`${id}-extrude`, id, ...shapeIds),
  ];
}

/** A feature row holding `shapeIds`; `parentId` null puts it outside every part. */
function feature(id: string, parentId: string | null, ...shapeIds: string[]): SceneObjectRender {
  return {
    id,
    name: 'Extrude 1',
    type: 'extrusion',
    parentId,
    sceneShapes: shapeIds.map((shapeId) => ({ shapeId, shapeType: 'solid', meshes: [] })),
    ownShapes: [],
  } as unknown as SceneObjectRender;
}

const objects: SceneObjectRender[] = [
  ...part('p-housing', 'Housing', 's-housing'),
  ...part('p-lid', 'Lid', 's-lid'),
  ...part('p-spare', 'Spare', 's-spare'),
];

function assemblyOf(...partIds: string[]): SerializedAssembly {
  return normalizeAssemblyPayload({
    instances: partIds.map((partId, i) => ({
      instanceId: `inst-${i}`,
      partId,
      partName: partId,
      name: `${partId} ${i}`,
      position: { x: 0, y: 0, z: 0 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
      grounded: false,
    })),
  });
}

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const onExport = vi.fn();
  const onExportAssembly = vi.fn();
  const onExportPart = vi.fn();
  const bar = new TopBarActions(container, {
    export: {
      onExport,
      captureThumbnail: () => Promise.reject(new Error('no WebGL here')),
      onExportAssembly,
      captureAssemblyThumbnail: () => Promise.reject(new Error('no WebGL here')),
      onExportPart,
      capturePartThumbnail: () => Promise.reject(new Error('no WebGL here')),
    },
  });
  const exportBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Export a solid"]')!;
  const openPanel = (): HTMLElement => {
    exportBtn.click();
    return container.querySelector<HTMLElement>('[data-panel="export"]')!;
  };
  const rowLabels = (panel: HTMLElement): string[] =>
    [...panel.querySelectorAll<HTMLElement>('[data-thumb]')].map((thumb) => thumb.nextElementSibling!.textContent);
  return { bar, container, onExport, onExportAssembly, onExportPart, openPanel, rowLabels };
}

describe('top bar Export list', () => {
  const objectUrl = URL.createObjectURL;
  const revokeUrl = URL.revokeObjectURL;

  beforeEach(() => {
    vi.useFakeTimers();
    URL.createObjectURL = () => 'blob:thumb';
    URL.revokeObjectURL = () => undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
    URL.createObjectURL = objectUrl;
    URL.revokeObjectURL = revokeUrl;
    document.body.innerHTML = '';
  });

  it('part scene: one row per solid, every declared part, no whole-assembly row', () => {
    const { bar, openPanel, rowLabels } = mount();
    bar.updateSolids(objects);
    const panel = openPanel();
    expect(rowLabels(panel)).toEqual(['Housing body', 'Lid body', 'Spare body']);
    expect(panel.querySelector('[data-whole-assembly]')).toBeNull();
    // One solid apiece: its own row already is the whole part.
    expect(panel.querySelector('[data-whole-part]')).toBeNull();
  });

  it('assembly scene: "Whole assembly" first, then only the inserted parts', () => {
    const { bar, openPanel, rowLabels, onExportAssembly, onExport } = mount();
    bar.updateSolids(objects, assemblyOf('p-housing', 'p-lid', 'p-lid'));
    const panel = openPanel();
    expect(rowLabels(panel)).toEqual(['Whole assembly', 'Housing body', 'Lid body']);

    const whole = panel.querySelector<HTMLButtonElement>('[data-whole-assembly]')!;
    expect(panel.firstElementChild).toBe(whole);
    whole.click();
    expect(onExportAssembly).toHaveBeenCalledTimes(1);
    expect(onExport).not.toHaveBeenCalled();
  });

  it('assembly scene: a per-part row still exports that one solid', () => {
    const { bar, openPanel, onExport } = mount();
    bar.updateSolids(objects, assemblyOf('p-lid'));
    const panel = openPanel();
    const rows = [...panel.querySelectorAll<HTMLButtonElement>('button')];
    expect(rows).toHaveLength(2);
    rows[1].click();
    expect(onExport).toHaveBeenCalledWith('s-lid');
  });

  it('assembly with nothing inserted offers no whole-assembly row', () => {
    const { bar, openPanel, rowLabels } = mount();
    bar.updateSolids(objects, assemblyOf());
    const panel = openPanel();
    expect(rowLabels(panel)).toEqual([]);
    expect(panel.textContent).toContain('No solids in the scene');
  });

  it('switching from an assembly back to a part scene drops the whole-assembly row', () => {
    const { bar, openPanel, rowLabels } = mount();
    bar.updateSolids(objects, assemblyOf('p-housing'));
    expect(rowLabels(openPanel())).toEqual(['Whole assembly', 'Housing body']);
    bar.updateSolids(objects);
    expect(rowLabels(openPanel())).toEqual(['Housing body', 'Lid body', 'Spare body']);
  });

  it('an unnamed holder reads as the Shapes panel labels it, with its part; a named one as its name', () => {
    const { bar, openPanel, rowLabels } = mount();
    const scene: SceneObjectRender[] = [
      ...part('p-housing', 'Housing', 's-housing'),
      { id: 'p-lid', name: 'Lid', type: 'part', parentId: null, sceneShapes: [], ownShapes: [] } as unknown as SceneObjectRender,
      {
        id: 'p-lid-extrude', name: 'Extrude 1', type: 'extrusion', parentId: 'p-lid',
        sceneShapes: [{ shapeId: 's-lid-a', shapeType: 'solid', meshes: [] }, { shapeId: 's-lid-b', shapeType: 'solid', meshes: [] }],
        ownShapes: [],
      } as unknown as SceneObjectRender,
      {
        id: 'top-extrude', name: 'Extrude 2', type: 'extrusion', parentId: null,
        sceneShapes: [{ shapeId: 's-top', shapeType: 'solid', meshes: [] }],
        ownShapes: [],
      } as unknown as SceneObjectRender,
    ];
    bar.updateSolids(scene);
    expect(rowLabels(openPanel())).toEqual(['Whole part (Lid)', 'Housing body', 'Solid 1 (Lid)', 'Solid 2 (Lid)', 'Solid 1']);
  });

  it('a part with several solids: "Whole part" first, exporting every solid of the scene', () => {
    const { bar, openPanel, rowLabels, onExportPart, onExport } = mount();
    bar.updateSolids(partOf('p-box', 'Box', 's-body', 's-lid'));
    const panel = openPanel();
    expect(rowLabels(panel)).toEqual(['Whole part', 'Solid 1 (Box)', 'Solid 2 (Box)']);

    const whole = panel.querySelector<HTMLButtonElement>('[data-whole-part]')!;
    expect(panel.firstElementChild).toBe(whole);
    // A divider sets the row apart from the solids, as it does the whole assembly.
    expect(whole.nextElementSibling!.tagName).toBe('DIV');
    whole.click();
    expect(onExportPart).toHaveBeenCalledWith(['s-body', 's-lid'], true);
    expect(onExport).not.toHaveBeenCalled();
  });

  it('solids no part holds count as one part', () => {
    const { bar, openPanel, rowLabels, onExportPart } = mount();
    bar.updateSolids([feature('extrude-a', null, 's-a'), feature('extrude-b', null, 's-b')]);
    const panel = openPanel();
    expect(rowLabels(panel)).toEqual(['Whole part', 'Solid 1', 'Solid 2']);
    panel.querySelector<HTMLButtonElement>('[data-whole-part]')!.click();
    expect(onExportPart).toHaveBeenCalledWith(['s-a', 's-b'], true);
  });

  it('several parts: a row for each one holding several solids, named, exporting its own solids only', () => {
    const { bar, openPanel, rowLabels, onExportPart } = mount();
    bar.updateSolids([
      ...partOf('p-box', 'Box', 's-body', 's-lid'),
      ...partOf('p-pin', 'Pin', 's-pin'),
      ...partOf('p-clip', 'Clip', 's-clip-a', 's-clip-b', 's-clip-c'),
    ]);
    const panel = openPanel();
    expect(rowLabels(panel)).toEqual([
      'Whole part (Box)', 'Whole part (Clip)',
      'Solid 1 (Box)', 'Solid 2 (Box)', 'Solid 1 (Pin)', 'Solid 1 (Clip)', 'Solid 2 (Clip)', 'Solid 3 (Clip)',
    ]);
    panel.querySelectorAll<HTMLButtonElement>('[data-whole-part]')[1].click();
    expect(onExportPart).toHaveBeenCalledWith(['s-clip-a', 's-clip-b', 's-clip-c'], false);
  });

  it('assembly scene: an inserted part with several solids follows "Whole assembly", by its ids', () => {
    const { bar, openPanel, rowLabels, onExportPart, onExportAssembly } = mount();
    bar.updateSolids(
      [...partOf('p-box', 'Box', 's-body', 's-lid'), ...partOf('p-spare', 'Spare', 's-spare-a', 's-spare-b')],
      assemblyOf('p-box'),
    );
    const panel = openPanel();
    // The un-inserted part gets no row of either kind.
    expect(rowLabels(panel)).toEqual(['Whole assembly', 'Whole part (Box)', 'Solid 1 (Box)', 'Solid 2 (Box)']);
    panel.querySelector<HTMLButtonElement>('[data-whole-part]')!.click();
    // The part is a template of the assembly's file, never that file's whole output.
    expect(onExportPart).toHaveBeenCalledWith(['s-body', 's-lid'], false);
    expect(onExportAssembly).not.toHaveBeenCalled();
  });

  it('a part that gains or loses its second solid gets or drops the row', () => {
    const { bar, openPanel, rowLabels } = mount();
    bar.updateSolids(partOf('p-box', 'Box', 's-body'));
    expect(rowLabels(openPanel())).toEqual(['Solid 1 (Box)']);
    bar.updateSolids(partOf('p-box', 'Box', 's-body', 's-lid'));
    expect(rowLabels(openPanel())).toEqual(['Whole part', 'Solid 1 (Box)', 'Solid 2 (Box)']);
    bar.updateSolids(partOf('p-box', 'Box', 's-body'));
    expect(rowLabels(openPanel())).toEqual(['Solid 1 (Box)']);
  });

  it('a whole-part handler-less host lists solids only, and one without a capture shows an icon', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const without = new TopBarActions(container, {
      export: { onExport: () => undefined, captureThumbnail: () => Promise.reject(new Error('none')) },
    });
    without.updateSolids(partOf('p-box', 'Box', 's-body', 's-lid'));
    container.querySelector<HTMLButtonElement>('button[aria-label="Export a solid"]')!.click();
    expect(container.querySelector('[data-whole-part]')).toBeNull();
    expect([...container.querySelectorAll('[data-thumb]')]).toHaveLength(2);

    const iconHost = document.createElement('div');
    document.body.appendChild(iconHost);
    const iconOnly = new TopBarActions(iconHost, {
      export: {
        onExport: () => undefined,
        captureThumbnail: () => Promise.reject(new Error('none')),
        onExportPart: () => undefined,
      },
    });
    iconOnly.updateSolids(partOf('p-box', 'Box', 's-body', 's-lid'));
    iconHost.querySelector<HTMLButtonElement>('button[aria-label="Export a solid"]')!.click();
    vi.runAllTimers();
    const thumb = iconHost.querySelector<HTMLElement>('[data-whole-part] [data-thumb]')!;
    expect(thumb.querySelector('svg')).not.toBeNull();
  });

  it('a whole-assembly handler-less host lists parts only', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const bar = new TopBarActions(container, {
      export: { onExport: () => undefined, captureThumbnail: () => Promise.reject(new Error('none')) },
    });
    bar.updateSolids(objects, assemblyOf('p-housing'));
    container.querySelector<HTMLButtonElement>('button[aria-label="Export a solid"]')!.click();
    const panel = container.querySelector<HTMLElement>('[data-panel="export"]')!;
    expect(panel.querySelector('[data-whole-assembly]')).toBeNull();
    expect([...panel.querySelectorAll('[data-thumb]')]).toHaveLength(1);
  });
});
