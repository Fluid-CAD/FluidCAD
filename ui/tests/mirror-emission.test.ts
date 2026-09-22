import { describe, it, expect } from 'vitest';
import {
  buildMirrorEmission, mirrorTargetsFor, reflectPoint, type MirrorTarget,
} from '../src/interactive/tools/mirror-emission';
import type { SolvedPick } from '../src/interactive/sketch-hover-select-handler';
import type { SolvedBezierView, SolvedEntityView, SolvedSketchModel } from '../src/sketch-solver-client/model';
import type { SceneObjectRender } from '../src/types';

// The constraint-native Mirror tool: reflected geometry statements plus
// symmetric(source, image, line) rows — one per entity, one per bezier
// control point — through the insert-solved rail.

function obj(id: string, line: number, uniqueType: string, guide = false): SceneObjectRender {
  return {
    id, uniqueType, sourceLocation: { line, column: 3, filePath: '/ws/m.fluid.js' },
    object: {}, ownShapes: [],
    sceneShapes: [{ shapeId: `s-${id}`, meshes: [], ...(guide ? { isGuide: true } : {}) }],
  } as unknown as SceneObjectRender;
}

function modelOf(views: SolvedEntityView[], beziers: SolvedBezierView[] = []): SolvedSketchModel {
  return {
    entities: new Map(views.map(v => [v.entityId, v])),
    beziers: new Map(beziers.map(b => [b.obj.id, b])),
    constraints: [], hasDatums: true, solver: null,
  } as unknown as SolvedSketchModel;
}

const lineView: SolvedEntityView = {
  entityId: 0, kind: 'line', obj: obj('l', 5, 'solved-line'), start: [10, 2], end: [30, 8],
};
const arcView: SolvedEntityView = {
  entityId: 1, kind: 'arc', obj: obj('a', 6, 'solved-arc'),
  start: [20, 0], end: [10, 10], center: [10, 0], cw: false,
};
const circleView: SolvedEntityView = {
  entityId: 2, kind: 'circle', obj: obj('c', 7, 'solved-circle'), center: [15, 15], radius: 4,
};
const axisView: SolvedEntityView = {
  entityId: 3, kind: 'line', obj: obj('g', 4, 'solved-line', true), start: [0, -10], end: [0, 50],
};
const guideLineView: SolvedEntityView = {
  entityId: 4, kind: 'line', obj: obj('h', 8, 'solved-line', true), start: [5, 5], end: [9, 5],
};

const edgePick = (v: SolvedEntityView): SolvedPick => ({
  entityId: v.entityId, kind: v.kind, sourceLocation: v.obj!.sourceLocation, shapeId: `s-${v.obj!.id}`,
});
const targets = (...picks: SolvedPick[]): MirrorTarget[] => picks.map(pick => ({ pick }));

// A three-point bezier at line 9: its first two control points are its own
// literal anchors (entities 10 and 11), the last rides the line's end.
const bezierObj = obj('bz', 9, 'bezier-3');
const bezierAnchor = (entityId: number, pointIndex: number, point: [number, number]): SolvedEntityView => ({
  entityId, kind: 'point', obj: bezierObj, point, anchor: { owner: 'bezier', pointIndex },
});
const bezierView: SolvedBezierView = {
  obj: bezierObj,
  points: [[0, 0], [5, 5], [999, 999]],
  sources: [{ entityId: 10, role: null }, { entityId: 11, role: null }, { entityId: 0, role: 'end' }],
};
const bezierModel = modelOf(
  [lineView, axisView, bezierAnchor(10, 0, [1, 2]), bezierAnchor(11, 1, [6, 4])],
  [bezierView],
);

describe('reflectPoint', () => {
  it('reflects across an arbitrary line', () => {
    expect(reflectPoint([3, 1], [0, 0], [1, 1]).map(v => Math.round(v * 1e9) / 1e9)).toEqual([1, 3]);
    expect(reflectPoint([10, 2], [0, -10], [0, 50])).toEqual([-10, 2]);
  });
});

