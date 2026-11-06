// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  Vector3,
  type Camera,
} from 'three';
import { ScreenshotShapeFraming } from '../src/screenshot-shape-framing';

// The capture's `fitTo: { shapes }` framing, measured the way the picture is
// judged: every corner of the framed geometry projected through the posed
// camera must land inside the frame, centred, with the tighter axis filled
// to exactly 1/margin.

const EXPORT = { width: 800, height: 400 };
const ISO_FTR = { kind: 'named', name: 'iso-ftr' } as const;
const LIVE = { eye: new Vector3(0, -100, 0), target: new Vector3() };

function box(shapeId: string, size: [number, number, number], at: [number, number, number]): Group {
  const group = new Group();
  group.userData.shapeId = shapeId;
  const mesh = new Mesh(new BoxGeometry(...size), new MeshBasicMaterial());
  mesh.position.set(...at);
  group.add(mesh);
  return group;
}

/**
 * An L: leg along x, arm up at its far end. Its box's empty corner (x 0,
 * z 30) is what an iso-ftr view sees highest on screen.
 */
function ell(shapeId: string): Group {
  const group = new Group();
  group.userData.shapeId = shapeId;
  group.add(box('leg', [40, 4, 4], [20, 0, 2]).children[0].clone());
  group.add(box('arm', [4, 4, 30], [38, 0, 15]).children[0].clone());
  return group;
}

/** A part of two separated solids, and an assembly instance of an L-shaped part posed away from the origin. */
function buildScene(): { scene: Scene; instance: Group } {
  const scene = new Scene();
  const compiled = new Group();
  compiled.name = 'compiledMesh';
  compiled.add(box('lower', [10, 10, 10], [0, 0, 5]));
  compiled.add(box('upper', [20, 10, 4], [0, 0, 60]));
  scene.add(compiled);

  const instance = new Group();
  instance.userData.instanceId = 'inst-1';
  instance.add(ell('ell'));
  // A connector glyph: meta, never part of what is framed.
  const connector = box('conn', [2, 2, 2], [500, 500, 500]);
  connector.userData.isMetaShape = true;
  instance.add(connector);
  instance.position.set(200, -50, 30);
  instance.rotation.set(0, 0, Math.PI / 2);
  scene.add(instance);
  return { scene, instance };
}

function orthoCamera(): OrthographicCamera {
  const aspect = EXPORT.width / EXPORT.height;
  return new OrthographicCamera(-aspect * 50, aspect * 50, 50, -50, -10000, 10000);
}

/** Every box corner of every mesh under the objects, world space. */
function cornersOf(objects: Object3D[]): Vector3[] {
  const corners: Vector3[] = [];
  for (const object of objects) {
    object.updateWorldMatrix(true, true);
    object.traverse((node) => {
      const mesh = node as Mesh;
      if (!mesh.isMesh || node.userData.isMetaShape || node.parent?.userData.isMetaShape) {
        return;
      }
      mesh.geometry.computeBoundingBox();
      const b = mesh.geometry.boundingBox!;
      for (const x of [b.min.x, b.max.x]) {
        for (const y of [b.min.y, b.max.y]) {
          for (const z of [b.min.z, b.max.z]) {
            corners.push(new Vector3(x, y, z).applyMatrix4(mesh.matrixWorld));
          }
        }
      }
    });
  }
  return corners;
}

/** Where the corners land on screen: NDC extent and middle. */
function screenSpan(camera: Camera, corners: Vector3[]) {
  camera.updateMatrixWorld();
  const min = { x: Infinity, y: Infinity };
  const max = { x: -Infinity, y: -Infinity };
  for (const corner of corners) {
    const p = corner.clone().project(camera);
    min.x = Math.min(min.x, p.x);
    min.y = Math.min(min.y, p.y);
    max.x = Math.max(max.x, p.x);
    max.y = Math.max(max.y, p.y);
  }
  return {
    mid: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 },
    half: { x: (max.x - min.x) / 2, y: (max.y - min.y) / 2 },
    reach: Math.max(Math.abs(min.x), Math.abs(max.x), Math.abs(min.y), Math.abs(max.y)),
  };
}

