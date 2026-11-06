// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelinePanel } from '../src/ui/timeline-panel';
import type { EngineClient } from '../src/engine-client';
import type { ObjectBuildWarning, SceneObjectRender } from '../src/types';

// Part appearances on the timeline: a part row's context menu offers Set
// appearance… beside Set material…, handing the row to the Set appearance
// dialog (the pick and its acked edit live there). An unknown id's warning
// marks the row like an unknown material's.

Element.prototype.scrollIntoView = vi.fn();

const FILE = '/ws/shelf.part.js';
const loc = (line: number) => ({ filePath: FILE, line, column: 1 });

function part(id: string, line: number, appearance?: string): SceneObjectRender {
  return {
    id, name: `part-${id}`, type: 'part', isContainer: true, object: { appearance },
    sceneShapes: [], ownShapes: [], visible: true, sourceLocation: loc(line),
  } as unknown as SceneObjectRender;
}

function feature(id: string, line: number, parentId?: string): SceneObjectRender {
  return {
    id, name: 'extrude', type: 'extrude', parentId, visible: true,
    sceneShapes: [], ownShapes: [], sourceLocation: loc(line),
  } as unknown as SceneObjectRender;
}

const SCENE: SceneObjectRender[] = [
  part('A', 1, 'oak'), feature('a1', 2, 'A'),
  part('B', 10, 'chrome'),
  feature('top', 30),
];

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = {
    addBreakpoint: vi.fn(),
    gotoSource: vi.fn(),
    setPartAppearance: vi.fn(async () => ({ success: true })),
  };
  const client = { savePreference: vi.fn(), rollback: vi.fn(), editor } as unknown as EngineClient;
  const timeline = new TimelinePanel(
    container, client,
    () => undefined, () => undefined, () => undefined, () => false, () => undefined, () => 1, () => undefined,
  );
  timeline.setActivePart = vi.fn(() => false);
  timeline.update(SCENE, SCENE.length - 1);
  const row = (id: string) => container.querySelector<HTMLElement>(`[data-index="${SCENE.findIndex((o) => o.id === id)}"]`)!;
  const openMenu = (id: string) => {
    row(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    return container.querySelector<HTMLButtonElement>('[data-action="set-appearance"]');
  };
  return { container, timeline, editor, row, openMenu };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('timeline — Set appearance…', () => {
  it('offers the item on part rows only, next to Set material…', () => {
    const h = mount();
    expect(h.openMenu('A')).not.toBeNull();
    expect(h.container.querySelector('[data-action="set-material"]')).not.toBeNull();
    expect(h.openMenu('a1')).toBeNull();
    expect(h.openMenu('top')).toBeNull();
  });

  it('hands the part row to the dialog opener instead of writing anything itself', () => {
    const h = mount();
    const onSetAppearance = vi.fn();
    h.timeline.onSetAppearance = onSetAppearance;
    h.openMenu('A')!.click();
    expect(onSetAppearance).toHaveBeenCalledTimes(1);
    expect(onSetAppearance.mock.calls[0][0]).toMatchObject({ id: 'A', type: 'part', sourceLocation: loc(1) });
    expect(h.editor.setPartAppearance).not.toHaveBeenCalled();
    expect(h.container.querySelector('[data-action="set-appearance"]')).toBeNull();
  });

  it('does nothing without an opener', () => {
    const h = mount();
    expect(() => h.openMenu('B')!.click()).not.toThrow();
    expect(h.editor.setPartAppearance).not.toHaveBeenCalled();
  });

  it('marks a part row with an unknown appearance warning, in warning colour', () => {
    const h = mount();
    const warnings: ObjectBuildWarning[] = [
      { index: 2, id: 'B', name: 'part-B', uniqueKind: 'part', message: 'Unknown appearance: chrome', sourceLocation: loc(10) },
    ];
    h.timeline.update(SCENE, SCENE.length - 1, null, { warnings });
    const mark = h.row('B').querySelector<HTMLElement>('[data-warning]')!;
    expect(mark).not.toBeNull();
    expect(mark.dataset.warning).toBe('Unknown appearance: chrome');
    expect(mark.classList.contains('text-warning')).toBe(true);
    expect(h.row('A').querySelector('[data-warning]')).toBeNull();
  });
});
