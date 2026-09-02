import { describe, it, expect } from 'vitest';
import { SketchSystem } from '../../lib/sketch-solver/index.js';
import type { SolvedEntityView, SolvedSketchModel } from '../src/sketch-solver-client';
import {
  parseEmittedGeometry,
  pendingEmissionOf,
  pruneRedundantInferred,
  type PendingEmission,
} from '../src/interactive/tools/emission-redundancy';
import {
  coincident,
  inferred,
  inferredOrtho,
  newTarget,
  type SolvedConstraintParam,
  type SolvedEmissionRequest,
} from '../src/interactive/tools/solved-emission';

// The redundancy trial that runs on every solved emission before the
// statement is written: inferred constraints (snap coincidents, auto-ortho
// H/V) that would not lower the sketch's DOF are dropped; explicit ones and
// anything the trial can't represent stay.

/** A read model over a kernel-side system: the snapshot plus entity views
 * whose statements sit at the given source lines. */
function modelOf(sys: SketchSystem, lines: Record<number, number>): SolvedSketchModel {
  const entities = new Map<number, SolvedEntityView>();
  for (const [entityId, line] of Object.entries(lines)) {
    const id = Number(entityId);
    entities.set(id, {
      entityId: id,
      kind: sys.entity(id).kind,
      obj: { sourceLocation: { filePath: 'a.fluid.js', line, column: 1 } } as unknown as SolvedEntityView['obj'],
    });
  }
  return { solver: sys.snapshot({ outcome: 'solved' }), entities } as unknown as SolvedSketchModel;
}

const lineRef = (line: number, role: 'start' | 'end') => ({ line, role, featureType: 'line' as const });

/** Fully constrained rectangle (H/V on every side, one fixed corner):
 * bottom @ line 10, right @ 11, top @ 12, left @ 13. */
function rectangle(): { sys: SketchSystem; ids: Record<string, number> } {
  const sys = new SketchSystem();
  sys.ensureDatums();
  const bottom = sys.line(0, 0, 100, 0);
  const right = sys.line(100, 0, 100, 50);
  const top = sys.line(100, 50, 0, 50);
  const left = sys.line(0, 50, 0, 0);
  const chain: [number, number][] = [[bottom, right], [right, top], [top, left], [left, bottom]];
  for (const [u, v] of chain) {
    sys.constrain({ kind: 'coincident', a: { entity: u, point: 'end' }, b: { entity: v, point: 'start' } });
  }
  sys.constrain({ kind: 'horizontal', a: { entity: bottom } });
  sys.constrain({ kind: 'horizontal', a: { entity: top } });
  sys.constrain({ kind: 'vertical', a: { entity: right } });
  sys.constrain({ kind: 'vertical', a: { entity: left } });
  sys.constrain({ kind: 'fix', p: { entity: bottom, point: 'start' } });
  return { sys, ids: { bottom, right, top, left } };
}

const RECT_LINES = (ids: Record<string, number>) => ({
  [ids.bottom]: 10, [ids.right]: 11, [ids.top]: 12, [ids.left]: 13,
});

const kinds = (cs: SolvedConstraintParam[]) => cs.map(c => c.kind);

