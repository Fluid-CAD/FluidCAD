import {
  type BufferGeometry, type Camera, Color, FloatType, type Material, Matrix4, Mesh, NearestFilter, NoBlending,
  type Object3D, RGBAFormat, Scene, ShaderMaterial, Vector2, Vector4, type WebGLRenderer, WebGLRenderTarget,
} from 'three';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import {
  curveSagOf, isCurveLineMaterial, type CurveLineMaterial, type FaceDepthBinding,
} from '../meshes/shape-meshes/curve-line';

/**
 * The faces' depth, drawn first in a frame that has a curve line in it.
 *
 * A curve's line is visible where its centerline is (see
 * meshes/shape-meshes/curve-line.ts), which it can only tell against the
 * depth of the faces around it — the faces the main pass is about to draw.
 * So when the scene holds at least one visible line drawn with
 * `CurveLineMaterial`, the opaque faces are drawn first into a map the size
 * of the drawing buffer: per pixel the nearest face's window depth, its
 * slopes along x and y (the line carries each face's plane to the exact
 * sub-pixel point it asks about) and the face mesh's chordal sag in world
 * units (how far that face can stand in front of a curve lying on it). The
 * lines are bound to the map for the main pass and unbound after it. A frame
 * with no curve line renders exactly as before: one `renderer.render`. Only
 * the curves' extent on screen is drawn — the only pixels a line reads — and
 * a frame that changes nothing the map is drawn from (a hover's redraw)
 * reuses the last one.
 *
 * The map is a colour target, not a depth texture: a depth texture holds
 * the depth alone, and the plane through each pixel needs the slopes beside
 * it. It is drawn from stand-ins in a scene of its own, one per face mesh,
 * sharing its geometry and world placement with a depth-only material that
 * copies its side and clipping — the vertex dots' occlusion map does the
 * same (interactive/occluder-depth.ts). The alternatives draw the main scene
 * twice: a layer mask would run every face's own shading (and every
 * object's onBeforeRender) for a picture nobody sees, and an override
 * material drops the per-material clipping planes a section view cuts with.
 *
 * Which faces: exactly those the main pass draws opaque and depth-writing —
 * visible all the way up (hidden objects drop out, as do whole subtrees a
 * focus or solids-only capture hides), on a layer the camera sees, a face
 * mesh of the model (`faceMapping`, the faces that hide vertices and edges
 * from a pick) or a section view's unclipped copy of one, and not meta (no
 * ghost, no overlay). A face drawn translucent (an assembly instance, a
 * ghosted context, a hover tint) is left out: the line is drawn before it
 * and shows through it as it always has. Whatever the map does not hold
 * still hides the line through the hardware depth test it keeps.
 */
export class FaceDepthPrepass {
  private target: WebGLRenderTarget | null = null;
  private floatTargets: boolean | null = null;
  private readonly scene = new Scene();
  private readonly proxies = new Map<Mesh, Mesh<BufferGeometry, ShaderMaterial>>();
  private readonly size = new Vector2();
  private readonly clearColor = new Color();
  /** Everything the map was last drawn from: an unchanged frame (a hover's redraw) reuses it. */
  private signature: number[] = [];
  /** How many times the map has been drawn, for tests and diagnostics. */
  drawCount = 0;

  constructor() {
    this.scene.matrixWorldAutoUpdate = false;
  }

  /** The map's size now, for tests and diagnostics: null while there is none. */
  get mapSize(): { width: number; height: number } | null {
    return this.target ? { width: this.target.width, height: this.target.height } : null;
  }

