// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
} from 'three';
import { Viewer } from '../src/viewer';
import { hitIsClipped, hitIsSectioned } from '../src/interactive/pick-visibility';

/**
 * A section view clips the scene through the materials; three's Raycaster
 * ignores material clipping. pickAt therefore has to drop hits that land on
 * the removed half — otherwise hovering the cut-open model picks (and the
 * projection tool highlights) a face or edge the screen no longer shows.
 */

/** Keep z < 0: a point at z > 0 is on the removed half. */
const KEEP_BACK = new Plane(new Vector3(0, 0, -1), 0);

function wall(shapeId: string, z: number, rotateY = 0): Mesh {
  const mesh = new Mesh(new PlaneGeometry(10, 10), new MeshBasicMaterial({ side: DoubleSide }));
  mesh.position.set(0, 0, z);
  mesh.rotation.y = rotateY;
  mesh.userData.faceMapping = [0, 0];
  mesh.userData.shapeId = shapeId;
  mesh.updateMatrixWorld(true);
  return mesh;
}

function edge(shapeId: string, z: number): LineSegments {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([-5, 0, z, 5, 0, z], 3));
  const line = new LineSegments(geometry, new LineBasicMaterial());
  line.userData.edgeIndex = 0;
  line.userData.shapeId = shapeId;
  line.userData.isEdgeLine = true;
  line.updateMatrixWorld(true);
  return line;
}

function clip(object: Mesh | LineSegments, plane: Plane | null): void {
  (object.material as MeshBasicMaterial).clippingPlanes = plane ? [plane] : [];
}

function pickAtCenter(scene: Scene): ReturnType<Viewer['pickAt']> {
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 20);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const fake = Object.assign(Object.create(Viewer.prototype), {
    pickFilter: 'all',
    pickConnectors: false,
    _pickVertices: false,
    pickSketchWires: false,
    pickProfileWires: false,
    pickAxes: false,
    pickPlanes: false,
    standardPlanes: { pickTargets: [] },
    standardAxes: { pickTargets: [] },
    computeEdgePickThreshold: () => 0.4,
    ctx: {
      camera,
      scene,
      renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }) } },
      createPickingRaycaster(ndcX: number, ndcY: number): Raycaster {
        const raycaster = new Raycaster();
        raycaster.setFromCamera(new Vector2(ndcX, ndcY), camera);
        return raycaster;
      },
    },
  });
  return (Viewer.prototype as unknown as { pickAt: (x: number, y: number) => ReturnType<Viewer['pickAt']> })
    .pickAt.call(fake, 200, 200);
}

describe('pickAt under a section view', () => {
  it('without clipping the near wall is the pick', () => {
    const scene = new Scene();
    scene.add(wall('near', 5), wall('far', -5, Math.PI));
    expect(pickAtCenter(scene)).toMatchObject({ shapeId: 'near', sub: { type: 'face', index: 0 } });
  });

  it('a face on the removed half is skipped for the cut-open interior behind it', () => {
    const scene = new Scene();
    const near = wall('near', 5);
    // The far wall's inside: back-facing, which only the section view reveals.
    const far = wall('far', -5, Math.PI);
    clip(near, KEEP_BACK);
    clip(far, KEEP_BACK);
    scene.add(near, far);
    expect(pickAtCenter(scene)).toMatchObject({ shapeId: 'far', sub: { type: 'face', index: 0 } });
  });

  it('a back-facing wall stays unpickable while nothing clips it', () => {
    const scene = new Scene();
    scene.add(wall('far', -5, Math.PI));
    expect(pickAtCenter(scene)).toBeNull();
  });

  it('an edge on the removed half is skipped', () => {
    const scene = new Scene();
    const line = edge('rim', 5);
    scene.add(line);
    expect(pickAtCenter(scene)).toMatchObject({ shapeId: 'rim', sub: { type: 'edge', index: 0 } });
    clip(line, KEEP_BACK);
    expect(pickAtCenter(scene)).toBeNull();
  });

  it('an edge on the kept half picks through the removed wall in front of it', () => {
    const scene = new Scene();
    const near = wall('near', 5);
    const line = edge('rim', -5);
    clip(near, KEEP_BACK);
    clip(line, KEEP_BACK);
    scene.add(near, line);
    expect(pickAtCenter(scene)).toMatchObject({ shapeId: 'rim', sub: { type: 'edge', index: 0 } });
  });
});

describe('hit clip helpers', () => {
  it('read the clipping of the hit material, per group for multi-material meshes', () => {
    const mesh = new Mesh(new PlaneGeometry(1, 1), [new MeshBasicMaterial(), new MeshBasicMaterial()]);
    mesh.material[1].clippingPlanes = [KEEP_BACK];
    const hit = { object: mesh, point: new Vector3(0, 0, 1), face: { materialIndex: 1 } } as never;
    expect(hitIsSectioned(hit)).toBe(true);
    expect(hitIsClipped(hit)).toBe(true);
    expect(hitIsClipped(hit, new Vector3(0, 0, -1))).toBe(false);
    const plain = { object: mesh, point: new Vector3(0, 0, 1), face: { materialIndex: 0 } } as never;
    expect(hitIsSectioned(plain)).toBe(false);
    expect(hitIsClipped(plain)).toBe(false);
  });
});
