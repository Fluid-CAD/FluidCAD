// @vitest-environment jsdom
// A part's `.appearance(id)` reaches its solids' face meshes: an unpainted
// face group under an oak or steel part is shaded with the preset's PBR
// material, a `color()`-painted group keeps its flat Phong colour (paint is
// the override), a select highlight under the part stays a highlight, and a
// part without an appearance — or with an id the table lacks — draws Phong
// as it always has.
import { describe, it, expect } from 'vitest';
import { MeshPhongMaterial, MeshStandardMaterial, PerspectiveCamera, type Mesh } from 'three';
import { buildSceneMesh } from '../src/meshes/mesh-factory';
import type { SceneObjectRender } from '../src/types';

const loc = { filePath: '/ws/shelf.part.js', line: 2, column: 1 };
const tri = { vertices: [0, 0, 0, 1, 0, 0, 1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] };

function solid(shapeId: string, colors: (string | undefined)[]) {
  return {
    shapeId, shapeType: 'solid', isMetaShape: false,
    meshes: colors.map((color) => ({ ...tri, label: 'solid-faces', faceMapping: [0], ...(color ? { color } : {}) })),
  } as any;
}

function part(id: string, appearance?: string): SceneObjectRender {
  return {
    id, name: id, parentId: null, isContainer: true, type: 'part', uniqueType: 'part',
    object: { name: id, appearance }, sceneShapes: [], ownShapes: [], visible: true, sourceLocation: loc,
  } as unknown as SceneObjectRender;
}

function extrude(id: string, parentId: string | null, shapes: any[], uniqueType = 'extrude'): SceneObjectRender {
  return {
    id, name: id, parentId, isContainer: false, type: 'extrude', uniqueType,
    object: {}, sceneShapes: shapes, ownShapes: shapes, visible: true, sourceLocation: loc,
  } as unknown as SceneObjectRender;
}

function faceMaterials(root: { traverse(cb: (o: any) => void): void }): { kind: string; appearance?: string; color: string }[] {
  const out: { kind: string; appearance?: string; color: string }[] = [];
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || !mesh.userData.faceMapping) {
      return;
    }
    const material = mesh.material as MeshPhongMaterial | MeshStandardMaterial;
    out.push({
      kind: material instanceof MeshStandardMaterial ? 'standard' : material instanceof MeshPhongMaterial ? 'phong' : 'other',
      appearance: material.userData.appearance,
      color: '#' + material.color.getHexString(),
    });
  });
  return out;
}

const camera = new PerspectiveCamera(50, 1, 0.1, 1000);

describe('appearance materials in the scene mesh', () => {
  it('shades an oak part\'s unpainted faces with the textured preset and keeps painted faces flat', () => {
    const scene = [part('shelf', 'oak'), extrude('e', 'shelf', [solid('s1', [undefined, '#ff0000'])])];
    const materials = faceMaterials(buildSceneMesh(scene, null, camera));
    expect(materials).toEqual([
      { kind: 'standard', appearance: 'oak', color: '#bd926a' },
      { kind: 'phong', appearance: undefined, color: '#ff0000' },
    ]);
  });

  it('gives a plain metal preset its colour, roughness and metalness, and the environment slot', () => {
    const scene = [part('bracket', 'brass'), extrude('e', 'bracket', [solid('s1', [undefined])])];
    const root = buildSceneMesh(scene, null, camera);
    let material: MeshStandardMaterial | null = null;
    root.traverse((o) => { if ((o as Mesh).isMesh && (o as Mesh).userData.faceMapping) material = (o as Mesh).material as MeshStandardMaterial; });
    expect(material).toBeInstanceOf(MeshStandardMaterial);
    expect(material!.metalness).toBe(1);
    expect(material!.roughness).toBeCloseTo(0.32);
    expect(material!.userData.appearance).toBe('brass');
    // Every preset patches the shader (the ambient term); plain and textured
    // ones compile different programs.
    expect(material!.customProgramCacheKey()).toBe('fluidcad-appearance:');
  });

  it('keys a wood preset\'s program apart from a plain one', () => {
    const scene = [part('shelf', 'oak'), extrude('e', 'shelf', [solid('s1', [undefined])])];
    const root = buildSceneMesh(scene, null, camera);
    let material: MeshStandardMaterial | null = null;
    root.traverse((o) => { if ((o as Mesh).isMesh && (o as Mesh).userData.faceMapping) material = (o as Mesh).material as MeshStandardMaterial; });
    expect(material!.customProgramCacheKey()).toBe('fluidcad-appearance:wood');
  });

  it('draws Phong for a part without an appearance, an unknown id, and a solid outside any part', () => {
    const scene = [
      part('plain'), extrude('e1', 'plain', [solid('s1', [undefined])]),
      part('odd', 'chrome'), extrude('e2', 'odd', [solid('s2', [undefined])]),
      extrude('e3', null, [solid('s3', [undefined])]),
    ];
    expect(faceMaterials(buildSceneMesh(scene, null, camera)).map((m) => m.kind)).toEqual(['phong', 'phong', 'phong']);
  });

  it('keeps a select highlight under an appearance part a highlight', () => {
    const scene = [part('shelf', 'steel'), extrude('sel', 'shelf', [solid('s1', [undefined])], 'select')];
    const [material] = faceMaterials(buildSceneMesh(scene, null, camera));
    expect(material.kind).toBe('phong');
    expect(material.appearance).toBeUndefined();
  });
});