  /**
   * Render `scene` through `camera` into the renderer's current target,
   * drawing the faces' map first when the scene has a curve line to test
   * against it.
   */
  render(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
    const { curves, faces } = this.collect(scene, camera);
    if (curves.length === 0) {
      // Nothing reads a map: free it, and draw exactly as before.
      this.release();
      renderer.render(scene, camera);
      return;
    }
    this.floatTargets ??= renderer.extensions.has('EXT_color_buffer_float');
    if (!this.floatTargets) {
      // No float colour target: the lines draw as plain fat lines.
      renderer.render(scene, camera);
      return;
    }

    // The map is drawn before the main pass would bring the world placement
    // of the faces and the camera up to date.
    if (scene.matrixWorldAutoUpdate) {
      scene.updateMatrixWorld();
    }
    if (camera.parent === null && camera.matrixWorldAutoUpdate) {
      camera.updateMatrixWorld();
    }

    const output = renderer.getRenderTarget();
    if (output) {
      this.size.set(output.width, output.height);
    } else {
      renderer.getDrawingBufferSize(this.size);
    }
    const width = Math.max(1, Math.floor(this.size.x));
    const height = Math.max(1, Math.floor(this.size.y));
    const region = faces.length > 0 ? curveRegion(curves, camera, width, height, renderer.getPixelRatio()) : null;
    const binding = region ? this.update(renderer, camera, faces, width, height, region) : null;
    for (const line of curves) {
      const sag = binding ? curveSagOf(line.geometry) * line.matrixWorld.getMaxScaleOnAxis() : 0;
      (line.material as CurveLineMaterial).bindFaceDepth(binding, sag);
    }
    try {
      renderer.render(scene, camera);
    } finally {
      for (const line of curves) {
        (line.material as CurveLineMaterial).bindFaceDepth(null);
      }
    }
  }

  /** Free the map and its stand-ins until a frame has a curve line again. */
  release(): void {
    this.target?.dispose();
    this.target = null;
    this.signature = [];
    for (const proxy of this.proxies.values()) {
      proxy.removeFromParent();
      proxy.material.dispose();
    }
    this.proxies.clear();
  }

  dispose(): void {
    this.release();
  }

  /** The visible curve lines and the opaque faces the main pass will draw. */
  private collect(root: Object3D, camera: Camera): { curves: LineSegments2[]; faces: Mesh[] } {
    const curves: LineSegments2[] = [];
    const faces: Mesh[] = [];
    root.traverseVisible((obj) => {
      if (!obj.layers.test(camera.layers)) {
        return;
      }
      const material = (obj as Mesh).material;
      if (isCurveLineMaterial(material)) {
        if (material.visible) {
          curves.push(obj as LineSegments2);
        }
      } else if (isOpaqueFace(obj)) {
        faces.push(obj);
      }
    });
    return { curves, faces };
  }

  /**
   * The map for this frame, `width` × `height` like the buffer it goes to:
   * redrawn inside `region` (the curves' extent on screen, the only pixels
   * a line reads) unless nothing it is drawn from has changed.
   */
  private update(
    renderer: WebGLRenderer, camera: Camera, faces: Mesh[], width: number, height: number, region: ScreenRegion,
  ): FaceDepthBinding {
    if (!this.target) {
      this.target = new WebGLRenderTarget(width, height, {
        format: RGBAFormat, type: FloatType, minFilter: NearestFilter, magFilter: NearestFilter,
        generateMipmaps: false, depthBuffer: true, stencilBuffer: false,
      });
    } else if (this.target.width !== width || this.target.height !== height) {
      this.target.setSize(width, height);
    }
    const signature = signatureOf(renderer, camera, faces, width, height, region);
    if (!sameNumbers(signature, this.signature)) {
      this.signature = signature;
      this.draw(renderer, camera, faces, this.target, region);
    }
    const { near, far } = depthRangeOf(camera);
    return {
      texture: this.target.texture,
      width,
      height,
      near,
      far,
      pixel: 2 / (camera.projectionMatrix.elements[5] * height),
    };
  }

  private draw(renderer: WebGLRenderer, camera: Camera, faces: Mesh[], target: WebGLRenderTarget, region: ScreenRegion): void {
    this.syncProxies(faces);
    target.scissor.set(region.x, region.y, region.width, region.height);
    target.scissorTest = true;
    const output = renderer.getRenderTarget();
    const previousAlpha = renderer.getClearAlpha();
    const previousAutoClear = renderer.autoClear;
    renderer.getClearColor(this.clearColor);
    renderer.setRenderTarget(target);
    // Depth 1 (the far plane), flat: a pixel no face covers hides nothing.
    // Alpha 1, since a premultiplied clear scales the colour by it.
    renderer.setClearColor(0xff0000, 1);
    renderer.autoClear = false;
    try {
      renderer.clear(true, true, false);
      renderer.render(this.scene, camera);
      this.drawCount++;
    } finally {
      renderer.setRenderTarget(output);
      renderer.setClearColor(this.clearColor, previousAlpha);
      renderer.autoClear = previousAutoClear;
    }
  }

