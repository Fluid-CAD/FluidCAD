import { describe, it, expect } from 'vitest';
import { Quaternion, Ray, Vector3 } from 'three';
import { GizmoDragSession, GizmoHandleId } from '../src/interactive/gizmo/gizmo-session';

function rayAt(origin: [number, number, number], dir: [number, number, number]): Ray {
  return new Ray(new Vector3(...origin), new Vector3(...dir).normalize());
}

/** Top-down ray hitting the z=0 plane at (x, y). */
function down(x: number, y: number): Ray {
  return rayAt([x, y, 10], [0, 0, -1]);
}

function makeSession(handle: GizmoHandleId, startRay: Ray, opts?: {
  origin?: Vector3;
  viewDir?: Vector3;
}): GizmoDragSession {
  return new GizmoDragSession({
    handle,
    origin: opts?.origin ?? new Vector3(0, 0, 0),
    orientation: new Quaternion(),
    startRay,
    viewDir: opts?.viewDir ?? new Vector3(0, 0, -1),
    downX: 100,
    downY: 100,
  });
}

describe('GizmoDragSession threshold', () => {
  it('stays pending under 4 px and promotes past it', () => {
    const session = makeSession('tx', down(5, 0));
    expect(session.update(down(5.1, 0), 102, 100, false)).toBeNull();
    expect(session.state).toBe('pending');
    const delta = session.update(down(8, 0), 105, 100, false);
    expect(session.state).toBe('dragging');
    expect(delta).not.toBeNull();
  });

  it('release without movement arms typing on arrows and rings only', () => {
    const arrow = makeSession('tx', down(5, 0));
    expect(arrow.release()).toEqual({ kind: 'typing' });
    expect(arrow.state).toBe('typing');

    const ring = makeSession('rz', down(1, 0));
    expect(ring.release()).toEqual({ kind: 'typing' });

    const center = makeSession('center', down(0, 0));
    expect(center.release()).toEqual({ kind: 'cancel' });

    const plane = makeSession('pxy', down(1, 1));
    expect(plane.release()).toEqual({ kind: 'cancel' });
  });
});

describe('GizmoDragSession axis drags', () => {
  it('measures the world-space delta along the axis from the start ray', () => {
    const session = makeSession('tx', down(5, 0));
    const delta = session.update(down(8, 3), 200, 200, false);
    expect(delta).toMatchObject({ kind: 'translate', handle: 'tx' });
    if (delta?.kind === 'translate') {
      expect(delta.delta.x).toBeCloseTo(3, 10);
      expect(delta.delta.y).toBeCloseTo(0, 10);
      expect(delta.delta.z).toBeCloseTo(0, 10);
    }
    expect(session.readoutValue).toBeCloseTo(3, 10);
  });

  it('deltas are relative to the gesture start, not compounding per move', () => {
    const session = makeSession('ty', down(0, 2));
    session.update(down(0, 6), 200, 200, false);
    const delta = session.update(down(0, 7), 210, 210, false);
    if (delta?.kind === 'translate') {
      expect(delta.delta.y).toBeCloseTo(5, 10);
    }
  });

  it('snaps to 1 mm with the modifier held', () => {
    const session = makeSession('tx', down(5, 0));
    const delta = session.update(down(7.6, 0), 200, 200, true);
    if (delta?.kind === 'translate') {
      expect(delta.delta.x).toBe(3);
    }
  });

  it('holds the last delta on a degenerate ray and recovers a lost start reference', () => {
    // Start ray parallel to the axis: no reference param yet.
    const session = makeSession('tx', rayAt([0, 5, 0], [1, 0, 0]));
    expect(session.update(rayAt([0, 5, 0], [1, 0, 0]), 200, 200, false)).toBeNull();
    // First resolvable ray establishes the reference…
    expect(session.update(down(2, 0), 210, 210, false)).toBeNull();
    // …and subsequent moves measure against it.
    const delta = session.update(down(6, 0), 220, 220, false);
    if (delta?.kind === 'translate') {
      expect(delta.delta.x).toBeCloseTo(4, 10);
    }
  });

  it('typedDelta produces an exact axis translation', () => {
    const session = makeSession('tz', down(0, 0.5));
    const delta = session.typedDelta(12.5);
    expect(delta).toMatchObject({ kind: 'translate', handle: 'tz' });
    if (delta?.kind === 'translate') {
      expect(delta.delta.z).toBeCloseTo(12.5, 10);
    }
  });
});

