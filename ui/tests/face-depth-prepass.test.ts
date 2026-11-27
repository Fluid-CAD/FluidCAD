// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshPhongMaterial, OrthographicCamera, PerspectiveCamera,
  Plane, Scene, Vector2, Vector3, type WebGLRenderer, type WebGLRenderTarget, BackSide,
} from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import {
  curveRegion, depthRangeOf, FaceDepthPrepass, faceSagOf, isOpaqueFace,
} from '../src/scene/face-depth-prepass';
import { CurveLineMaterial } from '../src/meshes/shape-meshes/curve-line';

/**
 * A frame with a curve line in it draws the opaque faces' depth first, into
 * a map the curve lines read; a frame without one renders exactly as before.
 */

function camera(): PerspectiveCamera {
  const cam = new PerspectiveCamera(50, 1, 0.5, 1000);
  cam.position.set(0, 0, 50);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

/** A unit-ish face mesh of the model: a quad with flat normals and a face mapping. */
function face(material = new MeshPhongMaterial()): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-5, -5, 0, 5, -5, 0, 5, 5, 0, -5, 5, 0]), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const mesh = new Mesh(geometry, material);
  mesh.userData.faceMapping = [0, 0];
  return mesh;
}

function curve(): LineSegments2 {
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions([-2, 0, 1, 0, 1, 1, 0, 1, 1, 2, 0, 1]);
  const line = new LineSegments2(geometry, new CurveLineMaterial({ linewidth: 2 }));
  line.userData.isEdgeLine = true;
  return line;
}

type RenderCall = { scene: Scene; target: WebGLRenderTarget | null; boundDuringRender: number[] };

/** A renderer that records its draws: which scene, into which target, and what the curve lines were bound to then. */
function fakeRenderer(options: { float?: boolean; size?: [number, number]; lines?: () => LineSegments2[] } = {}) {
  const calls: RenderCall[] = [];
  let target: WebGLRenderTarget | null = null;
  let size = options.size ?? [400, 300];
  const renderer = {
    extensions: { has: (name: string) => (options.float ?? true) && name === 'EXT_color_buffer_float' },
    getRenderTarget: () => target,
    setRenderTarget: vi.fn((next: WebGLRenderTarget | null) => { target = next; }),
    getDrawingBufferSize: (out: Vector2) => out.set(size[0], size[1]),
    getPixelRatio: () => 1,
    getClearAlpha: () => 0,
    getClearColor: (out: Color) => out.set(0x123456),
    setClearColor: vi.fn(),
    autoClear: true,
    localClippingEnabled: true,
    clippingPlanes: [] as Plane[],
    clear: vi.fn(),
    render: vi.fn((scene: Scene) => {
      calls.push({
        scene,
        target,
        boundDuringRender: (options.lines?.() ?? []).map(l => (l.material as CurveLineMaterial).uniforms.faceDepthReady.value),
      });
    }),
  };
  return {
    renderer: renderer as unknown as WebGLRenderer,
    calls,
    resize: (w: number, h: number) => { size = [w, h]; },
  };
}

function sceneWith(...objects: Parameters<Scene['add']>): Scene {
  const scene = new Scene();
  scene.add(...objects);
  return scene;
}