  /** One stand-in per face mesh: its geometry and placement, a depth material with its side, clipping and sag. */
  private syncProxies(faces: Mesh[]): void {
    const keep = new Set(faces);
    for (const [source, proxy] of this.proxies) {
      if (!keep.has(source)) {
        proxy.removeFromParent();
        proxy.material.dispose();
        this.proxies.delete(source);
      }
    }
    for (const source of faces) {
      let proxy = this.proxies.get(source);
      if (!proxy) {
        proxy = new Mesh(source.geometry, createDepthMaterial());
        proxy.matrixAutoUpdate = false;
        proxy.matrixWorldAutoUpdate = false;
        this.scene.add(proxy);
        this.proxies.set(source, proxy);
      }
      const material = source.material as Material;
      proxy.geometry = source.geometry;
      proxy.matrixWorld.copy(source.matrixWorld);
      proxy.frustumCulled = source.frustumCulled;
      proxy.material.side = material.side;
      proxy.material.clippingPlanes = material.clippingPlanes;
      proxy.material.clipIntersection = material.clipIntersection;
      proxy.material.uniforms.sag.value = faceSagOf(source.geometry) * source.matrixWorld.getMaxScaleOnAxis();
    }
  }
}

/** A rectangle of the map, in pixels from its bottom-left corner. */
export type ScreenRegion = { x: number; y: number; width: number; height: number };

/** Map pixels kept around the curves' extent beyond their own line width: the four pixels a centerline point reads, and rounding. */
const REGION_PADDING = 4;

/**
 * Where on a `width` × `height` buffer the curve lines can draw: their
 * bounding boxes projected, grown by their line width, clipped to the
 * buffer — the whole buffer when a box reaches behind a perspective eye,
 * null when none is on screen.
 */
