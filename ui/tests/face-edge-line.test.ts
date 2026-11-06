// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Matrix4, MeshPhongMaterial, ShaderLib, Vector3, type Mesh } from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import {
  createEdgeLineMaterial,
  FACE_EDGE_VERTEX_SHADER,
  FaceEdgeGeometry,
  FaceEdgeMaterial,
  faceSidesOf,
  patchLineVertexShader,
} from '../src/meshes/shape-meshes/face-edge-line';
import { faceDepthOffset } from '../src/meshes/shape-meshes/face-depth-offset';
import { EdgeMesh } from '../src/meshes/shape-meshes/edge-mesh';
import { SolidMesh } from '../src/meshes/shape-meshes/solid-mesh';
import type { SceneObjectMesh } from '../src/types';

/**
 * A solid's edge line carries per segment the vectors into the faces either
 * side of it (`faceSides`); the viewer draws it with a band split down its
 * centerline whose corners lie on those faces, so the faces need only a
 * constant depth offset — no slope offset that pushes a thin wall behind
 * the edges under it.
 */
function edge(faceSides?: number[]): SceneObjectMesh {
  return {
    label: 'solid-edges',
    vertices: [0, 0, 0, 10, 0, 0, 20, 0, 0],
    normals: [],
    indices: [0, 1, 1, 2],
    edgeIndex: 0,
    ...(faceSides ? { faceSides } : {}),
  };
}

const SIDES = [0, 0, 5, 0, 8, 0, 0, 0, 5, 0, 8, 0];

function line(mesh: EdgeMesh): LineSegments2 {
  return mesh.children[0] as unknown as LineSegments2;
}

describe('face edge line shader', () => {
  it('patches the three anchors of three\'s line shader', () => {
    expect(FACE_EDGE_VERTEX_SHADER).toContain('attribute vec3 instanceSideA;');
    expect(FACE_EDGE_VERTEX_SHADER).toContain('offset *= position.x;');
    expect(FACE_EDGE_VERTEX_SHADER).not.toContain('if ( position.x < 0.0 ) offset *= - 1.0;');
    expect(FACE_EDGE_VERTEX_SHADER).toContain('faceCovers(');
    expect(FACE_EDGE_VERTEX_SHADER).toContain('behindOwnMaterial(');
  });

  it('refuses a shader that no longer has an anchor', () => {
    const moved = ShaderLib.line.vertexShader.replace('clip.xy += offset;', 'clip.xy = clip.xy + offset;');
    expect(() => patchLineVertexShader(moved)).toThrow(/clip\.xy \+= offset;/);
  });

  it('keeps its shader and attribute defaults through a clone', () => {
    const material = new FaceEdgeMaterial({ linewidth: 2 });
    const clone = material.clone() as FaceEdgeMaterial;
    expect(clone).toBeInstanceOf(FaceEdgeMaterial);
    expect(clone.vertexShader).toBe(FACE_EDGE_VERTEX_SHADER);
    expect(clone.linewidth).toBe(2);
    expect((clone.defaultAttributeValues as Record<string, number[]>).instanceSideA).toEqual([0, 0, 0]);
  });
});

