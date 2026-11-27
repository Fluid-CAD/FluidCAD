// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ShaderLib, Texture } from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import {
  chordSag,
  CURVE_LINE_FRAGMENT_SHADER,
  CURVE_LINE_VERTEX_SHADER,
  CurveLineMaterial,
  curveSagOf,
  isCurveLineMaterial,
  patchCurveFragmentShader,
  patchCurveVertexShader,
} from '../src/meshes/shape-meshes/curve-line';
import { FaceEdgeMaterial } from '../src/meshes/shape-meshes/face-edge-line';
import { EdgeMesh } from '../src/meshes/shape-meshes/edge-mesh';
import { ShapeGroup } from '../src/meshes/containers/shape-group';
import type { SceneObjectMesh, SceneObjectRender } from '../src/types';

/**
 * A curve's line (a scene object of only wires or edges) is visible where
 * its centerline is: its fragments test the centerline against a map of the
 * faces' depth instead of sinking, band half by band half, into the faces
 * it lies on.
 */

/** A polyline of `n` chords around a circle of radius `r`, as an engine edge mesh. */
function circleMesh(r: number, n: number): SceneObjectMesh {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (2 * Math.PI * i) / n;
    vertices.push(r * Math.cos(a), r * Math.sin(a), 0);
    if (i > 0) {
      indices.push(i - 1, i);
    }
  }
  return { vertices, normals: [], indices };
}

function firstLine(root: { traverse(fn: (o: any) => void): void }): LineSegments2 {
  let found: LineSegments2 | null = null;
  root.traverse(o => {
    if (!found && o.userData.isEdgeLine) {
      found = o as LineSegments2;
    }
  });
  return found!;
}

describe('curve line shaders', () => {
  it('hands the fragment its segment: its clip position, the ends on screen, their depth and w', () => {
    expect(CURVE_LINE_VERTEX_SHADER).toContain('varying vec4 vCurveClip;');
    expect(CURVE_LINE_VERTEX_SHADER).toContain('vCurveClip = clip;');
    expect(CURVE_LINE_VERTEX_SHADER).toContain('vCurveSegment = vec4( ndcStart.xy, ndcEnd.xy );');
    expect(CURVE_LINE_VERTEX_SHADER).toContain('vCurveDepth = vec4( start.z, end.z, clipStart.w, clipEnd.w );');
    // The band itself is untouched: LineMaterial's own offset and caps.
    expect(CURVE_LINE_VERTEX_SHADER).toContain('if ( position.x < 0.0 ) offset *= - 1.0;');
  });

  it('tests the centerline against the faces in view space, with both cameras, and writes its depth in front of the face under it', () => {
    expect(CURVE_LINE_FRAGMENT_SHADER).toContain('#include <packing>');
    expect(CURVE_LINE_FRAGMENT_SHADER).toContain('perspectiveDepthToViewZ');
    expect(CURVE_LINE_FRAGMENT_SHADER).toContain('orthographicDepthToViewZ');
    expect(CURVE_LINE_FRAGMENT_SHADER).toContain('centerlineVisible(');
    expect(CURVE_LINE_FRAGMENT_SHADER).toContain('discard;');
    expect(CURVE_LINE_FRAGMENT_SHADER).toContain('gl_FragDepth = curveFragDepth;');
    // The test runs after clipping and before LineMaterial's own coverage.
    const clip = CURVE_LINE_FRAGMENT_SHADER.indexOf('#include <clipping_planes_fragment>');
    const test = CURVE_LINE_FRAGMENT_SHADER.indexOf('centerlineVisible( ( center');
    const coverage = CURVE_LINE_FRAGMENT_SHADER.indexOf('USE_ALPHA_TO_COVERAGE', test);
    expect(clip).toBeGreaterThan(0);
    expect(test).toBeGreaterThan(clip);
    expect(coverage).toBeGreaterThan(test);
  });

  it('refuses a shader that no longer has an anchor', () => {
    const vertex = ShaderLib.line.vertexShader.replace('gl_Position = clip;', 'gl_Position = vec4( clip );');
    expect(() => patchCurveVertexShader(vertex)).toThrow(/gl_Position = clip;/);
    const fragment = ShaderLib.line.fragmentShader.replace('#include <clipping_planes_fragment>', '');
    expect(() => patchCurveFragmentShader(fragment)).toThrow(/clipping_planes_fragment/);
  });
});

