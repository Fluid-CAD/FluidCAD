// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { TimelinePanel } from '../src/ui/timeline-panel';
import type { EngineClient } from '../src/engine-client';
import type { SceneObjectRender } from '../src/types';

// The timeline renders three nesting levels — part > sketch > curves and
// constraints — so a sketch's contents stay reachable when it lives inside
// a part() container. Deeper rows fold into the nearest rendered ancestor.

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
  const rowOf = (index: number) => container.querySelector<HTMLElement>(`[data-index="${index}"]`);
  return {
    timeline,
    container,
    rowOf,
    indentOf: (index: number) => {
      const cls = rowOf(index)!.className.split(' ');
      return cls.find((c) => /^pl-\d+$/.test(c)) ?? '';
    },
    constraintToggle: (sketchId: string) => container.querySelector<HTMLElement>(`[data-constraints-toggle="${sketchId}"]`),
    chevronOf: (id: string) => container.querySelector<HTMLElement>(`[data-toggle="${id}"]`),
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

// part > [sketch > [line, line, constraint], extrude]
function partWithSketch(): SceneObjectRender[] {
  return [
    row(0, { type: 'part', isContainer: true }),
    row(1, { type: 'sketch', isContainer: true, parentId: 'id-0' }),
    row(2, { uniqueType: 'solved-line', parentId: 'id-1' }),
    row(3, { uniqueType: 'solved-line', parentId: 'id-1' }),
    row(4, { uniqueType: 'constraint-distance', parentId: 'id-1' }),
    row(5, { type: 'extrude', parentId: 'id-0' }),
  ];
}

describe('timeline nesting depth', () => {
  it('renders a sketch nested in a part with its curves and a constraint group', () => {
    const h = mount();
    h.timeline.update(partWithSketch(), 5);

    expect(h.indentOf(0)).toBe('');
    expect(h.indentOf(1)).toBe('pl-7');
    expect(h.indentOf(5)).toBe('pl-7');
    // Grandchildren indent one more step.
    expect(h.indentOf(2)).toBe('pl-11');
    expect(h.indentOf(3)).toBe('pl-11');
    // The nested sketch gets its own chevron.
    expect(h.chevronOf('id-1')).not.toBeNull();
    // Constraints sit behind the "N constraints" summary at the same depth.
    expect(h.rowOf(4)).toBeNull();
    const toggle = h.constraintToggle('id-1')!;
    expect(toggle.className.split(' ')).toContain('pl-11');
    toggle.click();
    expect(h.rowOf(4)).not.toBeNull();
    expect(h.indentOf(4)).toBe('pl-11');
  });

  it('collapsing the nested sketch hides its rows and keeps the sibling extrude', () => {
    const h = mount();
    h.timeline.update(partWithSketch(), 5);
    h.chevronOf('id-1')!.click();
    expect(h.rowOf(1)).not.toBeNull();
    expect(h.rowOf(2)).toBeNull();
    expect(h.rowOf(3)).toBeNull();
    expect(h.constraintToggle('id-1')).toBeNull();
    expect(h.rowOf(5)).not.toBeNull();
  });

  it('caps at three levels: a great-grandchild folds into its rendered ancestor', () => {
    const h = mount();
    // part > sketch > group > line — the group is the last rendered depth.
    h.timeline.update([
      row(0, { type: 'part', isContainer: true }),
      row(1, { type: 'sketch', isContainer: true, parentId: 'id-0' }),
      row(2, { type: 'group', isContainer: true, parentId: 'id-1' }),
      row(3, { uniqueType: 'solved-line', parentId: 'id-2' }),
    ], 3);
    expect(h.rowOf(2)).not.toBeNull();
    expect(h.rowOf(3)).toBeNull();
    // No chevron on a container that cannot expand further.
    expect(h.chevronOf('id-2')).toBeNull();
    // A pick on the hidden row highlights the deepest rendered ancestor.
    h.timeline.setPickedFeature('id-3');
    expect(h.rowOf(2)!.dataset.picked).toBe('true');
  });

  it('a pick on a grandchild expands every collapsed ancestor and flags errors upward', () => {
    const h = mount();
    const items = partWithSketch();
    items[4].hasError = true;
    h.timeline.update(items, 5);
    // The failing constraint marks the sketch and the part around it.
    expect(h.rowOf(1)!.className.split(' ')).toContain('text-error');
    expect(h.rowOf(0)!.className.split(' ')).toContain('text-error');

    h.chevronOf('id-1')!.click();
    h.chevronOf('id-0')!.click();
    expect(h.rowOf(1)).toBeNull();

    h.timeline.setPickedFeature('id-4');
    expect(h.rowOf(4)).not.toBeNull();
    expect(h.rowOf(4)!.dataset.picked).toBe('true');
  });
});