describe('buildMirrorEmission', () => {
  const model = modelOf([lineView, arcView, circleView, axisView, guideLineView]);

  it('emits reflected statements + one symmetric per entity across a datum axis', () => {
    const plan = buildMirrorEmission({
      targets: targets(edgePick(lineView), edgePick(arcView), edgePick(circleView)),
      model,
      axis: { kind: 'datum', axis: 'y' },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.count).toBe(3);
    expect(plan.request.geometry).toEqual([
      { kind: 'line', text: 'line([-10, 2], [-30, 8])' },
      // The reflected arc sweeps the other way round.
      { kind: 'arc', text: 'arc([-20, 0], [-10, 10], [-10, 0]).cw()' },
      // circle() takes a diameter.
      { kind: 'circle', text: 'circle([-15, 15], 8)' },
    ]);
    expect(plan.request.constraints).toEqual([
      { kind: 'symmetric', targets: [{ line: 5, featureType: 'line' }, { newIndex: 0 }, { datum: 'y-axis' }] },
      { kind: 'symmetric', targets: [{ line: 6, featureType: 'arc' }, { newIndex: 1 }, { datum: 'y-axis' }] },
      { kind: 'symmetric', targets: [{ line: 7, featureType: 'circle' }, { newIndex: 2 }, { datum: 'y-axis' }] },
    ]);
    expect(plan.preview).toHaveLength(3);
  });

  it('mirrors across a picked sketched line and keeps a guide source a guide', () => {
    const plan = buildMirrorEmission({
      targets: targets(edgePick(guideLineView)),
      model,
      axis: { kind: 'pick', pick: edgePick(axisView) },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.request.geometry).toEqual([{ kind: 'line', text: 'line([-5, 5], [-9, 5])', guide: true }]);
    expect(plan.preview).toEqual(['line([-5, 5], [-9, 5]).guide()']);
    expect(plan.request.constraints[0].targets[2]).toEqual({ line: 4, featureType: 'line' });
  });

  it('ignores vertex picks and dedupes an entity picked twice', () => {
    const plan = buildMirrorEmission({
      targets: targets(edgePick(lineView), { ...edgePick(lineView), role: 'start' }, edgePick(lineView)),
      model,
      axis: { kind: 'datum', axis: 'x' },
    });
    expect(plan.ok && plan.count).toBe(1);
  });

  it('refuses the mirror line among the targets, a non-line axis, anchors and empty picks', () => {
    expect(buildMirrorEmission({
      targets: targets(edgePick(axisView)), model, axis: { kind: 'pick', pick: edgePick(axisView) },
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/across itself/) });
    expect(buildMirrorEmission({
      targets: targets(edgePick(lineView)), model, axis: { kind: 'pick', pick: edgePick(circleView) },
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/must be a sketched line/) });
    expect(buildMirrorEmission({
      targets: targets({ ...edgePick(lineView), anchor: { owner: 'text', pointIndex: 0 } }),
      model, axis: { kind: 'datum', axis: 'x' },
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/needs mirror\(\) in code/) });
    expect(buildMirrorEmission({
      targets: targets({ ...edgePick(lineView), role: 'end' }), model, axis: { kind: 'datum', axis: 'x' },
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/pick sketch edges/) });
  });

  it('mirrors a bezier as a reflected bezier() + one point-pair symmetric per control point', () => {
    const plan = buildMirrorEmission({
      targets: [{ bezier: bezierView }, { pick: edgePick(lineView) }],
      model: bezierModel,
      axis: { kind: 'pick', pick: edgePick(axisView) },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.count).toBe(2);
    // The control points are read LIVE off their solver entities (the
    // anchors' solved positions, the line's end) — never the payload
    // fallback — then reflected across the picked line x = 0.
    expect(plan.request.geometry).toEqual([
      { kind: 'bezier', text: 'bezier([-1, 2], [-6, 4], [-30, 8])' },
      { kind: 'line', text: 'line([-10, 2], [-30, 8])' },
    ]);
    expect(plan.preview).toEqual(['bezier([-1, 2], [-6, 4], [-30, 8])', 'line([-10, 2], [-30, 8])']);
    const axis = { line: 4, featureType: 'line' };
    expect(plan.request.constraints).toEqual([
      // Literal control points: the source bezier's own anchors …
      { kind: 'symmetric', targets: [{ line: 9, featureType: 'bezier', pointIndex: 0 }, { newIndex: 0, featureType: 'bezier', pointIndex: 0 }, axis] },
      { kind: 'symmetric', targets: [{ line: 9, featureType: 'bezier', pointIndex: 1 }, { newIndex: 0, featureType: 'bezier', pointIndex: 1 }, axis] },
      // … an accessor-valued one: the owner entity's point.
      { kind: 'symmetric', targets: [{ line: 5, featureType: 'line', role: 'end' }, { newIndex: 0, featureType: 'bezier', pointIndex: 2 }, axis] },
      { kind: 'symmetric', targets: [{ line: 5, featureType: 'line' }, { newIndex: 1 }, axis] },
    ]);
  });

  it('dedupes a bezier picked twice and refuses one with a control point of no solver identity or a single point', () => {
    const twice = buildMirrorEmission({
      targets: [{ bezier: bezierView }, { bezier: bezierView }],
      model: bezierModel,
      axis: { kind: 'datum', axis: 'x' },
    });
    expect(twice.ok && twice.count).toBe(1);

    const foreign: SolvedBezierView = { ...bezierView, sources: [bezierView.sources[0], null, bezierView.sources[2]] };
    expect(buildMirrorEmission({
      targets: [{ bezier: foreign }], model: bezierModel, axis: { kind: 'datum', axis: 'x' },
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/control point 2 .* no solver identity/) });

    const mid: SolvedBezierView = { ...bezierView, sources: [bezierView.sources[0], bezierView.sources[1], { entityId: 0, role: 'mid' }] };
    expect(buildMirrorEmission({
      targets: [{ bezier: mid }], model: bezierModel, axis: { kind: 'datum', axis: 'x' },
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/control point 3 .* midpoint/) });

    const single: SolvedBezierView = { obj: obj('bz1', 12, 'bezier-1'), points: [[3, 3]], sources: [null] };
    expect(buildMirrorEmission({
      targets: [{ bezier: single }], model: bezierModel, axis: { kind: 'datum', axis: 'x' },
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/single control point/) });
  });
});

describe('mirrorTargetsFor', () => {
  it('resolves shape ids in pick order to entity edge picks or bezier statements, naming the rest', () => {
    const picks = [
      { ...edgePick(lineView), role: 'start' as const },
      edgePick(lineView),
    ];
    const resolved = mirrorTargetsFor(['s-bz', 's-l', 's-offset-edge'], picks, bezierModel);
    expect(resolved.targets).toEqual([{ bezier: bezierView }, { pick: edgePick(lineView) }]);
    expect(resolved.unresolved).toEqual(['s-offset-edge']);
    // No model yet (sketch not rendered): a bezier cannot resolve.
    expect(mirrorTargetsFor(['s-bz'], picks, null)).toEqual({ targets: [], unresolved: ['s-bz'] });
  });
});
