// The fit-to-view button (and the other "measure the scene" paths) read
// `compiledMesh`, but an assembly render removes that mesh and mounts the
// AssemblyController's container instead — so on an assembly the button
// found nothing and silently did nothing. The bounds helper has to follow
// whichever root is mounted.
import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Scene, Vector3 } from 'three';
import { COMPILED_MESH_NAME, findGeometryRoot, sceneGeometryBounds } from '../src/scene/scene-geometry-bounds';

function cube(size: number, at: [number, number, number], meta = false): Mesh {
  const mesh = new Mesh(new BoxGeometry(size, size, size), new MeshBasicMaterial());
  mesh.position.set(...at);
  if (meta) {
    mesh.userData.isMetaShape = true;
  }
  return mesh;
}

function partScene(): { scene: Scene; compiled: Group } {
  const scene = new Scene();
  const compiled = new Group();
  compiled.name = COMPILED_MESH_NAME;
  compiled.add(cube(2, [0, 0, 0]));
  scene.add(compiled);
  return { scene, compiled };
}

describe('sceneGeometryBounds', () => {
  it('measures the compiled part mesh when no assembly container is mounted', () => {
    const { scene, compiled } = partScene();
    const container = new Group(); // exists but never added to the scene
    expect(findGeometryRoot(scene, container)).toBe(compiled);
    const box = sceneGeometryBounds(scene, container);
    expect(box).not.toBeNull();
    expect(box!.min.toArray()).toEqual([-1, -1, -1]);
    expect(box!.max.toArray()).toEqual([1, 1, 1]);
  });

  it('measures the mounted assembly container instead of the (removed) compiled mesh', () => {
    const scene = new Scene();
    const container = new Group();
    // Two posed instances, like the controller's instance groups after a solve.
    const a = new Group();
    a.position.set(10, 0, 0);
    a.add(cube(2, [0, 0, 0]));
    const b = new Group();
    b.position.set(-4, 3, 0);
    b.add(cube(2, [0, 0, 0]));
    container.add(a, b);
    scene.add(container);

    expect(findGeometryRoot(scene, container)).toBe(container);
    const box = sceneGeometryBounds(scene, container);
    expect(box).not.toBeNull();
    expect(box!.min.toArray()).toEqual([-5, -1, -1]);
    expect(box!.max.toArray()).toEqual([11, 4, 1]);
  });

  it('prefers the assembly container even if a stale compiled mesh is still in the scene', () => {
    const { scene } = partScene();
    const container = new Group();
    container.add(cube(2, [50, 0, 0]));
    scene.add(container);
    const box = sceneGeometryBounds(scene, container);
    expect(box!.getCenter(new Vector3()).toArray()).toEqual([50, 0, 0]);
  });

  it('skips meta shapes (connector gizmos, provisional replicas) inside the container', () => {
    const scene = new Scene();
    const container = new Group();
    container.add(cube(2, [0, 0, 0]));
    container.add(cube(40, [100, 100, 100], true));
    scene.add(container);
    const box = sceneGeometryBounds(scene, container);
    expect(box!.max.toArray()).toEqual([1, 1, 1]);
  });

  it('returns null when nothing is rendered yet', () => {
    expect(sceneGeometryBounds(new Scene(), null)).toBeNull();
    expect(sceneGeometryBounds(new Scene(), new Group())).toBeNull();
    const scene = new Scene();
    const empty = new Group();
    scene.add(empty);
    expect(sceneGeometryBounds(scene, empty)).toBeNull();
  });
});
