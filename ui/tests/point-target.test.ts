import { describe, it, expect } from 'vitest';
import { pointTargetFor } from '../src/interactive/drag-move-handler/point-target';
import { DragHitResult } from '../src/interactive/drag-move-handler/types';

function hit(over: Partial<DragHitResult>): DragHitResult {
  return {
    sourceLocation: { line: 1, column: 0 },
    uniqueType: '',
    hitZone: 'body',
    ...over,
  } as DragHitResult;
}

describe('zone convention', () => {
  // The rule the whole double-click routing rests on: a body carries the
  // shape's own dimension, an endpoint/centre/corner carries coordinates.
  it.each([
    ['circle', 'body'],
    ['polygon', 'body'],
    ['hline', 'body'],
    ['vline', 'body'],
    ['tline', 'body'],
    ['aline', 'body'],
    ['aline', 'angle'],
  ] as const)('leaves %s %s to the dimension editor', (uniqueType, hitZone) => {
    expect(pointTargetFor(hit({ uniqueType, hitZone }))).toBeNull();
  });

  it.each([
    ['circle', 'center'],
    ['polygon', 'center'],
    // A rect's `start` is a plain point argument even though dragging a
    // corner resizes it through setRectDimensions.
    ['rect', 'start'],
  ] as const)('routes %s %s to its position argument', (uniqueType, hitZone) => {
    expect(pointTargetFor(hit({ uniqueType, hitZone })))
      .toEqual({ pointIndex: 0 });
  });

  it('leaves a rect corner drag zone to the dimension editor', () => {
    expect(pointTargetFor(hit({ uniqueType: 'rect', hitZone: 'end' }))).toBeNull();
    expect(pointTargetFor(hit({ uniqueType: 'rect', hitZone: 'body' }))).toBeNull();
  });
});

describe('pointTargetFor point zones', () => {
  it('maps a two-point line to its first and last point', () => {
    expect(pointTargetFor(hit({ uniqueType: 'line-two-points', hitZone: 'start' })))
      .toEqual({ pointIndex: 0 });
    expect(pointTargetFor(hit({ uniqueType: 'line-two-points', hitZone: 'end' })))
      .toEqual({ pointIndex: -1 });
  });

  it('distinguishes the tangent-arc variants by their endpoint index', () => {
    expect(pointTargetFor(hit({ uniqueType: 'tarc-to-point', hitZone: 'end' })))
      .toEqual({ pointIndex: 0 });
    expect(pointTargetFor(hit({ uniqueType: 'tarc-radius-to-point', hitZone: 'end' })))
      .toEqual({ pointIndex: 0 });
    expect(pointTargetFor(hit({ uniqueType: 'tarc-to-point-tangent', hitZone: 'end' })))
      .toEqual({ pointIndex: 1 });
  });

  it('maps a bezier pole to its own index', () => {
    expect(pointTargetFor(hit({ uniqueType: 'bezier-cubic', hitZone: 'end', bezierPoleIndex: 2 })))
      .toEqual({ pointIndex: 2 });
  });

  it('maps both slot cap centres only in the two-point form', () => {
    expect(pointTargetFor(hit({
      uniqueType: 'slot', hitZone: 'end', slotHasTwoPoints: true, slotPointIndex: 1,
    }))).toEqual({ pointIndex: 1 });

    // The one-point form's far cap encodes the distance, not a position.
    expect(pointTargetFor(hit({ uniqueType: 'slot', hitZone: 'end' }))).toBeNull();
    expect(pointTargetFor(hit({ uniqueType: 'slot', hitZone: 'start' })))
      .toEqual({ pointIndex: 0 });
  });
});

describe('pointTargetFor leaves 1-DOF endpoints to the dimension editor', () => {
  // These ends have no point argument at all — the position *is* the
  // segment's scalar, so H:/V:/T:/L: is the only thing there is to edit.
  it.each(['hline', 'vline', 'tline', 'aline'] as const)('declines a %s end', (uniqueType) => {
    expect(pointTargetFor(hit({ uniqueType, hitZone: 'end' }))).toBeNull();
  });

  // The explicit-start form's start *is* an argument, and hit detection only
  // reports that zone when it exists.
  it.each(['hline', 'vline', 'aline'] as const)('still edits an explicit %s start', (uniqueType) => {
    expect(pointTargetFor(hit({ uniqueType, hitZone: 'start' }))).toEqual({ pointIndex: 0 });
  });

  it('declines a tline start, which is never an argument', () => {
    expect(pointTargetFor(hit({ uniqueType: 'tline', hitZone: 'start' }))).toBeNull();
  });
});

describe('pointTargetFor declines coupled writes', () => {
  // An arc rewrites its centre and endpoint together, so it does not reduce
  // to one point argument.
  it.each([
    ['arc', 'start'],
    ['arc', 'end'],
    ['arc', 'center'],
  ] as const)('declines %s %s', (uniqueType, hitZone) => {
    expect(pointTargetFor(hit({ uniqueType, hitZone }))).toBeNull();
  });
});
