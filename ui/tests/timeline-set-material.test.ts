// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelinePanel } from '../src/ui/timeline-panel';
import type { EngineClient } from '../src/engine-client';
import type { Material } from '../src/api';
import type { ObjectBuildWarning, SceneObjectRender } from '../src/types';

// Part materials on the timeline: a part row's context menu offers Set
// material…, which hands the row to the Set material dialog (the pick and
// its acked set-part-material edit live there). A render's `objectWarnings`
// marks the row with a warning triangle (non-fatal: the row keeps its colour).

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
  return { container, timeline, editor, client, row, openMenu };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('timeline — Set material…', () => {
  it('offers the item on part rows only', () => {
    const h = mount();
    expect(h.openMenu('A')).not.toBeNull();
    expect(h.openMenu('a1')).toBeNull();
    expect(h.openMenu('top')).toBeNull();
  });

  it('hands the part row to the dialog opener instead of writing anything itself', () => {
    const h = mount();
    const onSetMaterial = vi.fn();
    h.timeline.onSetMaterial = onSetMaterial;
    h.openMenu('A')!.click();
    expect(onSetMaterial).toHaveBeenCalledTimes(1);
    expect(onSetMaterial.mock.calls[0][0]).toMatchObject({ id: 'A', type: 'part', sourceLocation: loc(1) });
    expect(h.editor.setPartMaterial).not.toHaveBeenCalled();
    expect(h.client.getMaterials).not.toHaveBeenCalled();
    // The row menu closed with the click.
    expect(h.container.querySelector('[data-action="set-material"]')).toBeNull();
  });

  it('does nothing without an opener', () => {
    const h = mount();
    expect(() => h.openMenu('C')!.click()).not.toThrow();
    expect(h.editor.setPartMaterial).not.toHaveBeenCalled();
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
