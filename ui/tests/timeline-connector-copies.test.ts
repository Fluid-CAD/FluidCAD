// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelinePanel } from '../src/ui/timeline-panel';
import { SceneIndex } from '../src/helpers/scene-index';
import type { EngineClient } from '../src/engine-client';
import type { SceneObjectRender } from '../src/types';

// Connector copies in the History panel (connector-copies stage 2): a
// `copy()` is one statement however many copies it makes, so it lists among
// the features like any pattern, and only the declared connectors fold
// behind the "N connectors" group. Clicking a copy that copies nothing but
// connectors shows the whole family instead of rolling back; a copy of
// solids and connectors together previews like any feature. A declared
// connector row offers "Copy…"; the copies a statement made never do, and
// are never edited as connectors.

Element.prototype.scrollIntoView = vi.fn();

afterEach(() => {
  document.body.innerHTML = '';
});

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const client = {
    savePreference: vi.fn(),
    rollback: vi.fn(),
    editor: { addBreakpoint: vi.fn(), gotoSource: vi.fn() },
  } as unknown as EngineClient;
  const timeline = new TimelinePanel(
    container,
    client,
    () => undefined,
    () => undefined,
    () => undefined,
    () => false,
    () => undefined,
    () => 1,
    () => undefined,
  );
  return {
    timeline,
    container,
    client,
    rowOf: (index: number) => container.querySelector<HTMLElement>(`[data-index="${index}"]`),
    groupToggle: (key: string) => container.querySelector<HTMLElement>(`[data-group-toggle="${key}"]`),
  };
}

const loc = (line: number) => ({ filePath: '/ws/flange.part.js', line, column: 2 });

function row(index: number, overrides: Partial<SceneObjectRender>): SceneObjectRender {
  return {
    id: `id-${index}`,
    name: overrides.type ?? 'row',
    sceneShapes: [],
    ownShapes: [],
    visible: true,
    sourceLocation: loc(index + 1),
    ...overrides,
  } as SceneObjectRender;
}

const FRAME = {
  origin: { x: 0, y: 0, z: 0 }, xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 },
};

/**
 * part > [extrude, bolt, copy(bolt) → 2 copies, pin, copy(plate, pin) → 1 copy, lug]
 */
function flange(): SceneObjectRender[] {
  return [
    row(0, { type: 'part', isContainer: true }),
    row(1, { type: 'extrude', parentId: 'id-0' }),
    row(2, { type: 'connector', name: 'bolt', parentId: 'id-0', object: { name: 'bolt', ...FRAME } }),
    row(3, {
      type: 'copy-circular', name: 'Copy', parentId: 'id-0', hideChildren: true,
      object: { connectorCopies: { seeds: [{ id: 'id-2', name: 'bolt' }], originalSlot: 0, slotCount: 3, slots: [1, 2], connectorsOnly: true } },
    }),
    row(4, { type: 'connector', name: 'bolt.instance(1)', parentId: 'id-3', sourceLocation: loc(4), object: { name: 'bolt', ...FRAME, copy: { slot: 1, seedId: 'id-2' } } }),
    row(5, { type: 'connector', name: 'bolt.instance(2)', parentId: 'id-3', sourceLocation: loc(4), object: { name: 'bolt', ...FRAME, copy: { slot: 2, seedId: 'id-2' } } }),
    row(6, { type: 'connector', name: 'pin', parentId: 'id-0', object: { name: 'pin', ...FRAME } }),
    row(7, {
      type: 'copy-linear', name: 'Copy 2', parentId: 'id-0', hideChildren: true,
      sceneShapes: [{ shapeId: 's1', shapeType: 'solid', meshes: [] }],
      object: { connectorCopies: { seeds: [{ id: 'id-6', name: 'pin' }], originalSlot: 0, slotCount: 2, slots: [1], connectorsOnly: false } },
    }),
    row(8, { type: 'connector', name: 'pin.instance(1)', parentId: 'id-7', sourceLocation: loc(8), object: { name: 'pin', ...FRAME, copy: { slot: 1, seedId: 'id-6' } } }),
    row(9, { type: 'connector', name: 'lug', parentId: 'id-0', object: { name: 'lug', ...FRAME } }),
  ];
}

