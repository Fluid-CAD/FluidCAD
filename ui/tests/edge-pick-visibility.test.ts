// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Vector2,
  Vector3,
} from 'three';
import { Viewer } from '../src/viewer';

/**
 * The pick regression this guards: pickAt used to accept an edge only when
 * its closest point was no deeper than the face the CURSOR ray hit. At a
 * concave junction (a shelled pocket's floor–wall edge) the corner is
 * locally the deepest point, so aiming a few pixels off the line always
 * found an adjacent face genuinely in front — internal edges were only
 * pickable in a sub-pixel band. The fix tests visibility of the edge point
 * itself, where the adjacent faces sit at exactly the edge's depth.
 */

type VisibilityFn = (point: Vector3, occluders: Object3D[], tolerance: number) => boolean;

function isPointVisible(camera: PerspectiveCamera): {
  call: (point: Vector3, occluders: Object3D[], tolerance: number) => boolean;
} {
  const fakeViewer = {
    ctx: {
      camera,
      createPickingRaycaster(ndcX: number, ndcY: number): Raycaster {
        const raycaster = new Raycaster();
        raycaster.setFromCamera(new Vector2(ndcX, ndcY), camera);
        return raycaster;
      },
    },
  };
  const method = (Viewer.prototype as unknown as { isPointVisible: VisibilityFn }).isPointVisible;
  return { call: (point, occluders, tolerance) => method.call(fakeViewer, point, occluders, tolerance) };
}

/** Floor z=0 over x,y∈[0,10] and wall x=10 over y,z∈[0,10]: a concave corner along (10, y, 0). */
function concaveCorner(): { floor: Mesh; wall: Mesh } {
  const floor = new Mesh(new PlaneGeometry(10, 10), new MeshBasicMaterial({ side: DoubleSide }));
  floor.position.set(5, 5, 0);
  floor.updateMatrixWorld(true);

  const wall = new Mesh(new PlaneGeometry(10, 10), new MeshBasicMaterial({ side: DoubleSide }));
  wall.rotation.y = Math.PI / 2;
  wall.position.set(10, 5, 5);
  wall.updateMatrixWorld(true);

  return { floor, wall };
}

function cameraIntoCorner(): PerspectiveCamera {
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 5, 8);
  camera.lookAt(10, 5, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

describe('Viewer.isPointVisible', () => {
  it('a point on a concave junction stays visible although both faces contain it', () => {
    const camera = cameraIntoCorner();
    const { floor, wall } = concaveCorner();
    const cornerPoint = new Vector3(10, 5, 0);

    expect(isPointVisible(camera).call(cornerPoint, [floor, wall], 0.05)).toBe(true);
  });

  it('a point behind the wall is occluded', () => {
    const camera = cameraIntoCorner();
    const { floor, wall } = concaveCorner();
    const hiddenPoint = new Vector3(12, 5, 0);

    expect(isPointVisible(camera).call(hiddenPoint, [floor, wall], 0.05)).toBe(false);
  });

  it('with no occluders every point is visible', () => {
    const camera = cameraIntoCorner();

    expect(isPointVisible(camera).call(new Vector3(3, 3, 3), [], 0.05)).toBe(true);
  });
});
