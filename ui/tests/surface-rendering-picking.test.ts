// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Color, Mesh, Object3D, PerspectiveCamera, Raycaster, Scene, Vector2 } from 'three';
import { Viewer } from '../src/viewer';
import { ShapeGroup } from '../src/meshes/containers/shape-group';
import { collectPickCandidates, type PickChannels } from '../src/interactive/pick-candidates';
import { EntityGeometry } from '../src/meshes/entity-geometry';
import { themeColors } from '../src/scene/theme-colors';
import type { SceneObjectMesh, SceneObjectPart, SceneObjectRender, ShapeType } from '../src/types';

/**
 * A surface arrives as shape type `surface` with the meshes a solid sends —
 * `solid-faces` with a face mapping, `solid-edges` with edge indices — and
 * its open rim flagged `boundary`. It draws as a body that says it is a
 * surface (not a solid), its rim in the edge colour a step wider; its faces and edges pick
 * like a solid's, from either side; a whole-shape highlight tints its faces.
 */

const NO_CHANNELS: PickChannels = { sketchWires: false, profileWires: false, axes: false, planes: false };

/**
 * Two square faces on z = 0, side by side: face 0 over x ∈ [-5, 5], face 1
 * over x ∈ [5, 15], both y ∈ [-5, 5]. `facing` is the side their triangles
 * face (by winding and normals).
 */
function twoFaces(facing: 1 | -1): SceneObjectMesh {
  const quad = (x0: number, x1: number) => [x0, -5, 0, x1, -5, 0, x1, 5, 0, x0, 5, 0];
  const vertices = [...quad(-5, 5), ...quad(5, 15)];
  const front = [0, 1, 2, 0, 2, 3];
  const winding = facing === 1 ? front : [0, 2, 1, 0, 3, 2];
  return {
    label: 'solid-faces',
    vertices,
    normals: Array.from({ length: 8 }, () => [0, 0, facing]).flat(),
    indices: [...winding, ...winding.map(i => i + 4)],
    faceMapping: [0, 0, 1, 1],
  };
}

function edgeLine(edgeIndex: number, from: number[], to: number[], boundary: boolean): SceneObjectMesh {
  return {
    label: 'solid-edges',
    vertices: [...from, ...to],
    normals: [],
    indices: [0, 1],
    edgeIndex,
    ...(boundary ? { boundary: true } : {}),
  };
}

/** The two faces' outline: six rim edges and the shared one (index 3) between them. */
function outline(): SceneObjectMesh[] {
  return [
    edgeLine(0, [-5, -5, 0], [5, -5, 0], true),
    edgeLine(1, [-5, 5, 0], [5, 5, 0], true),
    edgeLine(2, [-5, -5, 0], [-5, 5, 0], true),
    edgeLine(3, [5, -5, 0], [5, 5, 0], false),
    edgeLine(4, [5, -5, 0], [15, -5, 0], true),
    edgeLine(5, [5, 5, 0], [15, 5, 0], true),
    edgeLine(6, [15, -5, 0], [15, 5, 0], true),
  ];
}

function bodyPart(shapeType: ShapeType, facing: 1 | -1 = 1): SceneObjectPart {
  return { shapeId: `${shapeType}-1`, shapeType, meshes: [twoFaces(facing), ...outline()] };
}

function rowOf(part: SceneObjectPart): SceneObjectRender {
  return { id: `${part.shapeType}-row`, type: 'extrude', sceneShapes: [part], ownShapes: [] };
}

function linesOf(root: Object3D): Object3D[] {
  const lines: Object3D[] = [];
  root.traverse(node => {
    if (node.userData.isEdgeLine) {
      lines.push(node);
    }
  });
  return lines;
}

function faceMeshesOf(root: Object3D): Mesh[] {
  const meshes: Mesh[] = [];
  root.traverse(node => {
    if ((node as Mesh).isMesh && node.userData.faceMapping) {
      meshes.push(node as Mesh);
    }
  });
  return meshes;
}

const colorOf = (node: Object3D) => ((node as unknown as { material: { color: Color } }).material.color.getHex());
const widthOf = (node: Object3D) => ((node as unknown as { material: { linewidth: number } }).material.linewidth);

/** A viewer reduced to what pickAt reads, looking down -Z at the origin from z = 20. */
function pickAtCenter(scene: Scene): ReturnType<Viewer['pickAt']> {
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 20);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  scene.updateMatrixWorld(true);
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

