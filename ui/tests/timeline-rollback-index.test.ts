// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { TimelinePanel } from '../src/ui/timeline-panel';
import type { EngineClient } from '../src/engine-client';
import type { SceneObjectRender } from '../src/types';

// One-click rollback targets. A row's data-rollback-index is the scene index
// the click previews. Sketches roll back to their LAST descendant — like a
// hide-children repeat — because a sketch's curves live in its element
// children: stopping on the sketch row itself would draw its constraint
// glyphs (from the row's own solved snapshot) over an empty sketch.

// jsdom has no scrollIntoView; renderTimeline scrolls to the current row.
Element.prototype.scrollIntoView = vi.fn();

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const client = { savePreference: vi.fn() } as unknown as EngineClient;
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
    rollbackIndexOf: (index: number) => container
      .querySelector<HTMLElement>(`[data-index="${index}"]`)!
      .dataset.rollbackIndex,
  };
}

function row(index: number, overrides: Partial<SceneObjectRender>): SceneObjectRender {
  return {
    id: `id-${index}`,
    name: overrides.type ?? overrides.uniqueType ?? 'row',
    sceneShapes: [],
    ownShapes: [],
    visible: true,
    ...overrides,
  } as SceneObjectRender;
}

describe('timeline rollback targets', () => {
  it('rolls a sketch inside a part back to its last descendant', () => {
    const h = mount();
    // part > [sketch > [line, line, constraint], extrude]
    h.timeline.update([
      row(0, { type: 'part', isContainer: true }),
      row(1, { type: 'sketch', isContainer: true, parentId: 'id-0' }),
      row(2, { uniqueType: 'solved-line', parentId: 'id-1' }),
      row(3, { uniqueType: 'solved-line', parentId: 'id-1' }),
      row(4, { uniqueType: 'constraint-distance', parentId: 'id-1' }),
      row(5, { type: 'extrude', parentId: 'id-0' }),
    ], 5);

    // The sketch row previews the whole sketch wherever it is nested: its
    // element rows list under it, but clicking the sketch itself must show
    // every curve, not an empty sketch with constraint glyphs.
    expect(h.rollbackIndexOf(1)).toBe('4');
    expect(h.rollbackIndexOf(5)).toBe('5');
  });

  it('rolls a top-level sketch back to its last descendant', () => {
    const h = mount();
    h.timeline.update([
      row(0, { type: 'sketch', isContainer: true }),
      row(1, { uniqueType: 'solved-line', parentId: 'id-0' }),
      row(2, { uniqueType: 'solved-line', parentId: 'id-0' }),
      row(3, { type: 'extrude' }),
    ], 3);

    expect(h.rollbackIndexOf(0)).toBe('2');
    // Element children still preview their own step.
    expect(h.rollbackIndexOf(1)).toBe('1');
    expect(h.rollbackIndexOf(3)).toBe('3');
  });

  it('keeps a hide-children container on its last descendant', () => {
    const h = mount();
    h.timeline.update([
      row(0, { type: 'sketch', isContainer: true }),
      row(1, { uniqueType: 'solved-line', parentId: 'id-0' }),
      row(2, { type: 'extrude' }),
      row(3, { type: 'linear-pattern', isContainer: true, hideChildren: true }),
      row(4, { type: 'extrude', parentId: 'id-3' }),
      row(5, { type: 'extrude', parentId: 'id-3' }),
    ], 5);

    expect(h.rollbackIndexOf(3)).toBe('5');
  });
});