describe('timeline — connector copies', () => {
  it('lists a connector-only copy among the features, folding only the declared connectors', () => {
    const h = mount();
    h.timeline.update(flange(), 8);

    // Both copies are statements in the history — visible with the group
    // still collapsed; the declared connectors fold behind the group row.
    expect(h.rowOf(1)).not.toBeNull();
    expect(h.rowOf(3)).not.toBeNull();
    expect(h.rowOf(7)).not.toBeNull();
    expect(h.rowOf(2)).toBeNull();
    const toggle = h.groupToggle('id-0:connectors')!;
    // bolt, pin and lug: the group counts the rows it lists.
    expect(toggle.textContent).toContain('— 3 connectors');

    toggle.click();
    expect(h.rowOf(2)).not.toBeNull();
    expect(h.rowOf(6)).not.toBeNull();
    expect(h.rowOf(9)).not.toBeNull();
    // A copy row stands for its copies: they stay folded under it.
    expect(h.rowOf(4)).toBeNull();
  });

  it('shows the whole family when the copy row is clicked, instead of rolling back', () => {
    const h = mount();
    const shown: SceneObjectRender[] = [];
    h.timeline.onFeatureShow = (obj) => shown.push(obj);
    const scene = flange();
    h.timeline.update(scene, 8);

    h.rowOf(3)!.click();

    expect(shown.map(obj => obj.id)).toEqual(['id-3']);
    expect(h.client.rollback).not.toHaveBeenCalled();
    expect(SceneIndex.of(scene).connectorFamilyOf(scene[3])).toEqual(['id-2', 'id-4', 'id-5']);
    // The mixed copy is a feature: a click previews it like any other row.
    h.rowOf(7)!.click();
    expect(h.client.rollback).toHaveBeenCalled();
  });

  it('offers "Copy…" on a declared connector nothing copies yet', () => {
    const h = mount();
    const copied: SceneObjectRender[] = [];
    h.timeline.onCopyConnector = (obj) => copied.push(obj);
    h.timeline.update(flange(), 9);
    h.groupToggle('id-0:connectors')!.click();

    const menuFor = (index: number) => {
      h.rowOf(index)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
      return h.container.querySelector<HTMLButtonElement>('[data-action="copy-connector"]');
    };

    const item = menuFor(9)!;
    expect(item.textContent).toContain('Copy…');
    item.click();
    expect(copied.map(obj => obj.id)).toEqual(['id-9']);

    // bolt and pin are copied already — one copy statement per connector —
    // and the copy row is a copy statement, not a connector to copy.
    expect(menuFor(2)).toBeNull();
    expect(menuFor(6)).toBeNull();
    expect(menuFor(3)).toBeNull();
  });

  it('tells the copies a statement made from declared connectors, and which copy copies a connector', () => {
    const scene = flange();
    expect(scene.map(obj => SceneIndex.isConnectorCopy(obj))).toEqual(
      [false, false, false, false, true, true, false, false, true, false],
    );
    expect(scene.map(obj => SceneIndex.copiesOnlyConnectors(obj))).toEqual(
      [false, false, false, true, false, false, false, false, false, false],
    );
    const index = SceneIndex.of(scene);
    expect(['id-2', 'id-6', 'id-9', 'id-4'].map(id => index.copyStatementOf(id)?.id)).toEqual(
      ['id-3', 'id-7', undefined, undefined],
    );
  });
});

// A copy that follows a repeat (`copy(holes, bolt)`, connector-copies stage
// 4) copies nothing but connectors: its `copy-pattern` row lists among the
// features beside the repeat it follows, and a click shows the family.
describe('timeline — a copy that follows a repeat', () => {
  function follow(): SceneObjectRender[] {
    return [
      row(0, { type: 'part', isContainer: true }),
      row(1, { type: 'extrude', parentId: 'id-0' }),
      row(2, { type: 'repeat-circular', name: 'Repeat', parentId: 'id-0', hideChildren: true }),
      row(3, { type: 'extrude', parentId: 'id-2', sourceLocation: loc(3) }),
      row(4, { type: 'connector', name: 'bolt', parentId: 'id-0', object: { name: 'bolt', ...FRAME } }),
      row(5, {
        type: 'copy-pattern', name: 'Copy', parentId: 'id-0', hideChildren: true,
        object: { connectorCopies: { seeds: [{ id: 'id-4', name: 'bolt' }], originalSlot: 0, slotCount: 3, slots: [1, 2], connectorsOnly: true } },
      }),
      row(6, { type: 'connector', name: 'bolt.instance(1)', parentId: 'id-5', sourceLocation: loc(6), object: { name: 'bolt', ...FRAME, copy: { slot: 1, seedId: 'id-4' } } }),
      row(7, { type: 'connector', name: 'bolt.instance(2)', parentId: 'id-5', sourceLocation: loc(6), object: { name: 'bolt', ...FRAME, copy: { slot: 2, seedId: 'id-4' } } }),
    ];
  }

  it('lists the copy-pattern row among the features and shows its family on a click', () => {
    const h = mount();
    const shown: SceneObjectRender[] = [];
    h.timeline.onFeatureShow = (obj) => shown.push(obj);
    const scene = follow();
    h.timeline.update(scene, 7);

    expect(h.rowOf(2)).not.toBeNull();
    expect(h.rowOf(5)).not.toBeNull();
    expect(h.rowOf(4)).toBeNull();
    // Only bolt folds behind the group.
    expect(h.groupToggle('id-0:connectors')!.textContent).toContain('— 1 connector');

    h.rowOf(5)!.click();
    expect(shown.map(obj => obj.id)).toEqual(['id-5']);
    expect(h.client.rollback).not.toHaveBeenCalled();
    expect(SceneIndex.of(scene).connectorFamilyOf(scene[5])).toEqual(['id-4', 'id-6', 'id-7']);
    expect(SceneIndex.of(scene).copyStatementOf('id-4')?.id).toBe('id-5');
  });
});
