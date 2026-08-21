// Drafting arrowheads for the ends of a dimension leader (the distance
// line). The leader itself is world-scale — it spans the geometry it
// measures — while a head must stay the same size on screen at every zoom,
// so each head owns a group whose scale is re-derived per frame from the
// pixels-per-world at its tip.
//
// Because the heads are pixel-sized and the line is not, zooming out
// eventually leaves less line than the two heads need: past that point they
// flip to point inward from outside the endpoints, which is what a drafter
// does when the extension lines close in.

import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Vector3,
} from 'three';
import type { PlaneData, Vec3Data } from '../../types';
import type { ArrowEnds } from '../../sketch-solver-client';
import { localToWorld } from '../../interactive/sketch-plane-utils';
import { pixelsToWorld } from '../screen-scale';

type Vec2 = [number, number];

/** On-screen head length, tip to base. */
const ARROW_PX_LEN = 11;
const ARROW_PX_HALF_WIDTH = 3.4;
/** Line the heads must leave clear between them before flipping out. */
const MIN_CLEAR_PX = 6;
/** A triangle this small at the leader's own alpha all but vanishes beside
 * the line it caps — drafting arrowheads are solid ink. Deepens the fill
 * without letting a preview's fade escape. */
const ARROW_ALPHA = 1.7;

/** Tip at the origin, base one unit along +X — the group scale turns that
 * unit into `ARROW_PX_LEN` screen pixels. */
function arrowGeometry(): BufferGeometry {
  const halfWidth = ARROW_PX_HALF_WIDTH / ARROW_PX_LEN;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([
    0, 0, 0,
    1, halfWidth, 0,
    1, -halfWidth, 0,
  ], 3));
  return geometry;
}

/**
 * One head, tip pinned to `tip` and pointing back along `angle` (a
 * sketch-plane direction, so +X of the oriented frame is the plane's x
 * direction). `worldLen` is the leader it belongs to and `minLenPx` the
 * room its heads need on screen — shorter than that and it flips out.
 */
function buildHead(
  geometry: BufferGeometry,
  material: MeshBasicMaterial,
  tip: Vector3,
  angle: number,
  plane: PlaneData,
  normal: Vec3Data,
  worldLen: number,
  minLenPx: number,
  renderOrder: number,
): Group {
  const group = new Group();
  group.position.copy(tip);
  group.up.set(plane.yDirection.x, plane.yDirection.y, plane.yDirection.z);
  group.lookAt(tip.x + normal.x, tip.y + normal.y, tip.z + normal.z);
  group.rotateZ(angle);
  // The flip rides a child: the group's own quaternion is the plane frame,
  // and rewriting it per frame would have to redo the lookAt.
  const pivot = new Object3D();
  group.add(pivot);
  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = renderOrder;
  pivot.add(mesh);

  mesh.onBeforeRender = (renderer, _scene, camera) => {
    const worldPerPx = pixelsToWorld(renderer, camera, tip, 1);
    if (!Number.isFinite(worldPerPx) || worldPerPx <= 0) {
      return;
    }
    group.scale.setScalar(worldPerPx * ARROW_PX_LEN);
    const lenPx = worldLen / worldPerPx;
    pivot.rotation.z = lenPx < minLenPx ? Math.PI : 0;
    group.updateMatrixWorld(true);
  };
  return group;
}

/**
 * The heads of a dimension leader as one group — add it beside the leader
 * line. Null for a degenerate segment (no direction to aim along).
 * The heads share a geometry and a material; disposing the group's children
 * hits each twice, which three tolerates.
 */
export function buildDimensionArrows(
  seg: [Vec2, Vec2],
  plane: PlaneData,
  normal: Vec3Data,
  color: Color,
  opacity: number,
  renderOrder: number,
  ends: ArrowEnds = 'both',
): Group | null {
  const [fromLocal, toLocal] = seg;
  const dx = toLocal[0] - fromLocal[0];
  const dy = toLocal[1] - fromLocal[1];
  if (Math.hypot(dx, dy) < 1e-9) {
    return null;
  }
  const from = localToWorld(fromLocal, plane);
  const to = localToWorld(toLocal, plane);
  const worldLen = from.distanceTo(to);

  const geometry = arrowGeometry();
  const material = new MeshBasicMaterial({
    color,
    transparent: true,
    opacity: Math.min(1, opacity * ARROW_ALPHA),
    depthTest: false,
    side: DoubleSide,
  });

  const group = new Group();
  group.renderOrder = renderOrder;
  group.userData.isConstraintIcon = true;
  // Each head aims from its own end back into the line, so it reads as an
  // arrow landing on the point the dimension measures. One head needs half
  // the room two do before the line is too short to hold it.
  const angle = Math.atan2(dy, dx);
  const minLenPx = (ends === 'both' ? 2 : 1) * ARROW_PX_LEN + MIN_CLEAR_PX;
  if (ends === 'both') {
    group.add(buildHead(geometry, material, from, angle, plane, normal, worldLen, minLenPx, renderOrder));
  }
  group.add(
    buildHead(geometry, material, to, angle + Math.PI, plane, normal, worldLen, minLenPx, renderOrder),
  );
  return group;
}
