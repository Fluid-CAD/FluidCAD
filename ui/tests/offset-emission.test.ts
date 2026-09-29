import { describe, it, expect } from 'vitest';
import { buildOffsetEmission, offsetNeedsStatement, offsetSourcePicks } from '../src/interactive/tools/offset-emission';
import type { SketchOffsetPlanChain } from '../src/api';
import type { SolvedPick } from '../src/interactive/sketch-hover-select-handler';
import type { SolvedEntityView, SolvedSketchModel } from '../src/sketch-solver-client/model';

// Constraint-native offset: the server's OCCT plan becomes primitives + ONE
// offsetFrom statement pairing each with its source + a coincident per sharp
// corner; tangent junctions and open ends get none; Close-ends caps are pinned
// to the source ends the chain actually touches.

type V2 = [number, number];

function lineView(entityId: number, line: number, start: V2, end: V2): SolvedEntityView {
  return {
    entityId, kind: 'line', start, end,
    obj: { sourceLocation: { filePath: '/w/p.fluid.js', line, column: 3 } },
  } as unknown as SolvedEntityView;
}

function arcView(entityId: number, line: number, start: V2, end: V2, center: V2, radius: number): SolvedEntityView {
  return {
    entityId, kind: 'arc', start, end, center, radius, cw: false,
    obj: { sourceLocation: { filePath: '/w/p.fluid.js', line, column: 3 } },
  } as unknown as SolvedEntityView;
}

function makeModel(entities: SolvedEntityView[]): SolvedSketchModel {
  return { entities: new Map(entities.map(e => [e.entityId, e])), constraints: [] } as unknown as SolvedSketchModel;
}

function edgePick(view: SolvedEntityView): SolvedPick {
  return {
    entityId: view.entityId,
    kind: view.kind as 'line' | 'arc',
    shapeId: `shape-${view.entityId}`,
    sourceLocation: (view.obj as { sourceLocation: SolvedPick['sourceLocation'] }).sourceLocation,
  };
}

describe('offsetSourcePicks', () => {
  it('keeps edge picks in order, drops vertex/datum picks, refuses curves the tie cannot hold', () => {
    const a = lineView(1, 5, [0, 0], [40, 0]);
    const b = lineView(2, 6, [40, 0], [40, 30]);
    const picks: SolvedPick[] = [
      edgePick(a),
      { entityId: 1, kind: 'line', role: 'end', shapeId: 'v' },
      { entityId: -1, kind: 'point', datum: 'origin' },
      edgePick(b),
      edgePick(a),
    ];
    const result = offsetSourcePicks(picks);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.picks.map(p => p.entityId)).toEqual([1, 2]);
    }
    const ellipse = offsetSourcePicks([{ entityId: 3, kind: 'ellipse', shapeId: 'e', sourceLocation: { filePath: '/w/p.fluid.js', line: 9, column: 1 } }]);
    expect(ellipse.ok).toBe(false);
    expect(!ellipse.ok && ellipse.reason).toMatch(/ellipse cannot be offset as constrained geometry/);
    expect(offsetSourcePicks([]).ok).toBe(false);
  });
});

describe('offsetNeedsStatement', () => {
  it('is true only for an edge pick of a bezier or an ellipse — not for their points, nor for other kinds', () => {
    const a = lineView(1, 5, [0, 0], [40, 0]);
    const at = { filePath: '/w/p.fluid.js', line: 9, column: 1 };
    expect(offsetNeedsStatement([edgePick(a)])).toBe(false);
    expect(offsetNeedsStatement([])).toBe(false);
    expect(offsetNeedsStatement([edgePick(a), { entityId: 3, kind: 'ellipse', shapeId: 'e', sourceLocation: at }])).toBe(true);
    // A bezier edge resolves to a control-point anchor pick that carries the edge's shapeId.
    const bezierEdge: SolvedPick = { entityId: 4, kind: 'point', anchor: { owner: 'bezier', pointIndex: 0 }, shapeId: 'b', sourceLocation: at };
    expect(offsetNeedsStatement([bezierEdge])).toBe(true);
    // An ellipse's center or a bezier control point is a vertex pick (role set), never an edge.
    expect(offsetNeedsStatement([{ entityId: 3, kind: 'ellipse', role: 'center' }])).toBe(false);
    expect(offsetNeedsStatement([{ entityId: 4, kind: 'point', role: null, anchor: { owner: 'bezier', pointIndex: 1 } }])).toBe(false);
    // A text outline edge stays on the constrained rail, where it is refused.
    expect(offsetNeedsStatement([{ entityId: 5, kind: 'point', anchor: { owner: 'text', pointIndex: 0 }, shapeId: 't' }])).toBe(false);
  });
});

