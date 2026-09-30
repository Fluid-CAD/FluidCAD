import { describe, expect, it } from 'vitest';
import { OrthographicCamera } from 'three';
import type { ConnectorAnchorCandidate } from '../src/api';
import { nearestAnchorIndex } from '../src/interactive/create-feature/anchor-suggestions';

// Which anchor the hover rail (Connector tool and Hole dialog alike) floats
// for the cursor: the one whose hover point projects nearest.

/** Looking down -Z at a 100×100 viewport: world (x, y) lands at screen (x + 50, 50 - y). */
function topCamera(): OrthographicCamera {
  const camera = new OrthographicCamera(-50, 50, 50, -50, 0.1, 1000);
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

const RECT = { left: 0, top: 0, width: 100, height: 100 };

function candidate(
  kind: 'center' | 'start' | 'end',
  origin: { x: number; y: number },
  hoverPoint?: { x: number; y: number },
): ConnectorAnchorCandidate {
  const up = { x: 0, y: 0, z: 1 };
  return {
    anchor: { kind },
    suffix: `.${kind}()`,
    frame: { origin: { ...origin, z: 0 }, xDirection: { x: 1, y: 0, z: 0 }, yDirection: { x: 0, y: 1, z: 0 }, normal: up },
    hoverPoint: hoverPoint ? { ...hoverPoint, z: 0 } : undefined,
  };
}

/** The screen position of the point `deg` degrees along a radius-20 arc around the origin. */
function onArc(deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return { x: 50 + 20 * Math.cos(rad), y: 50 - 20 * Math.sin(rad) };
}

describe('anchor suggestion nearest pick', () => {
  const r = 20;
  const mid = { x: r * Math.SQRT1_2, y: r * Math.SQRT1_2 };
  // A quarter arc from (20, 0) to (0, 20): its center() frame sits at the
  // circle center, a radius off the arc the cursor runs along.
  const arc = [
    candidate('center', { x: 0, y: 0 }, mid),
    candidate('start', { x: r, y: 0 }, { x: r, y: 0 }),
    candidate('end', { x: 0, y: r }, { x: 0, y: r }),
  ];

  it('suggests the arc center while hovering the middle of the arc', () => {
    expect(nearestAnchorIndex(arc, onArc(45), topCamera(), RECT)).toBe(0);
    expect(nearestAnchorIndex(arc, onArc(30), topCamera(), RECT)).toBe(0);
    expect(nearestAnchorIndex(arc, onArc(60), topCamera(), RECT)).toBe(0);
  });

  it('suggests the nearer end while hovering near either end of the arc', () => {
    expect(nearestAnchorIndex(arc, onArc(5), topCamera(), RECT)).toBe(1);
    expect(nearestAnchorIndex(arc, onArc(85), topCamera(), RECT)).toBe(2);
  });

  it('measures anchors without a hover point at their frame origin', () => {
    const legacy = arc.map(a => ({ ...a, hoverPoint: undefined }));
    // The off-arc circle center loses to an end everywhere along the arc.
    expect(nearestAnchorIndex(legacy, onArc(45), topCamera(), RECT)).not.toBe(0);
  });
});