describe('pruneRedundantInferred: the vertical between two stacked vertices', () => {
  // The reported case: a vertical drawn between two existing vertices the
  // sketch already stacks (here the rectangle's bottom-left and top-left
  // corners) emitted two coincidents AND a vertical — the vertical is a
  // redundant row.
  const request = (): SolvedEmissionRequest => ({
    geometry: [{ kind: 'line', text: 'line([0, 0], [0, 50])' }],
    constraints: [
      inferred(coincident(newTarget(0, 'start'), lineRef(10, 'start'))),
      inferred(coincident(newTarget(0, 'end'), lineRef(12, 'end'))),
      inferredOrtho('vertical'),
    ],
  });

  it('keeps both snap coincidents and drops the vertical', () => {
    const { sys, ids } = rectangle();
    const { constraints, dropped } = pruneRedundantInferred(modelOf(sys, RECT_LINES(ids)), request());
    expect(kinds(constraints)).toEqual(['coincident', 'coincident']);
    expect(kinds(dropped)).toEqual(['vertical']);
  });

  it('strips the inferred mark from what it keeps', () => {
    const { sys, ids } = rectangle();
    const { constraints } = pruneRedundantInferred(modelOf(sys, RECT_LINES(ids)), request());
    expect(constraints.every(c => !('inferred' in c))).toBe(true);
    expect(constraints[0]).toEqual(coincident(newTarget(0, 'start'), lineRef(10, 'start')));
  });

  it('tests the coincidents before the ortho row whatever the emission order', () => {
    const { sys, ids } = rectangle();
    const req = request();
    req.constraints.reverse();
    const { constraints, dropped } = pruneRedundantInferred(modelOf(sys, RECT_LINES(ids)), req);
    expect(kinds(constraints)).toEqual(['coincident', 'coincident']);
    expect(kinds(dropped)).toEqual(['vertical']);
  });

  it('keeps the vertical when the two vertices are NOT constrained to stack', () => {
    // Two unrelated free lines whose endpoints merely happen to align.
    const sys = new SketchSystem();
    sys.ensureDatums();
    const a = sys.line(0, 0, 30, 0);
    const b = sys.line(0, 50, 30, 50);
    const model = modelOf(sys, { [a]: 10, [b]: 12 });
    const { constraints, dropped } = pruneRedundantInferred(model, {
      geometry: [{ kind: 'line', text: 'line([0, 0], [0, 50])' }],
      constraints: [
        inferred(coincident(newTarget(0, 'start'), lineRef(10, 'start'))),
        inferred(coincident(newTarget(0, 'end'), lineRef(12, 'start'))),
        inferredOrtho('vertical'),
      ],
    });
    expect(kinds(constraints)).toEqual(['coincident', 'coincident', 'vertical']);
    expect(dropped).toEqual([]);
  });

  it('never drops an explicit vertical, redundant or not', () => {
    const { sys, ids } = rectangle();
    const req = request();
    req.constraints[2] = { kind: 'vertical', targets: [newTarget(0)] };
    const { constraints, dropped } = pruneRedundantInferred(modelOf(sys, RECT_LINES(ids)), req);
    expect(kinds(constraints)).toEqual(['coincident', 'coincident', 'vertical']);
    expect(dropped).toEqual([]);
  });
});

describe('pruneRedundantInferred: a polyline closing a rectangle', () => {
  // Three chained segments (H, V, H) exist; the closing fourth segment's
  // vertical is NOT redundant even though both its endpoints land on
  // existing vertices — nothing else stacks the two left corners.
  it('keeps the closing vertical', () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    const s1 = sys.line(0, 0, 100, 0);
    const s2 = sys.line(100, 0, 100, 50);
    const s3 = sys.line(100, 50, 0, 50);
    sys.constrain({ kind: 'coincident', a: { entity: s1, point: 'end' }, b: { entity: s2, point: 'start' } });
    sys.constrain({ kind: 'coincident', a: { entity: s2, point: 'end' }, b: { entity: s3, point: 'start' } });
    sys.constrain({ kind: 'horizontal', a: { entity: s1 } });
    sys.constrain({ kind: 'vertical', a: { entity: s2 } });
    sys.constrain({ kind: 'horizontal', a: { entity: s3 } });
    const model = modelOf(sys, { [s1]: 10, [s2]: 11, [s3]: 12 });
    const { constraints, dropped } = pruneRedundantInferred(model, {
      geometry: [{ kind: 'line', text: 'line([0, 50], [0, 0])' }],
      constraints: [
        // The chain junction is the gesture itself — explicit.
        coincident(newTarget(0, 'start'), lineRef(12, 'end')),
        inferredOrtho('vertical'),
        inferred(coincident(newTarget(0, 'end'), lineRef(10, 'start'))),
      ],
    });
    expect(kinds(constraints)).toEqual(['coincident', 'vertical', 'coincident']);
    expect(dropped).toEqual([]);
  });
});