describe('CurveLineMaterial', () => {
  it('is a LineMaterial with its own shaders, unbound until a frame binds the map', () => {
    const material = new CurveLineMaterial({ color: 0x2297ff, linewidth: 2, depthTest: true, depthWrite: true });
    expect(material).toBeInstanceOf(LineMaterial);
    expect(isCurveLineMaterial(material)).toBe(true);
    expect(isCurveLineMaterial(new LineMaterial())).toBe(false);
    expect(material.vertexShader).toBe(CURVE_LINE_VERTEX_SHADER);
    expect(material.fragmentShader).toBe(CURVE_LINE_FRAGMENT_SHADER);
    expect(material.color.getHex()).toBe(0x2297ff);
    expect(material.linewidth).toBe(2);
    // The hardware test stays on: what the map does not hold still hides it.
    expect(material.depthTest).toBe(true);
    expect(material.depthWrite).toBe(true);
    expect(material.uniforms.faceDepthReady.value).toBe(0);
    expect(material.uniforms.faceDepth.value).toBeNull();
  });

  it('binds a frame\'s map and lets go of it after', () => {
    const material = new CurveLineMaterial();
    const texture = new Texture();
    material.bindFaceDepth({ texture, width: 800, height: 600, near: 0.5, far: 5000, pixel: 0.004 }, 0.02);
    expect(material.uniforms.faceDepth.value).toBe(texture);
    expect(material.uniforms.faceDepthReady.value).toBe(1);
    expect(material.uniforms.faceDepthSize.value.toArray()).toEqual([800, 600]);
    expect(material.uniforms.faceDepthNear.value).toBe(0.5);
    expect(material.uniforms.faceDepthFar.value).toBe(5000);
    expect(material.uniforms.faceDepthPixel.value).toBe(0.004);
    expect(material.uniforms.curveSag.value).toBe(0.02);
    material.bindFaceDepth(null);
    expect(material.uniforms.faceDepth.value).toBeNull();
    expect(material.uniforms.faceDepthReady.value).toBe(0);
    expect(material.uniforms.curveSag.value).toBe(0);
  });

  it("keeps its class, shaders and uniforms through a clone (a section view's coplanar overlay clones it)", () => {
    const material = new CurveLineMaterial({ linewidth: 3 });
    const clone = material.clone() as CurveLineMaterial;
    expect(clone).toBeInstanceOf(CurveLineMaterial);
    expect(clone.fragmentShader).toBe(CURVE_LINE_FRAGMENT_SHADER);
    expect(clone.linewidth).toBe(3);
    expect(clone.uniforms.faceDepthReady.value).toBe(0);
    expect(clone.uniforms.faceDepthSize).toBeDefined();
  });
});

describe('a curve\'s chordal sag', () => {
  it('is the bow of a chord from its arc', () => {
    // A chord of a circle of radius 10 cut by a 0.2 rad turn: 10 (1 - cos 0.1).
    const length = 2 * 10 * Math.sin(0.1);
    expect(chordSag(length, 0.2)).toBeCloseTo(10 * (1 - Math.cos(0.1)), 6);
    expect(chordSag(5, 0)).toBe(0);
    // A turn this sharp is a corner, not a chord of a curve.
    expect(chordSag(5, Math.PI / 2)).toBe(0);
  });

  it('measures a polyline: none for a straight one, the arc\'s sagitta for a circle', () => {
    const straight = EdgeMesh.buildGeometry({ vertices: [0, 0, 0, 1, 0, 0, 3, 0, 0], normals: [], indices: [0, 1, 1, 2] });
    expect(curveSagOf(straight)).toBe(0);
    const circle = EdgeMesh.buildGeometry(circleMesh(10, 36));
    expect(curveSagOf(circle)).toBeCloseTo(10 * (1 - Math.cos(Math.PI / 36)), 4);
  });

  it('reads no turn across a gap between segments, and keeps its answer per geometry', () => {
    const apart = new LineSegmentsGeometry();
    apart.setPositions([0, 0, 0, 1, 0, 0, 5, 5, 0, 5, 6, 0]);
    expect(curveSagOf(apart)).toBe(0);
    const circle = EdgeMesh.buildGeometry(circleMesh(4, 12));
    const first = curveSagOf(circle);
    circle.setPositions([0, 0, 0, 1, 0, 0]);
    expect(curveSagOf(circle)).toBe(first);
  });
});

describe('where the curve material is used', () => {
  it('draws a depth-tested curve line with it, and a line drawn over everything without', () => {
    const curve = new EdgeMesh({ shapeType: 'edge', meshes: [circleMesh(5, 8)] }, { color: '#2297ff', lineWidth: 2, curve: true });
    expect(firstLine(curve).material).toBeInstanceOf(CurveLineMaterial);
    const ghost = new EdgeMesh({ shapeType: 'edge', meshes: [circleMesh(5, 8)] }, { curve: true, depthWrite: false });
    expect(firstLine(ghost).material).not.toBeInstanceOf(CurveLineMaterial);
    const plain = new EdgeMesh({ shapeType: 'edge', meshes: [circleMesh(5, 8)] });
    expect(firstLine(plain).material).not.toBeInstanceOf(CurveLineMaterial);
  });

  it('gives a scene object of only wires or edges the curve line, and a solid\'s edges their face-edge lines', () => {
    const row = (sceneShapes: SceneObjectRender['sceneShapes']): SceneObjectRender => (
      { id: 'r', name: 'Row', type: 'helix', visible: true, sceneShapes } as unknown as SceneObjectRender
    );
    const curve = new ShapeGroup(row([{ shapeId: 's1', shapeType: 'edge', meshes: [circleMesh(5, 8)] }]), false);
    expect(firstLine(curve).material).toBeInstanceOf(CurveLineMaterial);
    expect((firstLine(curve).material as CurveLineMaterial).color.getHex()).toBe(0x2297ff);

    const tri = { vertices: [0, 0, 0, 1, 0, 0, 1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] };
    const edge = {
      label: 'solid-edges', vertices: [0, 0, 0, 1, 0, 0], normals: [], indices: [0, 1], edgeIndex: 0,
      faceSides: [0, 1, 0, 0, 0, 1],
    };
    const solid = new ShapeGroup(row([
      { shapeId: 's2', shapeType: 'solid', meshes: [{ ...tri, label: 'solid-faces', faceMapping: [0] }, edge] },
    ]), false);
    expect(firstLine(solid).material).toBeInstanceOf(FaceEdgeMaterial);
    expect(firstLine(solid).material).not.toBeInstanceOf(CurveLineMaterial);

    // A select overlay styles its lines itself, drawn over the model.
    const selected = new ShapeGroup(row([{ shapeId: 's3', shapeType: 'edge', meshes: [circleMesh(5, 8)] }]), false, {
      edge: { color: '#ff00ff', lineWidth: 3, depthWrite: false },
    });
    expect(firstLine(selected).material).not.toBeInstanceOf(CurveLineMaterial);
  });
});
