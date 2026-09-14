import { describe, it, expect } from 'vitest';
import { buildMirrorEmission, reflectPoint } from '../src/interactive/tools/mirror-emission';
import type { SolvedPick } from '../src/interactive/sketch-hover-select-handler';
import type { SolvedEntityView, SolvedSketchModel } from '../src/sketch-solver-client/model';
import type { SceneObjectRender } from '../src/types';

// The constraint-native Mirror tool: reflected geometry statements plus one
// symmetric(source, image, line) per entity, through the insert-solved rail.

function obj(id: string, line: number, uniqueType: string, guide = false): SceneObjectRender {
  return {
    id, uniqueType, sourceLocation: { line, column: 3, filePath: '/ws/m.fluid.js' },
    object: {}, ownShapes: [],
    sceneShapes: [{ shapeId: `s-${id}`, meshes: [], ...(guide ? { isGuide: true } : {}) }],
  } as unknown as SceneObjectRender;
}

function modelOf(views: SolvedEntityView[]): SolvedSketchModel {
  return {
    entities: new Map(views.map(v => [v.entityId, v])),
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
      picks: [edgePick(lineView), edgePick(arcView), edgePick(circleView)],
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
      picks: [edgePick(guideLineView)],
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
      picks: [edgePick(lineView), { ...edgePick(lineView), role: 'start' }, edgePick(lineView)],
      model,
      axis: { kind: 'datum', axis: 'x' },
    });
    expect(plan.ok && plan.count).toBe(1);
  });

  it('refuses the mirror line among the targets, a non-line axis, anchors and empty picks', () => {
    expect(buildMirrorEmission({
      picks: [edgePick(axisView)], model, axis: { kind: 'pick', pick: edgePick(axisView) },
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/across itself/) });
    expect(buildMirrorEmission({
      picks: [edgePick(lineView)], model, axis: { kind: 'pick', pick: edgePick(circleView) },
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/must be a sketched line/) });
    expect(buildMirrorEmission({
      picks: [{ ...edgePick(lineView), anchor: { owner: 'text', pointIndex: 0 } }],
      model, axis: { kind: 'datum', axis: 'x' },
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/needs mirror\(\) in code/) });
    expect(buildMirrorEmission({
      picks: [{ ...edgePick(lineView), role: 'end' }], model, axis: { kind: 'datum', axis: 'x' },
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/pick sketch edges/) });
  });
});