describe('a surface body in the viewport', () => {
  it('ShapeGroup draws a surface as a body marked a surface, not a solid', () => {
    const group = new ShapeGroup(rowOf(bodyPart('surface')), false);
    const body = group.children[0];
    expect(body.userData.isSurface).toBe(true);
    expect(body.userData.isSolid).toBeUndefined();
    expect(body.userData.shapeId).toBe('surface-1');

    const [faces] = faceMeshesOf(group);
    expect(faces.userData.faceMapping).toEqual([0, 0, 1, 1]);
    expect(colorOf(faces)).toBe(themeColors.surfaceFace.getHex());
  });

  it('draws the rim in the edge colour a step wider, and the shared edge as a model edge', () => {
    const lines = linesOf(new ShapeGroup(rowOf(bodyPart('surface')), false));
    expect(lines).toHaveLength(7);
    const rim = lines.filter(line => line.userData.boundaryEdge);
    expect(rim.map(line => line.userData.edgeIndex)).toEqual([0, 1, 2, 4, 5, 6]);
    for (const line of rim) {
      expect(colorOf(line)).toBe(themeColors.sheetBoundary.getHex());
      expect(widthOf(line)).toBe(2);
    }
    const shared = lines.find(line => line.userData.edgeIndex === 3)!;
    expect(shared.userData.boundaryEdge).toBeUndefined();
    expect(colorOf(shared)).toBe(themeColors.edgeColor.getHex());
    expect(widthOf(shared)).toBe(1);
  });

  it('leaves a solid as it was: isSolid, the solid face colour', () => {
    const group = new ShapeGroup(rowOf(bodyPart('solid')), false);
    expect(group.children[0].userData.isSolid).toBe(true);
    expect(group.children[0].userData.isSurface).toBeUndefined();
    expect(colorOf(faceMeshesOf(group)[0])).toBe(themeColors.faceColor.getHex());
  });

  it("collects a surface's faces and edges as pick candidates", () => {
    const root = new Object3D();
    root.add(new ShapeGroup(rowOf(bodyPart('surface')), false));
    const candidates = collectPickCandidates(root, NO_CHANNELS);
    expect(candidates.faces).toHaveLength(1);
    expect(candidates.edges.map(edge => edge.userData.edgeIndex).sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);

    // A single face's or edge's hover and selection overlay find their geometry by the same indices.
    const [face] = EntityGeometry.faceTriangles(root, 'surface-1', 1);
    expect(face.positions).toHaveLength(2 * 9);
    expect(EntityGeometry.edgeLines(root, 'surface-1', 3)).toHaveLength(1);
  });

  it("collects each line of a multi-edge wire as an edge candidate with its own index", () => {
    const wire: SceneObjectRender = {
      id: 'curve-1',
      type: 'helix',
      sceneShapes: [{
        shapeId: 'wire-shape',
        shapeType: 'wire',
        meshes: [
          { vertices: [0, 0, 0, 10, 0, 0], normals: [], indices: [0, 1], edgeIndex: 0 },
          { vertices: [10, 0, 0, 10, 10, 0], normals: [], indices: [0, 1], edgeIndex: 1 },
          { vertices: [10, 10, 0, 0, 10, 0], normals: [], indices: [0, 1], edgeIndex: 2 },
        ],
      }],
      ownShapes: [],
    };
    const root = new Object3D();
    root.add(new ShapeGroup(wire, false));
    const candidates = collectPickCandidates(root, NO_CHANNELS);
    expect(candidates.edges.map(edge => edge.userData.edgeIndex)).toEqual([0, 1, 2]);
    expect(EntityGeometry.edgeLines(root, 'wire-shape', 1)).toEqual([candidates.edges[1]]);
  });

  it('picks a surface face seen from behind', () => {
    const scene = new Scene();
    scene.add(new ShapeGroup(rowOf(bodyPart('surface', -1)), false));
    expect(pickAtCenter(scene)).toMatchObject({ shapeId: 'surface-1', sub: { type: 'face', index: 0 } });
  });

  it('still refuses a solid face seen from behind', () => {
    const scene = new Scene();
    scene.add(new ShapeGroup(rowOf(bodyPart('solid', -1)), false));
    expect(pickAtCenter(scene)).toBeNull();
  });

  it("tints a surface's faces for a whole-shape highlight, not its edges", () => {
    const part = bodyPart('surface');
    const scene = new Scene();
    const group = new ShapeGroup(rowOf(part), false);
    scene.add(group);
    const fake = Object.assign(Object.create(Viewer.prototype), {
      sceneObjects: [rowOf(part)],
      ctx: { scene },
      assemblyController: null,
    });
    (Viewer.prototype as unknown as { applyShapeHighlight: (id: string) => void }).applyShapeHighlight.call(fake, 'surface-1');

    expect(colorOf(faceMeshesOf(group)[0])).toBe(themeColors.highlightColor.getHex());
    const rim = linesOf(group).find(line => line.userData.boundaryEdge)!;
    expect(colorOf(rim)).toBe(themeColors.sheetBoundary.getHex());
  });
});