describe('pruneRedundantInferred: axis datums', () => {
  function empty(): SolvedSketchModel {
    const sys = new SketchSystem();
    sys.ensureDatums();
    return modelOf(sys, {});
  }

  it('drops the H implied by both endpoints pinned onto the x axis', () => {
    const { constraints, dropped } = pruneRedundantInferred(empty(), {
      geometry: [{ kind: 'line', text: 'line([0, 0], [40, 0])' }],
      constraints: [
        inferred(coincident(newTarget(0, 'start'), { datum: 'x-axis' })),
        inferred(coincident(newTarget(0, 'end'), { datum: 'x-axis' })),
        inferredOrtho('horizontal'),
      ],
    });
    expect(kinds(constraints)).toEqual(['coincident', 'coincident']);
    expect(kinds(dropped)).toEqual(['horizontal']);
  });

  it('drops the V implied by the origin and a y-axis pin — mixed datums', () => {
    // The old structural rule only knew "same axis on both ends".
    const { constraints, dropped } = pruneRedundantInferred(empty(), {
      geometry: [{ kind: 'line', text: 'line([0, 0], [0, 40])' }],
      constraints: [
        inferred(coincident(newTarget(0, 'start'), { datum: 'origin' })),
        inferred(coincident(newTarget(0, 'end'), { datum: 'y-axis' })),
        inferredOrtho('vertical'),
      ],
    });
    expect(kinds(constraints)).toEqual(['coincident', 'coincident']);
    expect(kinds(dropped)).toEqual(['vertical']);
  });

  it('keeps the H when only one endpoint sits on the axis', () => {
    const { constraints, dropped } = pruneRedundantInferred(empty(), {
      geometry: [{ kind: 'line', text: 'line([0, 0], [40, 0])' }],
      constraints: [
        inferred(coincident(newTarget(0, 'end'), { datum: 'x-axis' })),
        inferredOrtho('horizontal'),
      ],
    });
    expect(kinds(constraints)).toEqual(['coincident', 'horizontal']);
    expect(dropped).toEqual([]);
  });

  it('drops the H when the start vertex is itself constrained onto the axis', () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    const a = sys.line(-30, 0, -30, 20);
    sys.constrain({ kind: 'coincident', a: { entity: a, point: 'start' }, b: { entity: -2 } });
    const model = modelOf(sys, { [a]: 10 });
    const { constraints, dropped } = pruneRedundantInferred(model, {
      geometry: [{ kind: 'line', text: 'line([-30, 0], [40, 0])' }],
      constraints: [
        inferred(coincident(newTarget(0, 'start'), lineRef(10, 'start'))),
        inferred(coincident(newTarget(0, 'end'), { datum: 'x-axis' })),
        inferredOrtho('horizontal'),
      ],
    });
    expect(kinds(constraints)).toEqual(['coincident', 'coincident']);
    expect(kinds(dropped)).toEqual(['horizontal']);
  });
});

describe('pruneRedundantInferred: conservative fallbacks', () => {
  it('keeps everything when a target statement is not rendered', () => {
    const { sys, ids } = rectangle();
    const { constraints, dropped } = pruneRedundantInferred(modelOf(sys, RECT_LINES(ids)), {
      geometry: [{ kind: 'line', text: 'line([0, 0], [0, 50])' }],
      constraints: [
        inferred(coincident(newTarget(0, 'start'), lineRef(10, 'start'))),
        // Line 99 is nowhere in the model (its render hasn't arrived).
        inferred(coincident(newTarget(0, 'end'), lineRef(99, 'end'))),
        inferredOrtho('vertical'),
      ],
    });
    expect(kinds(constraints)).toEqual(['coincident', 'coincident', 'vertical']);
    expect(dropped).toEqual([]);
  });

  it('keeps everything when the geometry text carries a typed expression', () => {
    const { sys, ids } = rectangle();
    const { constraints, dropped } = pruneRedundantInferred(modelOf(sys, RECT_LINES(ids)), {
      geometry: [{ kind: 'line', text: 'line([x0, 0], [x0, h])' }],
      constraints: [
        inferred(coincident(newTarget(0, 'start'), lineRef(10, 'start'))),
        inferred(coincident(newTarget(0, 'end'), lineRef(12, 'end'))),
        inferredOrtho('vertical'),
      ],
    });
    expect(kinds(constraints)).toEqual(['coincident', 'coincident', 'vertical']);
    expect(constraints.every(c => !('inferred' in c))).toBe(true);
    expect(dropped).toEqual([]);
  });

  it('is a no-op without a solver snapshot or without inferred rows', () => {
    const req: SolvedEmissionRequest = {
      geometry: [{ kind: 'line', text: 'line([0, 0], [0, 50])' }],
      constraints: [inferredOrtho('vertical')],
    };
    expect(pruneRedundantInferred(null, req).constraints).toEqual([{ kind: 'vertical', targets: [newTarget(0)] }]);
    const { sys, ids } = rectangle();
    const explicitOnly: SolvedEmissionRequest = {
      geometry: req.geometry,
      constraints: [{ kind: 'vertical', targets: [newTarget(0)] }],
    };
    expect(pruneRedundantInferred(modelOf(sys, RECT_LINES(ids)), explicitOnly).constraints)
      .toEqual(explicitOnly.constraints);
  });
});