function shape(scene: Scene, id: string): Object3D[] {
  const found: Object3D[] = [];
  scene.traverse((node) => {
    if (node.userData.shapeId === id || node.userData.instanceId === id) {
      found.push(node);
    }
  });
  return found;
}

describe('ScreenshotShapeFraming', () => {
  // The viewer runs Z-up (SceneContext sets it); the shared jsdom gets it back afterwards.
  const savedUp = Object3D.DEFAULT_UP.clone();
  beforeAll(() => {
    Object3D.DEFAULT_UP.set(0, 0, 1);
  });
  afterAll(() => {
    Object3D.DEFAULT_UP.copy(savedUp);
  });

  it('frames one solid of a part from iso-ftr, centred, its tighter axis filled to 1/margin', () => {
    const { scene } = buildScene();
    const camera = orthoCamera();
    const framing = ScreenshotShapeFraming.measure(scene, { shapes: ['lower'] });
    expect(framing.margin).toBe(ScreenshotShapeFraming.DEFAULT_MARGIN);
    expect(framing.pose(camera, ISO_FTR, LIVE, EXPORT)).toBe(true);

    const direction = camera.getWorldDirection(new Vector3());
    expect(direction.dot(new Vector3(-1, 1, -1).normalize())).toBeCloseTo(1, 9);

    const span = screenSpan(camera, cornersOf(shape(scene, 'lower')));
    expect(span.mid.x).toBeCloseTo(0, 6);
    expect(span.mid.y).toBeCloseTo(0, 6);
    expect(Math.max(span.half.x, span.half.y)).toBeCloseTo(1 / 1.2, 6);
    // The other solid, 50 mm up, is out of this frame.
    expect(screenSpan(camera, cornersOf(shape(scene, 'upper'))).reach).toBeGreaterThan(1);
  });

  it('takes the margin it is given, and frames several shapes together', () => {
    const { scene } = buildScene();
    const camera = orthoCamera();
    ScreenshotShapeFraming.measure(scene, { shapes: ['lower', 'upper'], margin: 2 }).pose(camera, { kind: 'named', name: 'front' }, LIVE, EXPORT);
    const span = screenSpan(camera, cornersOf([...shape(scene, 'lower'), ...shape(scene, 'upper')]));
    expect(span.mid.x).toBeCloseTo(0, 6);
    expect(span.mid.y).toBeCloseTo(0, 6);
    expect(Math.max(span.half.x, span.half.y)).toBeCloseTo(0.5, 6);
  });

  it('frames an assembly instance where its pose puts it, its meta connector left out', () => {
    const { scene } = buildScene();
    const camera = orthoCamera();
    ScreenshotShapeFraming.measure(scene, { shapes: ['inst-1'] }).pose(camera, ISO_FTR, LIVE, EXPORT);
    const span = screenSpan(camera, cornersOf(shape(scene, 'ell')));
    expect(span.mid.x).toBeCloseTo(0, 6);
    expect(span.mid.y).toBeCloseTo(0, 6);
    expect(Math.max(span.half.x, span.half.y)).toBeCloseTo(1 / 1.2, 6);

    // The shape id inside the instance frames the same posed geometry.
    const byShape = orthoCamera();
    ScreenshotShapeFraming.measure(scene, { shapes: ['ell'] }).pose(byShape, ISO_FTR, LIVE, EXPORT);
    expect(byShape.zoom).toBeCloseTo(camera.zoom, 9);
    expect(byShape.position.distanceTo(camera.position)).toBeLessThan(1e-6);
  });

  it('reads the pose as it is now, not the stale world matrix of the last frame', () => {
    const { scene, instance } = buildScene();
    scene.updateMatrixWorld(true);
    // A mate solve moved the instance in the same tick; nothing has rendered since.
    instance.position.set(-300, 120, 0);
    const camera = orthoCamera();
    ScreenshotShapeFraming.measure(scene, { shapes: ['inst-1'] }).pose(camera, ISO_FTR, LIVE, EXPORT);
    const span = screenSpan(camera, cornersOf(shape(scene, 'ell')));
    expect(span.mid.x).toBeCloseTo(0, 6);
    expect(span.mid.y).toBeCloseTo(0, 6);
  });

  it('frames an L-shaped shape by its pieces, not by the empty corner of its box', () => {
    const scene = new Scene();
    scene.add(ell('bracket'));
    const camera = orthoCamera();
    ScreenshotShapeFraming.measure(scene, { shapes: ['bracket'] }).pose(camera, ISO_FTR, LIVE, EXPORT);
    const pieces = cornersOf(shape(scene, 'bracket'));
    const span = screenSpan(camera, pieces);
    // The pieces are centred and touch the frame at 1/margin on the tighter axis…
    expect(span.mid.x).toBeCloseTo(0, 6);
    expect(span.mid.y).toBeCloseTo(0, 6);
    expect(Math.max(span.half.x, span.half.y)).toBeCloseTo(1 / 1.2, 6);
    // …while the one box around them reaches past the frame: framing it would
    // have shrunk the L and pushed it off centre to make room for nothing.
    const xs = pieces.map((p) => p.x);
    const ys = pieces.map((p) => p.y);
    const zs = pieces.map((p) => p.z);
    const box = [];
    for (const x of [Math.min(...xs), Math.max(...xs)]) {
      for (const y of [Math.min(...ys), Math.max(...ys)]) {
        for (const z of [Math.min(...zs), Math.max(...zs)]) {
          box.push(new Vector3(x, y, z));
        }
      }
    }
    expect(screenSpan(camera, box).reach).toBeGreaterThan(1);
  });

  it('solves a perspective camera\'s distance corner by corner and widens its clip range for the shot', () => {
    const { scene } = buildScene();
    const camera = new PerspectiveCamera(50, EXPORT.width / EXPORT.height, 50, 200);
    ScreenshotShapeFraming.measure(scene, { shapes: ['lower'], margin: 1.5 }).pose(camera, ISO_FTR, LIVE, EXPORT);
    const corners = cornersOf(shape(scene, 'lower'));
    const span = screenSpan(camera, corners);
    expect(span.reach).toBeCloseTo(1 / 1.5, 6);
    camera.updateMatrixWorld();
    for (const corner of corners) {
      const depth = -corner.clone().applyMatrix4(camera.matrixWorldInverse).z;
      expect(depth).toBeGreaterThan(camera.near);
      expect(depth).toBeLessThan(camera.far);
    }
  });

  it('keeps the interactive camera\'s direction and roll for the current view', () => {
    const { scene } = buildScene();
    const camera = orthoCamera();
    camera.up.set(0, 1, 0);
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);
    ScreenshotShapeFraming.measure(scene, { shapes: ['upper'] }).pose(camera, { kind: 'current' }, LIVE, EXPORT);
    expect(camera.up.toArray()).toEqual([0, 1, 0]);
    expect(camera.getWorldDirection(new Vector3()).dot(new Vector3(0, 0, -1))).toBeCloseTo(1, 9);
    const span = screenSpan(camera, cornersOf(shape(scene, 'upper')));
    expect(span.mid.x).toBeCloseTo(0, 6);
    expect(span.mid.y).toBeCloseTo(0, 6);
    // Top-down on a 20 × 10 slab in a 2:1 frame: both axes fill together.
    expect(span.half.x).toBeCloseTo(1 / 1.2, 6);
    expect(span.half.y).toBeCloseTo(1 / 1.2, 6);
  });

  it('refuses ids the page draws nothing for, naming each, and a meta-only match counts as nothing', () => {
    const { scene } = buildScene();
    expect(() => ScreenshotShapeFraming.measure(scene, { shapes: ['lower', 'gone', 'conn'] }))
      .toThrow('fitTo.shapes: nothing is drawn on the page for "gone", "conn", so there is nothing to frame.');
  });
});
