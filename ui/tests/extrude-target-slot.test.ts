import { describe, expect, it } from 'vitest';
import { ExtrudeTargetSlot, type ExtrudeTargetState } from '../src/interactive/create-feature/extrude-target-slot';

// The target an extrude ghost ends on, resolved from the dialog's direction
// and face-slot state. The distance form carries nothing; the literal
// directions carry the literal; the picked direction carries an explicit
// face pick or draws nothing at all — a keep chip travels only once the
// sources query resolved it to a face on the rolled-back scene.

const face = { shapeId: 'solid-1', sub: { type: 'face' as const, index: 3 } };
const edge = { shapeId: 'solid-1', sub: { type: 'edge' as const, index: 3 } };

function state(overrides: Partial<ExtrudeTargetState> = {}): ExtrudeTargetState {
  return { literal: null, picking: false, picked: null, selection: null, kept: null, ...overrides };
}

describe('ExtrudeTargetSlot.ghostTarget', () => {
  it('carries nothing for the distance directions', () => {
    expect(ExtrudeTargetSlot.ghostTarget(state())).toEqual({});
    // A face picked in an earlier "Up to face" visit stays parked, unsent.
    expect(ExtrudeTargetSlot.ghostTarget(state({ picked: face, selection: { kind: 'picked' } }))).toEqual({});
  });

  it('carries the literal for the first/last-face directions, whatever the slot holds', () => {
    expect(ExtrudeTargetSlot.ghostTarget(state({ literal: 'first-face' }))).toEqual({ toFace: { kind: 'first-face' } });
    expect(ExtrudeTargetSlot.ghostTarget(state({ literal: 'last-face', picked: face, selection: { kind: 'picked' } })))
      .toEqual({ toFace: { kind: 'last-face' } });
  });

  it('carries the picked face on the picked direction', () => {
    expect(ExtrudeTargetSlot.ghostTarget(state({ picking: true, picked: face, selection: { kind: 'picked' } })))
      .toEqual({ toFace: { kind: 'face', shapeId: 'solid-1', index: 3 } });
  });

  it('draws nothing while the picked direction has no face yet', () => {
    expect(ExtrudeTargetSlot.ghostTarget(state({ picking: true }))).toBeNull();
  });

  it('resolves a kept chip to the statement\'s own face once the sources name it', () => {
    const kept = { kind: 'entities' as const, entities: [{ shapeId: 'rolled-back', sub: { type: 'face' as const, index: 1 } }] };
    expect(ExtrudeTargetSlot.ghostTarget(state({ picking: true, selection: { kind: 'keep' }, kept })))
      .toEqual({ toFace: { kind: 'face', shapeId: 'rolled-back', index: 1 } });
  });

  it('prefers a re-pick over the kept target', () => {
    const kept = { kind: 'entities' as const, entities: [{ shapeId: 'rolled-back', sub: { type: 'face' as const, index: 1 } }] };
    expect(ExtrudeTargetSlot.ghostTarget(state({ picking: true, picked: face, selection: { kind: 'picked' }, kept })))
      .toEqual({ toFace: { kind: 'face', shapeId: 'solid-1', index: 3 } });
  });

  it('draws nothing for a kept target the sources could not address', () => {
    expect(ExtrudeTargetSlot.ghostTarget(state({ picking: true, selection: { kind: 'keep' }, kept: { kind: 'opaque' } }))).toBeNull();
    // Still loading — the sources re-kick the preview when they land.
    expect(ExtrudeTargetSlot.ghostTarget(state({ picking: true, selection: { kind: 'keep' }, kept: null }))).toBeNull();
    // Only a single face stands in; anything else is an expression the ghost can't follow.
    const twoFaces = { kind: 'entities' as const, entities: [face, { ...face, sub: { type: 'face' as const, index: 4 } }] };
    expect(ExtrudeTargetSlot.ghostTarget(state({ picking: true, selection: { kind: 'keep' }, kept: twoFaces }))).toBeNull();
    const anEdge = { kind: 'entities' as const, entities: [edge] };
    expect(ExtrudeTargetSlot.ghostTarget(state({ picking: true, selection: { kind: 'keep' }, kept: anEdge }))).toBeNull();
  });

  it('ignores a kept target while the slot is not on its keep chip', () => {
    const kept = { kind: 'entities' as const, entities: [{ shapeId: 'rolled-back', sub: { type: 'face' as const, index: 1 } }] };
    expect(ExtrudeTargetSlot.ghostTarget(state({ picking: true, selection: null, kept }))).toBeNull();
  });
});