describe('FaceDepthPrepass', () => {
  it('renders a model with no curve exactly as before: one render, no target, no map', () => {
    const { renderer, calls } = fakeRenderer();
    const pass = new FaceDepthPrepass();
    const scene = sceneWith(face());
    pass.render(renderer, scene, camera());
    expect(calls).toHaveLength(1);
    expect(calls[0].scene).toBe(scene);
    expect(calls[0].target).toBeNull();
    expect(renderer.setRenderTarget).not.toHaveBeenCalled();
    expect(pass.mapSize).toBeNull();
  });

  it('draws the faces into a drawing-buffer-sized map first, and binds the curves to it for the main pass only', () => {
    const line = curve();
    const { renderer, calls } = fakeRenderer({ lines: () => [line] });
    const pass = new FaceDepthPrepass();
    const scene = sceneWith(face(), line);
    pass.render(renderer, scene, camera());

    expect(calls).toHaveLength(2);
    expect(calls[0].scene).not.toBe(scene);
    expect(calls[0].target).not.toBeNull();
    expect(calls[1].scene).toBe(scene);
    expect(calls[1].target).toBeNull();
    expect(calls[1].boundDuringRender).toEqual([1]);
    expect(pass.mapSize).toEqual({ width: 400, height: 300 });
    // The map is drawn only where the curve can draw, around its projection.
    const map = calls[0].target!;
    expect(map.scissorTest).toBe(true);
    expect(map.scissor.z).toBeGreaterThan(0);
    expect(map.scissor.z).toBeLessThan(400);
    // Unbound after the frame, and the renderer handed back as found.
    expect((line.material as CurveLineMaterial).uniforms.faceDepthReady.value).toBe(0);
    expect((line.material as CurveLineMaterial).uniforms.faceDepth.value).toBeNull();
    expect(renderer.autoClear).toBe(true);
    expect(renderer.getRenderTarget()).toBeNull();
  });

  it('draws only the opaque, visible faces of the model, with their side and clipping', () => {
    const line = curve();
    const { renderer, calls } = fakeRenderer({ lines: () => [line] });
    const clip = new Plane(new Vector3(1, 0, 0), 0);
    const kept = face(new MeshPhongMaterial({ side: BackSide }));
    (kept.material as MeshPhongMaterial).clippingPlanes = [clip];
    const translucent = face(new MeshPhongMaterial({ transparent: true, opacity: 0.4 }));
    const ghost = face();
    ghost.userData.isMetaShape = true;
    const hiddenParent = new Group();
    hiddenParent.visible = false;
    hiddenParent.add(face());
    const notAFace = new Mesh(face().geometry, new MeshPhongMaterial());
    new FaceDepthPrepass().render(renderer, sceneWith(kept, translucent, ghost, hiddenParent, notAFace, line), camera());

    const proxies = calls[0].scene.children as Mesh[];
    expect(proxies).toHaveLength(1);
    expect(proxies[0].geometry).toBe(kept.geometry);
    const material = proxies[0].material as { side: number; clippingPlanes: Plane[] | null };
    expect(material.side).toBe(BackSide);
    expect(material.clippingPlanes).toEqual([clip]);
  });

  it('reuses an unchanged map, and redraws it when the camera moves', () => {
    const line = curve();
    const { renderer } = fakeRenderer({ lines: () => [line] });
    const pass = new FaceDepthPrepass();
    const scene = sceneWith(face(), line);
    const cam = camera();
    pass.render(renderer, scene, cam);
    pass.render(renderer, scene, cam);
    expect(pass.drawCount).toBe(1);
    cam.position.set(5, 0, 50);
    cam.updateMatrixWorld(true);
    pass.render(renderer, scene, cam);
    expect(pass.drawCount).toBe(2);
  });

  it('follows the drawing buffer when the canvas or its pixel ratio changes', () => {
    const line = curve();
    const { renderer, resize } = fakeRenderer({ lines: () => [line] });
    const pass = new FaceDepthPrepass();
    const scene = sceneWith(face(), line);
    pass.render(renderer, scene, camera());
    resize(800, 600);
    pass.render(renderer, scene, camera());
    expect(pass.mapSize).toEqual({ width: 800, height: 600 });
    expect(pass.drawCount).toBe(2);
  });

  it('frees the map once no curve is left, and on dispose', () => {
    const line = curve();
    const { renderer, calls } = fakeRenderer({ lines: () => [line] });
    const pass = new FaceDepthPrepass();
    const scene = sceneWith(face(), line);
    pass.render(renderer, scene, camera());
    const disposed = vi.fn();
    calls[0].target!.addEventListener('dispose', disposed);
    line.visible = false;
    pass.render(renderer, scene, camera());
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(pass.mapSize).toBeNull();
    expect(calls).toHaveLength(3);

    line.visible = true;
    pass.render(renderer, scene, camera());
    const again = vi.fn();
    calls[3].target!.addEventListener('dispose', again);
    pass.dispose();
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('draws no map without a float colour target, or with no face to test against: the lines draw as plain lines', () => {
    const line = curve();
    for (const [float, objects] of [[false, [face(), line]], [true, [line]]] as const) {
      const { renderer, calls } = fakeRenderer({ float, lines: () => [line] });
      new FaceDepthPrepass().render(renderer, sceneWith(...objects), camera());
      expect(calls).toHaveLength(1);
      expect(calls[0].boundDuringRender).toEqual([0]);
    }
  });

  it('sizes the map to a render target the frame is drawn into', () => {
    const line = curve();
    const { renderer, calls } = fakeRenderer({ lines: () => [line] });
    const output = { width: 640, height: 480 } as WebGLRenderTarget;
    renderer.setRenderTarget(output);
    const pass = new FaceDepthPrepass();
    pass.render(renderer, sceneWith(face(), line), camera());
    expect(pass.mapSize).toEqual({ width: 640, height: 480 });
    expect(calls[1].target).toBe(output);
  });

  it('unbinds the lines even when the main pass throws', () => {
    const line = curve();
    const { renderer } = fakeRenderer({ lines: () => [line] });
    let count = 0;
    (renderer.render as unknown as { mockImplementation: (f: () => void) => void }).mockImplementation(() => {
      if (++count === 2) {
        throw new Error('lost context');
      }
    });
    expect(() => new FaceDepthPrepass().render(renderer, sceneWith(face(), line), camera())).toThrow('lost context');
    expect((line.material as CurveLineMaterial).uniforms.faceDepthReady.value).toBe(0);
  });
});

describe('which faces the map holds', () => {
  it('takes an opaque, depth-writing face mesh of the model, or a section view\'s unclipped copy of one', () => {
    expect(isOpaqueFace(face())).toBe(true);
    expect(isOpaqueFace(face(new MeshPhongMaterial({ transparent: true })))).toBe(false);
    expect(isOpaqueFace(face(new MeshPhongMaterial({ depthWrite: false })))).toBe(false);
    expect(isOpaqueFace(face(new MeshPhongMaterial({ visible: false })))).toBe(false);
    expect(isOpaqueFace(face(new MeshPhongMaterial({ colorWrite: false })))).toBe(false);
    const meta = face();
    meta.userData.isMetaShape = true;
    expect(isOpaqueFace(meta)).toBe(false);
    expect(isOpaqueFace(new Mesh(face().geometry, new MeshPhongMaterial()))).toBe(false);

    const source = face();
    const overlay = new Mesh(source.geometry, new MeshPhongMaterial());
    overlay.userData.isSectionOverlay = true;
    source.add(overlay);
    expect(isOpaqueFace(overlay)).toBe(true);
    // A line is never a face, whatever it hangs off.
    const lineOverlay = new LineSegments2(new LineSegmentsGeometry(), new CurveLineMaterial());
    lineOverlay.userData.isSectionOverlay = true;
    source.add(lineOverlay);
    expect(isOpaqueFace(lineOverlay)).toBe(false);
    const plainLine = new LineSegments2(new LineSegmentsGeometry(), new LineMaterial());
    plainLine.userData.faceMapping = [0];
    expect(isOpaqueFace(plainLine)).toBe(false);
  });
});

describe('the depth range a camera projects with', () => {
  it('reads near and far back from either projection, the orthographic one reaching behind the eye', () => {
    const persp = new PerspectiveCamera(50, 1.5, 0.25, 4000);
    persp.updateProjectionMatrix();
    const p = depthRangeOf(persp);
    expect(p.near).toBeCloseTo(0.25, 6);
    expect(p.far / 4000).toBeCloseTo(1, 4);
    const ortho = new OrthographicCamera(-10, 10, 10, -10, -3000, 3000);
    ortho.updateProjectionMatrix();
    const o = depthRangeOf(ortho);
    expect(o.near).toBeCloseTo(-3000, 3);
    expect(o.far).toBeCloseTo(3000, 3);
  });
});

describe('the region a curve can draw in', () => {
  it('is its projection grown by its line width, null off screen, the whole buffer when it reaches behind the eye', () => {
    const line = curve();
    const cam = camera();
    const region = curveRegion([line], cam, 400, 300, 1)!;
    expect(region.x).toBeGreaterThan(150);
    expect(region.x + region.width).toBeLessThan(250);
    expect(region.y).toBeGreaterThan(100);
    expect(region.y + region.height).toBeLessThan(200);

    line.position.set(500, 0, 0);
    line.updateMatrixWorld(true);
    expect(curveRegion([line], cam, 400, 300, 1)).toBeNull();

    line.position.set(0, 0, 60);
    line.updateMatrixWorld(true);
    expect(curveRegion([line], cam, 400, 300, 1)).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });
});

describe('a face mesh\'s chordal sag', () => {
  /** A cylinder of radius r and height h in n facets, one quad per facet, its sides diagonal across it. */
  function cylinder(r: number, h: number, n: number): BufferGeometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const index: number[] = [];
    for (let i = 0; i <= n; i++) {
      const a = (2 * Math.PI * i) / n;
      for (const z of [0, h]) {
        positions.push(r * Math.cos(a), r * Math.sin(a), z);
        normals.push(Math.cos(a), Math.sin(a), 0);
      }
      if (i > 0) {
        const b = (i - 1) * 2;
        index.push(b, b + 2, b + 3, b, b + 3, b + 1);
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
    geometry.setIndex(index);
    return geometry;
  }

  it('is none for a flat face, and the facets\' sagitta for a cylinder however long its diagonal sides run', () => {
    expect(faceSagOf(face().geometry)).toBe(0);
    const sagitta = 5 * (1 - Math.cos(Math.PI / 36));
    expect(faceSagOf(cylinder(5, 50, 36))).toBeCloseTo(sagitta, 3);
    // A tall cylinder's sides are 50 long: their length across the axis, not along it, is what bows.
    expect(faceSagOf(cylinder(5, 500, 36))).toBeCloseTo(sagitta, 3);
  });

  it('ignores a crease across one side, and keeps its answer per geometry', () => {
    const geometry = face().geometry;
    const normal = geometry.getAttribute('normal') as BufferAttribute;
    normal.setXYZ(2, 1, 0, 0);
    expect(faceSagOf(geometry)).toBe(0);
    const cyl = cylinder(5, 10, 12);
    const first = faceSagOf(cyl);
    (cyl.getAttribute('normal') as BufferAttribute).setXYZ(0, 0, 0, 1);
    expect(faceSagOf(cyl)).toBe(first);
  });
});
