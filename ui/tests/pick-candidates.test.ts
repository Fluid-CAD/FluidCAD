// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Group, LineSegments, Mesh, Object3D } from 'three';
import { collectPickCandidates, type PickChannels } from '../src/interactive/pick-candidates';
import { ShapeGroup } from '../src/meshes/containers/shape-group';
import type { SceneObjectRender } from '../src/types';

const ALL_CHANNELS: PickChannels = { sketchWires: true, axes: true, planes: true };
const NO_CHANNELS: PickChannels = { sketchWires: false, axes: false, planes: false };

/** A shape container the way ShapeGroup builds it: shapeId on the parent, pickable leaves under it. */
function shapeWithFaceAndEdge(shapeId: string): Group {
  const container = new Group();
  container.userData.shapeId = shapeId;

  const face = new Mesh();
  face.userData.faceMapping = [0, 1, 2];
  container.add(face);

  const edge = new LineSegments();
  edge.userData.edgeIndex = 0;
  container.add(edge);

  return container;
}

describe('collectPickCandidates', () => {
  it('collects faces and edges of a visible shape', () => {
    const root = new Object3D();
    root.add(shapeWithFaceAndEdge('shape-a'));

    const candidates = collectPickCandidates(root, ALL_CHANNELS);

    expect(candidates.faces).toHaveLength(1);
    expect(candidates.edges).toHaveLength(1);
  });

  // The bug this guards: hiding sets `visible = false` on the shapeId container
  // only, and three's Raycaster ignores `visible` — so a plain `traverse` here
  // left hidden shapes fully selectable in the viewport.
  it('drops a hidden shape even though its leaves stay flagged visible', () => {
    const root = new Object3D();
    const hidden = shapeWithFaceAndEdge('shape-a');
    hidden.visible = false;
    root.add(hidden);

    expect(hidden.children.every((child) => child.visible)).toBe(true);

    const candidates = collectPickCandidates(root, ALL_CHANNELS);

    expect(candidates.faces).toHaveLength(0);
    expect(candidates.edges).toHaveLength(0);
  });

  it('hiding one shape leaves its siblings pickable', () => {
    const root = new Object3D();
    const hidden = shapeWithFaceAndEdge('shape-a');
    hidden.visible = false;
    root.add(hidden);
    root.add(shapeWithFaceAndEdge('shape-b'));

    const candidates = collectPickCandidates(root, ALL_CHANNELS);

    expect(candidates.faces).toHaveLength(1);
    expect(candidates.edges).toHaveLength(1);
  });

  it('skips meta-shape targets', () => {
    const root = new Object3D();
    const meta = new Mesh();
    meta.userData.isMetaShape = true;
    meta.userData.faceMapping = [0];
    root.add(meta);

    expect(collectPickCandidates(root, ALL_CHANNELS).faces).toHaveLength(0);
  });

  it('collects sketch wires, axes and plane quads only while their channel is armed', () => {
    const root = new Object3D();

    const wire = new LineSegments();
    wire.userData.isSketchWire = true;
    root.add(wire);

    const axis = new LineSegments();
    axis.userData.isAxisLine = true;
    root.add(axis);

    const quad = new Mesh();
    quad.userData.isConstructionPlaneQuad = true;
    root.add(quad);

    const armed = collectPickCandidates(root, ALL_CHANNELS);
    expect(armed.sketchWires).toHaveLength(1);
    expect(armed.axes).toHaveLength(1);
    expect(armed.planeQuads).toHaveLength(1);

    const disarmed = collectPickCandidates(root, NO_CHANNELS);
    expect(disarmed.sketchWires).toHaveLength(0);
    expect(disarmed.axes).toHaveLength(0);
    expect(disarmed.planeQuads).toHaveLength(0);
  });

  // A bare single-edge shape (a helix wire) serializes without a per-edge
  // index — ShapeGroup gives its lines the pick identity {edge, 0} so the
  // wire is clickable in the viewport (the plane/sweep dialogs' helix picks).
  it('a helix wire built by ShapeGroup is an edge pick candidate with index 0', () => {
    const helix: SceneObjectRender = {
      id: 'helix-1',
      type: 'helix',
      sceneShapes: [{
        shapeId: 'wire-shape',
        shapeType: 'edge',
        meshes: [{ vertices: [0, 0, 0, 1, 0, 0, 1, 1, 0], normals: [], indices: [0, 1, 1, 2] }],
      }],
      ownShapes: [],
    };

    const root = new Object3D();
    root.add(new ShapeGroup(helix, false));

    const candidates = collectPickCandidates(root, NO_CHANNELS);
    expect(candidates.edges).toHaveLength(1);
    expect(candidates.edges[0].userData.edgeIndex).toBe(0);
  });

  it('hidden sketch wires, axes and plane quads stay out even while armed', () => {
    const root = new Object3D();

    const wire = new LineSegments();
    wire.userData.isSketchWire = true;
    wire.visible = false;
    root.add(wire);

    const axis = new LineSegments();
    axis.userData.isAxisLine = true;
    axis.visible = false;
    root.add(axis);

    const quad = new Mesh();
    quad.userData.isConstructionPlaneQuad = true;
    quad.visible = false;
    root.add(quad);

    const candidates = collectPickCandidates(root, ALL_CHANNELS);

    expect(candidates.sketchWires).toHaveLength(0);
    expect(candidates.axes).toHaveLength(0);
    expect(candidates.planeQuads).toHaveLength(0);
  });
});