describe('FaceEdgeGeometry', () => {
  it('splits the band down its centerline: three columns, each half its own triangles', () => {
    const geometry = new FaceEdgeGeometry();
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    expect(position.count).toBe(12);
    const xs = new Set<number>();
    for (let i = 0; i < position.count; i++) {
      xs.add(position.getX(i));
      expect(uv.getX(i)).toBe(position.getX(i));
    }
    expect([...xs].sort()).toEqual([-1, 0, 1]);
    const index = geometry.getIndex()!.array;
    expect(index.length).toBe(36);
    // No triangle spans the centerline: each has x ≤ 0 or x ≥ 0 throughout.
    for (let t = 0; t < index.length; t += 3) {
      const tx = [index[t], index[t + 1], index[t + 2]].map(i => position.getX(i));
      expect(tx.every(x => x <= 0) || tx.every(x => x >= 0)).toBe(true);
    }
  });

  it('carries the face vectors per segment, turned and scaled with the geometry', () => {
    const geometry = new FaceEdgeGeometry().setFaceSides(new Float32Array(SIDES));
    geometry.setPositions([0, 0, 0, 10, 0, 0, 10, 0, 0, 20, 0, 0]);
    expect(geometry.getAttribute('instanceSideA').count).toBe(2);
    expect(geometry.getAttribute('instanceSideB').getY(1)).toBe(8);

    geometry.applyMatrix4(new Matrix4().makeRotationX(Math.PI / 2).scale(new Vector3(2, 2, 2)));
    const sideA = geometry.getAttribute('instanceSideA');
    // (0, 0, 5) turned a quarter about X and doubled: (0, -10, 0).
    expect(sideA.getX(0)).toBeCloseTo(0);
    expect(sideA.getY(0)).toBeCloseTo(-10);
    expect(sideA.getZ(0)).toBeCloseTo(0);
  });

  it('takes the line material that reads its centerline column', () => {
    expect(createEdgeLineMaterial(new FaceEdgeGeometry(), {})).toBeInstanceOf(FaceEdgeMaterial);
    const plain = createEdgeLineMaterial(new LineSegmentsGeometry(), {});
    expect(plain).toBeInstanceOf(LineMaterial);
    expect(plain).not.toBeInstanceOf(FaceEdgeMaterial);
  });
});

describe('EdgeMesh with face sides', () => {
  it('draws an edge with face sides on its faces', () => {
    const mesh = new EdgeMesh({ shapeType: 'edge', meshes: [edge(SIDES)] });
    expect(line(mesh).geometry).toBeInstanceOf(FaceEdgeGeometry);
    expect(line(mesh).material).toBeInstanceOf(FaceEdgeMaterial);
    expect(line(mesh).userData.edgeIndex).toBe(0);
  });

  it('draws an edge without them — or with a count that does not match — as it always has', () => {
    for (const data of [edge(), edge([0, 0, 1, 0, 1, 0])]) {
      const mesh = new EdgeMesh({ shapeType: 'edge', meshes: [data] });
      expect(line(mesh).geometry).not.toBeInstanceOf(FaceEdgeGeometry);
      expect(line(mesh).material).not.toBeInstanceOf(FaceEdgeMaterial);
    }
    expect(faceSidesOf(edge([0, 0, 1]))).toBeNull();
    expect(faceSidesOf(edge(SIDES))).toHaveLength(12);
  });

  it('keeps a highlight color on a face-aware line', () => {
    const mesh = new EdgeMesh({ shapeType: 'edge', meshes: [edge(SIDES)] }, { color: '#ff0000', lineWidth: 3 });
    const material = line(mesh).material as LineMaterial;
    expect(material.color.getHex()).toBe(0xff0000);
    expect(material.linewidth).toBe(3);
  });
});

describe('face depth offset', () => {
  const tri = { vertices: [0, 0, 0, 1, 0, 0, 1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] };

  function faceMaterial(edges: SceneObjectMesh[]): MeshPhongMaterial {
    const solid = new SolidMesh({ shapeType: 'solid', meshes: [{ ...tri, label: 'solid-faces', faceMapping: [0] }, ...edges] });
    let material: MeshPhongMaterial | null = null;
    solid.traverse(o => {
      if ((o as Mesh).isMesh && o.userData.faceMapping) {
        material = (o as Mesh).material as MeshPhongMaterial;
      }
    });
    return material!;
  }

  it('keeps a constant offset only, overlays between the edges and the faces', () => {
    expect(faceDepthOffset(false)).toEqual({ polygonOffsetFactor: 0, polygonOffsetUnits: 1 });
    expect(faceDepthOffset(true)).toEqual({ polygonOffsetFactor: 0, polygonOffsetUnits: 0.5 });
  });

  it('drops the slope offset for a solid whose edges carry face sides', () => {
    const material = faceMaterial([edge(SIDES)]);
    expect(material.polygonOffset).toBe(true);
    expect(material.polygonOffsetFactor).toBe(0);
    expect(material.polygonOffsetUnits).toBe(1);
  });

  it('keeps it for an older engine\'s solid, whose edges carry none', () => {
    const material = faceMaterial([edge()]);
    expect(material.polygonOffsetFactor).toBe(1);
    expect(material.polygonOffsetUnits).toBe(1);
  });
});
