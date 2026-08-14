import { describe, it, expect } from 'vitest';
import { ActivePartTracker } from '../src/interactive/active-part-tracker';
import type { SceneObjectRender } from '../src/types';

const FILE = '/ws/model.fluid.js';

function partRow(name: string, line: number, over: Partial<SceneObjectRender> = {}): SceneObjectRender {
  return {
    id: `part-${name}`,
    name,
    type: 'part',
    sourceLocation: { filePath: FILE, line, column: 0 },
    ...over,
  } as SceneObjectRender;
}

function featureRow(name: string, line: number, parentId?: string): SceneObjectRender {
  return {
    id: `f-${name}-${line}`,
    name,
    type: 'extrude',
    parentId,
    sourceLocation: { filePath: FILE, line, column: 0 },
  } as SceneObjectRender;
}

describe('ActivePartTracker', () => {
  it('activates the last part on a fresh render with parts', () => {
    const tracker = new ActivePartTracker();
    const a = partRow('A', 3);
    const b = partRow('B', 8);
    tracker.sync([a, featureRow('E', 4, a.id), b]);
    expect(tracker.isActive(b)).toBe(true);
    expect(tracker.isActive(a)).toBe(false);
    expect(tracker.location).toEqual({ filePath: FILE, line: 8, column: 0 });
  });

  it('has no active part when the scene has none', () => {
    const tracker = new ActivePartTracker();
    tracker.sync([featureRow('E', 2)]);
    expect(tracker.location).toBeNull();
  });

  it('keeps the chosen part active across renders', () => {
    const tracker = new ActivePartTracker();
    const a = partRow('A', 3);
    const b = partRow('B', 8);
    tracker.sync([a, b]);
    tracker.activate(a);
    tracker.sync([a, b]);
    expect(tracker.isActive(a)).toBe(true);
    expect(tracker.isActive(b)).toBe(false);
  });

  it('re-activating the active part keeps it active (no toggle-off)', () => {
    const tracker = new ActivePartTracker();
    const a = partRow('A', 3);
    tracker.sync([a]);
    tracker.activate(a);
    tracker.activate(a);
    expect(tracker.isActive(a)).toBe(true);
  });

  it('re-resolves by name when an edit shifted the line', () => {
    const tracker = new ActivePartTracker();
    tracker.sync([partRow('A', 3), partRow('B', 8)]);
    tracker.activate(partRow('A', 3));
    const shiftedA = partRow('A', 5);
    tracker.sync([shiftedA, partRow('B', 10)]);
    expect(tracker.isActive(shiftedA)).toBe(true);
    expect(tracker.location?.line).toBe(5);
  });

  it('re-resolves by line when a rename changed the name', () => {
    const tracker = new ActivePartTracker();
    const a = partRow('A', 3);
    tracker.sync([a, partRow('B', 8)]);
    tracker.activate(a);
    const renamed = partRow('Bracket', 3);
    tracker.sync([renamed, partRow('B', 8)]);
    expect(tracker.isActive(renamed)).toBe(true);
  });

  it('falls back to the last part when the active one disappears', () => {
    const tracker = new ActivePartTracker();
    const a = partRow('A', 3);
    const b = partRow('B', 8);
    tracker.sync([a, b]);
    tracker.activate(a);
    tracker.sync([b]);
    expect(tracker.isActive(b)).toBe(true);
  });

  it('clears when every part leaves the scene', () => {
    const tracker = new ActivePartTracker();
    tracker.sync([partRow('A', 3)]);
    tracker.sync([featureRow('E', 2)]);
    expect(tracker.location).toBeNull();
  });

  it('activateLastOnNextRender adopts the newest part over the current one', () => {
    const tracker = new ActivePartTracker();
    const a = partRow('A', 3);
    tracker.sync([a]);
    tracker.activate(a);
    tracker.activateLastOnNextRender();
    const fresh = partRow('Part 1', 9);
    tracker.sync([a, fresh]);
    expect(tracker.isActive(fresh)).toBe(true);
    expect(tracker.isActive(a)).toBe(false);
  });

  it('clear() empties the assembly-scene state', () => {
    const tracker = new ActivePartTracker();
    tracker.sync([partRow('A', 3)]);
    tracker.clear();
    expect(tracker.location).toBeNull();
  });

  it('ignores child part rows and rows without a source location', () => {
    const tracker = new ActivePartTracker();
    const orphan = partRow('NoLoc', 3, { sourceLocation: undefined });
    const child = partRow('Child', 6, { parentId: 'other' });
    const real = partRow('Real', 4);
    tracker.sync([orphan, real, child]);
    expect(tracker.isActive(real)).toBe(true);
  });
});