export function curveRegion(
  curves: readonly LineSegments2[], camera: Camera, width: number, height: number, pixelRatio: number,
): ScreenRegion | null {
  const viewProjection = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const toClip = new Matrix4();
  const corner = new Vector4();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let lineWidth = 0;
  for (const line of curves) {
    const geometry = line.geometry;
    if (!geometry.boundingBox) {
      geometry.computeBoundingBox();
    }
    const box = geometry.boundingBox;
    if (!box || box.isEmpty()) {
      continue;
    }
    lineWidth = Math.max(lineWidth, (line.material as CurveLineMaterial).linewidth);
    toClip.multiplyMatrices(viewProjection, line.matrixWorld);
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z, 1)
        .applyMatrix4(toClip);
      if (!(corner.w > 0)) {
        return { x: 0, y: 0, width, height };
      }
      const x = (corner.x / corner.w * 0.5 + 0.5) * width;
      const y = (corner.y / corner.w * 0.5 + 0.5) * height;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const pad = Math.ceil(lineWidth * pixelRatio) + REGION_PADDING;
  const x0 = Math.max(0, Math.floor(minX - pad));
  const y0 = Math.max(0, Math.floor(minY - pad));
  const x1 = Math.min(width, Math.ceil(maxX + pad));
  const y1 = Math.min(height, Math.ceil(maxY + pad));
  if (!(x1 > x0 && y1 > y0)) {
    return null;
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Everything the map is drawn from: its size and region, the camera, the clipping, and each face's mesh, placement, side and clipping. */
function signatureOf(
  renderer: WebGLRenderer, camera: Camera, faces: readonly Mesh[], width: number, height: number, region: ScreenRegion,
): number[] {
  const out = [
    width, height, region.x, region.y, region.width, region.height,
    ...camera.matrixWorld.elements, ...camera.projectionMatrix.elements,
    renderer.localClippingEnabled ? 1 : 0, renderer.clippingPlanes.length,
  ];
  for (const plane of renderer.clippingPlanes) {
    out.push(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
  }
  for (const face of faces) {
    const geometry = face.geometry;
    const position = geometry.getAttribute('position') as { version?: number } | undefined;
    out.push(face.id, geometry.id, position?.version ?? -1, geometry.index?.version ?? -1, ...face.matrixWorld.elements);
    const material = face.material as Material;
    const planes = material.clippingPlanes ?? [];
    out.push(material.side, material.clipIntersection ? 1 : 0, planes.length);
    for (const plane of planes) {
      out.push(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    }
  }
  return out;
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * A mesh the main pass draws as an opaque, depth-writing face of the model:
 * a face mesh (`faceMapping`) or a section view's unclipped copy of one,
 * not meta, one visible material drawn opaque with depth.
 */
export function isOpaqueFace(obj: Object3D): obj is Mesh {
  const mesh = obj as Mesh;
  if (!mesh.isMesh || obj.userData.isMetaShape) {
    return false;
  }
  if (!obj.userData.faceMapping && !(obj.userData.isSectionOverlay && obj.parent?.userData.faceMapping)) {
    return false;
  }
  const material = mesh.material;
  // A fat line is a mesh too: never a face, whatever it hangs off.
  if (!material || Array.isArray(material) || (material as Partial<LineMaterial>).isLineMaterial) {
    return false;
  }
  return material.visible && !material.transparent && material.depthWrite && material.depthTest && material.colorWrite;
}

/** The near and far planes `camera`'s projection matrix was built with. */
export function depthRangeOf(camera: Camera): { near: number; far: number } {
  const e = camera.projectionMatrix.elements;
  const p22 = e[10];
  const p32 = e[14];
  if ((camera as Camera & { isOrthographicCamera?: boolean }).isOrthographicCamera) {
    return { near: (p32 + 1) / p22, far: (p32 - 1) / p22 };
  }
  return { near: p32 / (p22 - 1), far: p32 / (p22 + 1) };
}

const faceSags = new WeakMap<BufferGeometry, number>();

/** Normals further apart than this (cos) across one triangle side are a crease or a pole, not a curved face's chord. */
const SAG_MIN_NORMAL_COS = 0.5;

/**
 * How far a face mesh's triangles can stand off the true surface, in its
 * geometry's own units: the largest chordal sag along a triangle side, read
 * from the surface normals the engine gives at the side's ends. The normals
 * turn by the surface's curvature along the side, so `(nb − na) · (pb − pa)
 * / 8` is the side's sagitta, `L² κ / 8`, whatever way the side runs — a
 * side along a cylinder's axis bows not at all, a diagonal one only as much
 * as its turn around the axis. Zero for a flat face. Cached per geometry,
 * which a face's mesh never rewrites.
 */
export function faceSagOf(geometry: BufferGeometry): number {
  const cached = faceSags.get(geometry);
  if (cached !== undefined) {
    return cached;
  }
  let sag = 0;
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  if (position && normal && normal.count === position.count) {
    const index = geometry.getIndex();
    const count = index ? index.count : position.count;
    const vertex = (i: number) => (index ? index.getX(i) : i);
    const side = (a: number, b: number) => {
      const ax = normal.getX(a);
      const ay = normal.getY(a);
      const az = normal.getZ(a);
      const bx = normal.getX(b);
      const by = normal.getY(b);
      const bz = normal.getZ(b);
      const la = Math.hypot(ax, ay, az);
      const lb = Math.hypot(bx, by, bz);
      if (la === 0 || lb === 0 || (ax * bx + ay * by + az * bz) / (la * lb) < SAG_MIN_NORMAL_COS) {
        return;
      }
      const turn = (bx / lb - ax / la) * (position.getX(b) - position.getX(a))
        + (by / lb - ay / la) * (position.getY(b) - position.getY(a))
        + (bz / lb - az / la) * (position.getZ(b) - position.getZ(a));
      sag = Math.max(sag, Math.abs(turn) / 8);
    };
    for (let i = 0; i + 2 < count; i += 3) {
      const a = vertex(i);
      const b = vertex(i + 1);
      const c = vertex(i + 2);
      side(a, b);
      side(b, c);
      side(c, a);
    }
  }
  faceSags.set(geometry, sag);
  return sag;
}

const DEPTH_VERTEX = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
void main() {
  #include <begin_vertex>
  #include <project_vertex>
  #include <clipping_planes_vertex>
}`;

const DEPTH_FRAGMENT = /* glsl */ `
uniform float sag;
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  float z = gl_FragCoord.z;
  // The face's depth plane across this pixel: its slopes, from the derivatives.
  gl_FragColor = vec4(z, dFdx(z), dFdy(z), sag);
}`;

function createDepthMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: DEPTH_VERTEX,
    fragmentShader: DEPTH_FRAGMENT,
    uniforms: { sag: { value: 0 } },
    clipping: true,
    blending: NoBlending,
  });
}
