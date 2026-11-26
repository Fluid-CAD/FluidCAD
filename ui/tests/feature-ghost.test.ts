// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { DoubleSide, Mesh, MeshPhongMaterial, Object3D, PerspectiveCamera, Scene } from 'three';
import type { GhostSolid } from '../src/api';
import { FeatureGhostOverlay } from '../src/interactive/create-feature/feature-ghost';
import { themeColors } from '../src/scene/theme-colors';
import type { Viewer } from '../src/viewer';

// The preview overlay draws what a dialog would produce. A surface tool's
// preview is a body of kind `surface`: the surface body mesh in the ghost's
// own material — the added body's green, its faces shown from both sides —
// with every line of it, the open rim included, in the ghost's edge colour.

const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

/** A square patch: one face, one inner edge and one rim edge. */
const PATCH: GhostSolid['meshes'] = [
  {
    label: 'solid-faces', vertices: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2, 0, 2, 3], faceMapping: [0, 0],
  },
  { label: 'solid-edges', vertices: [0, 0, 0, 1, 1, 0], normals: [], indices: [0, 1], edgeIndex: 0 },
  { label: 'solid-edges', vertices: [0, 0, 0, 1, 0, 0], normals: [], indices: [0, 1], edgeIndex: 1, boundary: true },
];

function makeOverlay() {
  const scene = new Scene();
  let renders = 0;
  const viewer = {
    sceneContext: { scene, camera: new PerspectiveCamera(), requestRender: () => { renders++; } },
  } as unknown as Viewer;
  const overlay = new FeatureGhostOverlay(viewer);
  disposers.push(() => overlay.dispose());
  const group = scene.getObjectByName('featureGhost')!;
  return { overlay, group, renders: () => renders };
}

function facesOf(root: Object3D): Mesh[] {
  const found: Mesh[] = [];
  root.traverse(node => {
    if ((node as Mesh).isMesh && !node.userData.isEdgeLine) {
      found.push(node as Mesh);
    }
  });
  return found;
}

function linesOf(root: Object3D): Object3D[] {
  const found: Object3D[] = [];
  root.traverse(node => {
    if (node.userData.isEdgeLine) {
      found.push(node);
    }
  });
  return found;
}

function lineStyle(line: Object3D): { color: number; width: number } {
  const material = (line as unknown as { material: { color: { getHex(): number }; linewidth: number } }).material;
  return { color: material.color.getHex(), width: material.linewidth };
}

describe('FeatureGhostOverlay', () => {
  it('draws a surface body as a surface, in the ghost material, seen from both sides', () => {
    const { overlay, group, renders } = makeOverlay();
    overlay.set([{ meshes: PATCH }], 'surface');

    expect(group.children).toHaveLength(1);
    const body = group.children[0];
    expect(body.userData.isSurface).toBe(true);
    expect(body.userData.isSolid).toBeUndefined();

    const faces = facesOf(body);
    expect(faces).toHaveLength(1);
    const material = faces[0].material as MeshPhongMaterial;
    expect(material.side).toBe(DoubleSide);
    expect(material.color.getHex()).toBe(themeColors.ghostAddFaceColor.getHex());
    expect(material.transparent).toBe(true);
    expect(material.opacity).toBeLessThan(1);
    // An overlay: it shows through the model it would join.
    expect(material.depthTest).toBe(false);
    expect(renders()).toBeGreaterThan(0);
  });

  it('draws the rim of a surface body in the ghost edge colour, like its other lines', () => {
    const { overlay, group } = makeOverlay();
    overlay.set([{ meshes: PATCH }], 'surface');

    const lines = linesOf(group);
    expect(lines).toHaveLength(2);
    const rim = lines.find(line => line.userData.boundaryEdge)!;
    const inner = lines.find(line => !line.userData.boundaryEdge)!;
    expect(rim).toBeDefined();
    expect(lineStyle(rim).color).toBe(themeColors.ghostAddEdgeColor.getHex());
    expect(lineStyle(rim)).toEqual(lineStyle(inner));
  });

  it('takes the kind a body names over the dialog\'s own', () => {
    const { overlay, group } = makeOverlay();
    overlay.set([{ meshes: PATCH, kind: 'surface' }, { meshes: PATCH }], 'add');

    expect(group.children).toHaveLength(2);
    expect(group.children[0].userData.isSurface).toBe(true);
    expect(group.children[1].userData.isSolid).toBe(true);
  });

  it('keeps a surface body out of every pick, and clears it', () => {
    const { overlay, group } = makeOverlay();
    overlay.set([{ meshes: PATCH }], 'surface');

    group.traverse(node => expect(node.userData.isMetaShape).toBe(true));
    overlay.clear();
    expect(group.children).toHaveLength(0);
  });
});