describe('GizmoDragSession plane drags', () => {
  it('measures the in-plane delta', () => {
    const session = makeSession('pxy', down(1, 1));
    const delta = session.update(down(4, 5), 200, 200, false);
    if (delta?.kind === 'translate') {
      expect(delta.delta.x).toBeCloseTo(3, 10);
      expect(delta.delta.y).toBeCloseTo(4, 10);
      expect(delta.delta.z).toBeCloseTo(0, 10);
    }
    expect(session.readoutValue).toBeCloseTo(5, 10);
  });

  it('typedDelta rescales the current drag direction to the typed length', () => {
    const session = makeSession('pxy', down(1, 1));
    session.update(down(4, 5), 200, 200, false);
    const delta = session.typedDelta(10);
    if (delta?.kind === 'translate') {
      expect(delta.delta.x).toBeCloseTo(6, 10);
      expect(delta.delta.y).toBeCloseTo(8, 10);
    }
  });

  it('typedDelta is null on a plane handle with no drag direction yet', () => {
    const session = makeSession('pxy', down(1, 1));
    expect(session.typedDelta(10)).toBeNull();
  });

  it('the center handle drags in the view plane', () => {
    const session = makeSession('center', down(0, 0), { viewDir: new Vector3(0, 0, -1) });
    const delta = session.update(down(3, -2), 200, 200, false);
    if (delta?.kind === 'translate') {
      expect(delta.delta.x).toBeCloseTo(3, 10);
      expect(delta.delta.y).toBeCloseTo(-2, 10);
      expect(delta.delta.z).toBeCloseTo(0, 10);
    }
  });
});

describe('GizmoDragSession ring drags', () => {
  it('accumulates signed degrees per the right-hand rule', () => {
    const session = makeSession('rz', down(1, 0));
    const delta = session.update(down(0, 1), 200, 200, false);
    expect(delta).toMatchObject({ kind: 'rotate', handle: 'rz' });
    if (delta?.kind === 'rotate') {
      expect(delta.degrees).toBeCloseTo(90, 8);
      expect(delta.axis.z).toBeCloseTo(1, 10);
    }
  });

  it('unwraps across the atan2 seam in both directions', () => {
    const ccw = makeSession('rz', down(1, 0));
    // 0° → 170° → -170° should read as +190, not -170.
    ccw.update(down(Math.cos(170 * Math.PI / 180), Math.sin(170 * Math.PI / 180)), 200, 200, false);
    const ccwDelta = ccw.update(
      down(Math.cos(190 * Math.PI / 180), Math.sin(190 * Math.PI / 180)), 210, 210, false,
    );
    if (ccwDelta?.kind === 'rotate') {
      expect(ccwDelta.degrees).toBeCloseTo(190, 8);
    }

    const cw = makeSession('rz', down(1, 0));
    cw.update(down(Math.cos(-170 * Math.PI / 180), Math.sin(-170 * Math.PI / 180)), 200, 200, false);
    const cwDelta = cw.update(
      down(Math.cos(-190 * Math.PI / 180), Math.sin(-190 * Math.PI / 180)), 210, 210, false,
    );
    if (cwDelta?.kind === 'rotate') {
      expect(cwDelta.degrees).toBeCloseTo(-190, 8);
    }
  });

  it('snaps to 5° with the modifier held', () => {
    const session = makeSession('rz', down(1, 0));
    const rad47 = 47 * Math.PI / 180;
    const delta = session.update(down(Math.cos(rad47), Math.sin(rad47)), 200, 200, true);
    if (delta?.kind === 'rotate') {
      expect(delta.degrees).toBe(45);
    }
  });

  it('typedDelta produces an exact rotation', () => {
    const session = makeSession('ry', rayAt([1, 10, 1], [0, -1, 0]));
    const delta = session.typedDelta(-30);
    expect(delta).toMatchObject({ kind: 'rotate', handle: 'ry' });
    if (delta?.kind === 'rotate') {
      expect(delta.degrees).toBe(-30);
      expect(delta.axis.y).toBeCloseTo(1, 10);
    }
  });
});

describe('GizmoDragSession release', () => {
  it('commits the last delta after a drag', () => {
    const session = makeSession('tx', down(5, 0));
    session.update(down(9, 0), 200, 200, false);
    const release = session.release();
    expect(release.kind).toBe('commit');
    if (release.kind === 'commit' && release.delta.kind === 'translate') {
      expect(release.delta.delta.x).toBeCloseTo(4, 10);
    }
  });

  it('cancels a drag that never produced a delta', () => {
    const session = makeSession('tx', rayAt([0, 5, 0], [1, 0, 0]));
    session.update(rayAt([0, 6, 0], [1, 0, 0]), 200, 200, false);
    // Promoted past the threshold but every ray was degenerate.
    expect(session.release()).toEqual({ kind: 'cancel' });
  });
});
