import { describe, it, expect } from 'vitest';
import { buildDeletePlan, describeDependents } from '../src/interactive/tools/delete-plan';
import type { SceneObjectRender } from '../src/types';

// The Delete key's client-side plan: the statements the selected edges were
// drawn by, one per statement, the button label, and the refusals.

function sketchChild(
  id: string,
  type: string,
  line: number | null,
  shapeIds: string[],
  occurrence?: number,
): SceneObjectRender {
  return {
    id,
    type,
    parentId: 'sketch',
    sourceLocation: line === null
      ? undefined
      : { filePath: '/w/p.fluid.js', line, column: 3, ...(occurrence !== undefined ? { occurrence } : {}) },
    sceneShapes: shapeIds.map(shapeId => ({ shapeId })),
  } as unknown as SceneObjectRender;
}

const SCENE: SceneObjectRender[] = [
  sketchChild('l1', 'line', 5, ['s1']),
  sketchChild('c1', 'circle', 6, ['s2']),
  sketchChild('r1', 'rect', 7, ['s3', 's4', 's5', 's6']),
  sketchChild('t1', 'text', 8, ['s7', 's8']),
  sketchChild('loop', 'line', 9, ['s9'], 1),
  sketchChild('orphan', 'line', null, ['s10']),
];

describe('buildDeletePlan', () => {
  it('is null with nothing selected', () => {
    expect(buildDeletePlan([], SCENE)).toBeNull();
  });

  it('names a single statement by its type', () => {
    const plan = buildDeletePlan(['s2'], SCENE);
    expect(plan).toEqual({
      ok: true,
      targets: [{ line: 6, type: 'circle', sourceLocation: { filePath: '/w/p.fluid.js', line: 6, column: 3 } }],
      label: 'Delete the circle',
    });
  });

  it('folds the edges of one statement into one target, in source order', () => {
    const plan = buildDeletePlan(['s5', 's3', 's1', 's8'], SCENE);
    expect(plan && 'targets' in plan ? plan.targets.map(t => [t.line, t.type]) : null)
      .toEqual([[5, 'line'], [7, 'rect'], [8, 'text']]);
    expect(plan && 'label' in plan ? plan.label : null).toBe('Delete 3 entities');
  });

  it('reads an unknown type as itself', () => {
    const plan = buildDeletePlan(['s3'], SCENE);
    expect(plan && 'label' in plan ? plan.label : null).toBe('Delete the rectangle');
    const odd = buildDeletePlan(['s1'], [sketchChild('x', 'spline', 5, ['s1'])]);
    expect(odd && 'label' in odd ? odd.label : null).toBe('Delete the spline');
  });

  it('refuses a looped edge and an edge without a statement, whatever else is selected', () => {
    expect(buildDeletePlan(['s1', 's9'], SCENE)).toEqual({
      ok: false, reason: 'This edge is drawn by a loop — edit the source instead',
    });
    expect(buildDeletePlan(['s10'], SCENE)).toEqual({ ok: false, reason: 'This edge has no statement to delete' });
    expect(buildDeletePlan(['unknown'], SCENE)).toEqual({ ok: false, reason: 'This edge has no statement to delete' });
  });
});

describe('describeDependents', () => {
  it('names one swept statement, or counts several by kind', () => {
    expect(describeDependents([{ kind: 'mirror' }])).toBe('Also deleted the mirror that used it');
    expect(describeDependents([{ kind: 'copy' }, { kind: 'text' }, { kind: 'copy' }]))
      .toBe('Also deleted 3 statements that used it (copy, text)');
  });
});