describe('pruneRedundantInferred: pending emissions', () => {
  // A rapid chain: the previous segment (a vertical from the origin) has
  // been written but not rendered — it lives only in the pending record.
  const pendingVertical: PendingEmission = {
    geometry: [{ line: 30, kind: 'line', params: [0, 0, 0, 50] }],
    constraints: [
      coincident({ line: 30, role: 'start', featureType: 'line' }, { datum: 'origin' }),
      { kind: 'vertical', targets: [{ line: 30, featureType: 'line' }] },
    ],
  };
  const request = (): SolvedEmissionRequest => ({
    geometry: [{ kind: 'line', text: 'line([0, 50], [0, 80])' }],
    constraints: [
      coincident(newTarget(0, 'start'), lineRef(30, 'end')),
      inferred(coincident(newTarget(0, 'end'), { datum: 'y-axis' })),
      inferredOrtho('vertical'),
    ],
  });

  it('resolves targets against the pending geometry and drops the implied vertical', () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    const { constraints, dropped } = pruneRedundantInferred(modelOf(sys, {}), request(), [pendingVertical]);
    expect(kinds(constraints)).toEqual(['coincident', 'coincident']);
    expect(kinds(dropped)).toEqual(['vertical']);
  });

  it('without the pending record the junction is unresolvable and the vertical stays', () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    const { constraints } = pruneRedundantInferred(modelOf(sys, {}), request(), []);
    expect(kinds(constraints)).toEqual(['coincident', 'coincident', 'vertical']);
  });
});

describe('pendingEmissionOf', () => {
  it('keys parsed geometry by the reported lines and re-addresses newIndex targets', () => {
    const pending = pendingEmissionOf({
      geometry: [
        { kind: 'line', text: 'line([0, 0], [40, 0])' },
        { kind: 'arc', text: 'arc([40, 0], [50, 10], [40, 10]).cw()' },
      ],
      constraints: [
        coincident(newTarget(0, 'end'), newTarget(1, 'start')),
        { kind: 'tangent', targets: [newTarget(0), newTarget(1)] },
        coincident(newTarget(0, 'start'), { datum: 'origin' }),
      ],
    }, [21, 22]);
    expect(pending.geometry).toEqual([
      { line: 21, kind: 'line', params: [0, 0, 40, 0] },
      { line: 22, kind: 'arc', params: [40, 10, 10, 40, 0, 50, 10] },
    ]);
    expect(pending.constraints).toEqual([
      coincident({ line: 21, featureType: 'line', role: 'end' }, { line: 22, featureType: 'arc', role: 'start' }),
      { kind: 'tangent', targets: [{ line: 21, featureType: 'line' }, { line: 22, featureType: 'arc' }] },
      coincident({ line: 21, featureType: 'line', role: 'start' }, { datum: 'origin' }),
    ]);
  });

  it('leaves out geometry it cannot read', () => {
    const pending = pendingEmissionOf({
      geometry: [{ kind: 'line', text: 'line([w, 0], [w, 10])' }],
      constraints: [],
    }, [21]);
    expect(pending.geometry).toEqual([]);
  });
});

describe('parseEmittedGeometry', () => {
  it('reads the four statement forms back into solver params', () => {
    expect(parseEmittedGeometry('line', 'line([0, 0], [40.5, -2])')).toEqual([0, 0, 40.5, -2]);
    expect(parseEmittedGeometry('point', 'point([3, 4])')).toEqual([3, 4]);
    expect(parseEmittedGeometry('circle', 'circle([1, 2], 30)')).toEqual([1, 2, 15]);
    expect(parseEmittedGeometry('arc', 'arc([10, 0], [0, 10], [0, 0])')).toEqual([0, 0, 10, 10, 0, 0, 10]);
    expect(parseEmittedGeometry('arc', 'arc([10, 0], [0, 10], [0, 0]).cw()')).toEqual([0, 0, 10, 10, 0, 0, 10]);
  });

  it('refuses typed expressions, wrong callees and malformed args', () => {
    expect(parseEmittedGeometry('line', 'line([w / 2, 0], [40, 0])')).toBeNull();
    expect(parseEmittedGeometry('circle', 'circle([0, 0], d)')).toBeNull();
    expect(parseEmittedGeometry('line', 'arc([0, 0], [1, 1], [0, 1])')).toBeNull();
    expect(parseEmittedGeometry('line', 'line([0, 0])')).toBeNull();
    expect(parseEmittedGeometry('circle', 'circle([0, 0], -3)')).toBeNull();
  });
});