describe('buildOffsetEmission', () => {
  it('square chain: four lines, one offsetFrom pairing them with the picks, four corner coincidents', () => {
    const a = lineView(1, 5, [0, 0], [40, 0]);
    const b = lineView(2, 6, [40, 0], [40, 30]);
    const c = lineView(3, 7, [40, 30], [0, 30]);
    const d = lineView(4, 8, [0, 30], [0, 0]);
    const sources = [a, b, c, d].map(edgePick);
    const chains: SketchOffsetPlanChain[] = [{
      closed: true,
      edges: [
        { kind: 'line', source: 0, start: [-3, -3], end: [43, -3], joinNext: 'corner' },
        { kind: 'line', source: 1, start: [43, -3], end: [43, 33], joinNext: 'corner' },
        { kind: 'line', source: 2, start: [43, 33], end: [-3, 33], joinNext: 'corner' },
        { kind: 'line', source: 3, start: [-3, 33], end: [-3, -3], joinNext: 'corner' },
      ],
    }];
    const plan = buildOffsetEmission({ sources, chains, model: makeModel([a, b, c, d]), distanceExpr: '3' });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.edges).toBe(4);
    expect(plan.corners).toBe(4);
    expect(plan.request.geometry.map(g => g.text)).toEqual([
      'line([-3, -3], [43, -3])',
      'line([43, -3], [43, 33])',
      'line([43, 33], [-3, 33])',
      'line([-3, 33], [-3, -3])',
    ]);
    const [tie, ...corners] = plan.request.constraints;
    expect(tie.kind).toBe('offsetFrom');
    expect(tie.valueExpr).toBe('3');
    expect(tie.targets).toEqual([
      { newIndex: 0 }, { newIndex: 1 }, { newIndex: 2 }, { newIndex: 3 },
      { line: 5, featureType: 'line' }, { line: 6, featureType: 'line' },
      { line: 7, featureType: 'line' }, { line: 8, featureType: 'line' },
    ]);
    expect(corners).toEqual([
      { kind: 'coincident', targets: [{ newIndex: 0, role: 'end' }, { newIndex: 1, role: 'start' }] },
      { kind: 'coincident', targets: [{ newIndex: 1, role: 'end' }, { newIndex: 2, role: 'start' }] },
      { kind: 'coincident', targets: [{ newIndex: 2, role: 'end' }, { newIndex: 3, role: 'start' }] },
      { kind: 'coincident', targets: [{ newIndex: 3, role: 'end' }, { newIndex: 0, role: 'start' }] },
    ]);
  });

  it('tangent junctions get no coincident; arcs keep their sweep flag', () => {
    const l = lineView(1, 5, [5, 0], [35, 0]);
    const a = arcView(2, 6, [35, 0], [40, 5], [35, 5], 5);
    const sources = [l, a].map(edgePick);
    const chains: SketchOffsetPlanChain[] = [{
      closed: false,
      edges: [
        { kind: 'line', source: 0, start: [5, -3], end: [35, -3], joinNext: 'tangent' },
        { kind: 'arc', source: 1, start: [35, -3], end: [43, 5], center: [35, 5], radius: 8, cw: false, joinNext: null },
      ],
    }];
    const plan = buildOffsetEmission({ sources, chains, model: makeModel([l, a]), distanceExpr: 'w' });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.corners).toBe(0);
    expect(plan.request.geometry.map(g => g.text)).toEqual([
      'line([5, -3], [35, -3])',
      'arc([35, -3], [43, 5], [35, 5])',
    ]);
    expect(plan.request.constraints).toHaveLength(1);
    expect(plan.request.constraints[0].valueExpr).toBe('w');
    const cw = buildOffsetEmission({
      sources, model: makeModel([l, a]), distanceExpr: '3',
      chains: [{ closed: false, edges: [{ kind: 'arc', source: 1, start: [43, 5], end: [35, -3], center: [35, 5], radius: 8, cw: true, joinNext: null }] }],
    });
    expect(cw.ok && cw.request.geometry[0].text).toBe('arc([43, 5], [35, -3], [35, 5]).cw()');
  });

  it('close-ends caps pin to the source ends the chain touches, even on a statement walked backwards', () => {
    // b is drawn from (40, 30) down to (40, 0): the chain walks it backwards.
    const a = lineView(1, 5, [0, 0], [40, 0]);
    const b = lineView(2, 6, [40, 30], [40, 0]);
    const sources = [a, b].map(edgePick);
    const chains: SketchOffsetPlanChain[] = [{
      closed: false,
      edges: [
        { kind: 'line', source: 0, start: [0, -3], end: [43, -3], joinNext: 'corner' },
        { kind: 'line', source: 1, start: [43, -3], end: [43, 30], joinNext: null },
      ],
      caps: [
        { start: [40, 30], end: [43, 30] },
        { start: [0, -3], end: [0, 0] },
      ],
    }];
    const plan = buildOffsetEmission({ sources, chains, model: makeModel([a, b]), distanceExpr: '3' });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.request.geometry.map(g => g.text)).toEqual([
      'line([0, -3], [43, -3])',
      'line([43, -3], [43, 30])',
      'line([40, 30], [43, 30])',
      'line([0, -3], [0, 0])',
    ]);
    const caps = plan.request.constraints.slice(2);
    expect(caps).toEqual([
      // The end cap starts on b's START (b runs top → bottom).
      { kind: 'coincident', targets: [{ newIndex: 2, role: 'start' }, { line: 6, featureType: 'line', role: 'start' }] },
      { kind: 'coincident', targets: [{ newIndex: 2, role: 'end' }, { newIndex: 1, role: 'end' }] },
      { kind: 'coincident', targets: [{ newIndex: 3, role: 'start' }, { newIndex: 0, role: 'start' }] },
      { kind: 'coincident', targets: [{ newIndex: 3, role: 'end' }, { line: 5, featureType: 'line', role: 'start' }] },
    ]);
  });

  it('circles emit a circle statement with the plan radius as its diameter', () => {
    const c = { entityId: 1, kind: 'circle', center: [10, 10], radius: 8, obj: { sourceLocation: { filePath: '/w/p.fluid.js', line: 5, column: 3 } } } as unknown as SolvedEntityView;
    const plan = buildOffsetEmission({
      sources: [{ entityId: 1, kind: 'circle', shapeId: 's', sourceLocation: { filePath: '/w/p.fluid.js', line: 5, column: 3 } }],
      chains: [{ closed: true, edges: [{ kind: 'circle', source: 0, center: [10, 10], radius: 10.5, joinNext: null }] }],
      model: makeModel([c]),
      distanceExpr: '2.5',
    });
    expect(plan.ok && plan.request.geometry[0].text).toBe('circle([10, 10], 21)');
    expect(plan.ok && plan.request.constraints[0].targets).toEqual([{ newIndex: 0 }, { line: 5, featureType: 'circle' }]);
  });

  it('refuses a plan that no longer matches the picks', () => {
    const a = lineView(1, 5, [0, 0], [40, 0]);
    const plan = buildOffsetEmission({
      sources: [edgePick(a)],
      chains: [{ closed: false, edges: [{ kind: 'line', source: 3, start: [0, 3], end: [40, 3], joinNext: null }] }],
      model: makeModel([a]),
      distanceExpr: '3',
    });
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.reason).toMatch(/pick the edges again/);
  });
});
