// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelinePanel } from '../src/ui/timeline-panel';
import { closePopupMenu } from '../src/ui/popup-menu';
import type { EngineClient } from '../src/engine-client';
import type { Material } from '../src/api';
import type { ObjectBuildWarning, SceneObjectRender } from '../src/types';

// Part materials on the timeline (stage 2): a part row's context menu offers
// Set material…, a popup of the merged materials with the current one
// checked and None to remove the chain; picking one dispatches the acked
// set-part-material edit. A render's `objectWarnings` marks the row with a
// warning triangle (non-fatal: the row keeps its colour).

Element.prototype.scrollIntoView = vi.fn();

const FILE = '/ws/bracket.part.js';
const loc = (line: number) => ({ filePath: FILE, line, column: 1 });

const MATERIALS: Material[] = [
  { id: 'fluidcad-steel', name: 'Steel', density: 7.87, densityUnit: 'g/cm³', source: 'builtin' },
  { id: 'alloy-steel', name: 'Alloy Steel', density: 7.7, densityUnit: 'g/cm³', source: 'project' },
];

function part(id: string, line: number, material?: string): SceneObjectRender {
  return {
    id, name: `part-${id}`, type: 'part', isContainer: true, object: { material },
    sceneShapes: [], ownShapes: [], visible: true, sourceLocation: loc(line),
  } as unknown as SceneObjectRender;
}

function feature(id: string, line: number, parentId?: string): SceneObjectRender {
  return {
    id, name: 'extrude', type: 'extrude', parentId, visible: true,
    sceneShapes: [], ownShapes: [], sourceLocation: loc(line),
  } as unknown as SceneObjectRender;
}

/** Part A (steel) with a feature, part B (unknown id), part C (none), a top-level feature. */
const SCENE: SceneObjectRender[] = [
  part('A', 1, 'fluidcad-steel'), feature('a1', 2, 'A'),
  part('B', 10, 'unobtainium'),
  part('C', 20),
  feature('top', 30),
];

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = {
    addBreakpoint: vi.fn(),
    gotoSource: vi.fn(),
    setPartMaterial: vi.fn(async () => ({ success: true })),
  };
  const client = {
    savePreference: vi.fn(),
    rollback: vi.fn(),
    getMaterials: vi.fn(async () => MATERIALS),
    editor,
  } as unknown as EngineClient;
  const timeline = new TimelinePanel(
    container, client,
    () => undefined, () => undefined, () => undefined, () => false, () => undefined, () => 1, () => undefined,
  );
  timeline.update(SCENE, SCENE.length - 1);
  const row = (id: string) => container.querySelector<HTMLElement>(`[data-index="${SCENE.findIndex((o) => o.id === id)}"]`)!;
  const openMenu = (id: string) => {
    row(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    return container.querySelector<HTMLButtonElement>('[data-action="set-material"]');
  };
  const popupRows = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  const openMaterials = async (id: string) => {
    openMenu(id)!.click();
    await flush();
    return popupRows();
  };
  return { container, timeline, editor, row, openMenu, openMaterials, popupRows };
}

afterEach(() => {
  closePopupMenu();
  document.body.innerHTML = '';
});

describe('timeline — Set material…', () => {
  it('offers the item on part rows only', () => {
    const h = mount();
    expect(h.openMenu('A')).not.toBeNull();
    expect(h.openMenu('a1')).toBeNull();
    expect(h.openMenu('top')).toBeNull();
  });

  it('lists None and the merged materials, the current one checked, and dispatches the pick', async () => {
    const h = mount();
    const rows = await h.openMaterials('A');
    expect(rows.map((r) => r.textContent)).toEqual(['None', 'Steel', 'Alloy Steel (project)']);
    const checked = rows.filter((r) => r.querySelector('svg') !== null).map((r) => r.textContent);
    expect(checked).toEqual(['Steel']);

    rows[2].click();
    expect(h.editor.setPartMaterial).toHaveBeenCalledWith(loc(1), 'alloy-steel');
    // Picking closes the popup.
    expect(h.popupRows()).toEqual([]);
  });

  it('sends null for None, and checks None on a part without a material', async () => {
    const h = mount();
    const rows = await h.openMaterials('C');
    const checked = rows.filter((r) => r.querySelector('svg') !== null).map((r) => r.textContent);
    expect(checked).toEqual(['None']);
    rows[0].click();
    expect(h.editor.setPartMaterial).toHaveBeenCalledWith(loc(20), null);
  });

  it('shows an unknown id as a checked, unpickable row', async () => {
    const h = mount();
    const rows = await h.openMaterials('B');
    expect(rows.map((r) => r.textContent)).toEqual(['None', 'Unknown material: unobtainium', 'Steel', 'Alloy Steel (project)']);
    expect(rows[1].disabled).toBe(true);
    expect(rows[1].querySelector('svg')).not.toBeNull();
  });
});

describe('timeline — material warnings', () => {
  const warnings: ObjectBuildWarning[] = [
    { index: 2, id: 'B', name: 'part-B', uniqueKind: 'part', message: 'Unknown material: unobtainium', sourceLocation: loc(10) },
  ];

  it('marks the warned part row with the message, in warning colour, not error', () => {
    const h = mount();
    h.timeline.update(SCENE, SCENE.length - 1, null, { warnings });
    const mark = h.row('B').querySelector<HTMLElement>('[data-warning]')!;
    expect(mark).not.toBeNull();
    expect(mark.dataset.warning).toBe('Unknown material: unobtainium');
    expect(mark.title).toBe('Unknown material: unobtainium');
    expect(mark.classList.contains('text-warning')).toBe(true);
    expect(h.row('B').classList.contains('text-error')).toBe(false);
    expect(h.row('A').querySelector('[data-warning]')).toBeNull();
    expect(h.row('C').querySelector('[data-warning]')).toBeNull();
  });

  it('clears the mark on a render with an empty list, keeps it when the render carries none', () => {
    const h = mount();
    h.timeline.update(SCENE, SCENE.length - 1, null, { warnings });
    h.timeline.update(SCENE, SCENE.length - 1, null, {});
    expect(h.row('B').querySelector('[data-warning]')).not.toBeNull();
    h.timeline.update(SCENE, SCENE.length - 1, null, { warnings: [] });
    expect(h.row('B').querySelector('[data-warning]')).toBeNull();
  });

  it('falls back to the warning\'s index when it carries no id', () => {
    const h = mount();
    h.timeline.update(SCENE, SCENE.length - 1, null, { warnings: [{ index: 3, message: 'Unknown material: x' }] });
    expect(h.row('C').querySelector('[data-warning]')).not.toBeNull();
  });
});

describe('timeline — Manage materials…', () => {
  it('ends the Set material… popup with the entry once a handler is set, and calls it', async () => {
    const h = mount();
    const onManage = vi.fn();
    h.timeline.onManageMaterials = onManage;
    const rows = await h.openMaterials('A');
    expect(rows.map((r) => r.textContent!.trim())).toEqual(['None', 'Steel', 'Alloy Steel (project)', 'Manage materials…']);
    rows[3].click();
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(h.editor.setPartMaterial).not.toHaveBeenCalled();
    expect(h.popupRows()).toEqual([]);
  });

  it('has no such row without a handler', async () => {
    const h = mount();
    const rows = await h.openMaterials('A');
    expect(rows.map((r) => r.textContent!.trim())).not.toContain('Manage materials…');
  });
});
