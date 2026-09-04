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

function part(id: string, name: string, shapeId: string): SceneObjectRender[] {
  // The solid hangs off a feature under the part, as a real render nests it,
  // so the filter has to follow the part's subtree.
  return [
    { id, name, type: 'part', parentId: null, sceneShapes: [], ownShapes: [] } as unknown as SceneObjectRender,
    {
      id: `${id}-extrude`,
      name: `${name} body`,
      type: 'extrusion',
      parentId: id,
      sceneShapes: [{ shapeId, shapeType: 'solid', meshes: [] }],
      ownShapes: [],
    } as unknown as SceneObjectRender,
  ];
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
  const bar = new TopBarActions(container, {
    export: {
      onExport,
      captureThumbnail: () => Promise.reject(new Error('no WebGL here')),
      onExportAssembly,
      captureAssemblyThumbnail: () => Promise.reject(new Error('no WebGL here')),
    },
  });
  const exportBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Export a solid"]')!;
  const openPanel = (): HTMLElement => {
    exportBtn.click();
    return container.querySelector<HTMLElement>('[data-panel="export"]')!;
  };
  const rowLabels = (panel: HTMLElement): string[] =>
    [...panel.querySelectorAll<HTMLElement>('[data-thumb]')].map((thumb) => thumb.nextElementSibling!.textContent);
  return { bar, container, onExport, onExportAssembly, openPanel, rowLabels };
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
