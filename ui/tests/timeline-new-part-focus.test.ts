// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { TimelinePanel } from '../src/ui/timeline-panel';
import type { EngineClient } from '../src/engine-client';
import type { SceneObjectRender } from '../src/types';

// Adding a part collapses every other part so the new one is the only open
// container. Parts that survive by source identity keep their own state.

Element.prototype.scrollIntoView = vi.fn();

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const client = { savePreference: vi.fn() } as unknown as EngineClient;
  const timeline = new TimelinePanel(
    container, client,
    () => undefined, () => undefined, () => undefined, () => false, () => undefined, () => 1, () => undefined,
  );
  return {
    timeline,
    rowOf: (index: number) => container.querySelector<HTMLElement>(`[data-index="${index}"]`),
    chevronOf: (id: string) => container.querySelector<HTMLElement>(`[data-toggle="${id}"]`),
  };
}

function part(index: number, id: string, line: number): SceneObjectRender {
  return {
    id, name: `part-${line}`, type: 'part', isContainer: true,
    sceneShapes: [], ownShapes: [], visible: true,
    sourceLocation: { filePath: 'a.fluid.js', line, column: 1 },
  } as unknown as SceneObjectRender;
}
function child(index: number, id: string, parentId: string): SceneObjectRender {
  return {
    id, name: 'extrude', type: 'extrude', sceneShapes: [], ownShapes: [], visible: true, parentId,
    sourceLocation: { filePath: 'a.fluid.js', line: 100 + index, column: 1 },
  } as unknown as SceneObjectRender;
}

describe('timeline new-part focus', () => {
  it('collapses existing parts when a new part appears and keeps the new one open', () => {
    const h = mount();
    h.timeline.update([part(0, 'p1', 1), child(1, 'e1', 'p1')], 1);
    // First load: nothing collapses.
    expect(h.rowOf(1)).not.toBeNull();

    // Ids are re-minted; p1 survives by source location. p2 is new.
    h.timeline.update([
      part(0, 'p1b', 1), child(1, 'e1b', 'p1b'),
      part(2, 'p2', 10), child(3, 'e2', 'p2'),
    ], 3);
    expect(h.rowOf(1)).toBeNull();
    expect(h.chevronOf('p1b')!.querySelector('.rotate-90')).toBeNull();
    expect(h.rowOf(3)).not.toBeNull();
  });

  it('leaves collapse state alone when no part is new', () => {
    const h = mount();
    h.timeline.update([part(0, 'p1', 1), child(1, 'e1', 'p1'), part(2, 'p2', 10), child(3, 'e2', 'p2')], 3);
    h.timeline.update([part(0, 'p1', 1), child(1, 'e1', 'p1'), part(2, 'p2', 10), child(3, 'e2', 'p2'), child(4, 'e3', 'p2')], 4);
    expect(h.rowOf(1)).not.toBeNull();
    expect(h.rowOf(4)).not.toBeNull();
  });
});
