import {
  type Camera, Color, FloatType, type Material, Matrix4, Mesh, NearestFilter, NoBlending, type Object3D, RGBAFormat,
  Scene, ShaderMaterial, type Texture, UnsignedByteType, Vector2, Vector4, type WebGLRenderer, WebGLRenderTarget,
} from 'three';

/**
 * Whether points stand in front of the solids' faces, decided on the GPU.
 *
 * The faces that hide a point are drawn once into an offscreen map holding,
 * per pixel, the window depth of the nearest face and that depth's slope
 * along x and y. A point asks the four pixels around its projection for the
 * depth their face's plane has at the point's exact position, and is visible
 * when it is no deeper than the deepest of the four:
 *
 * - a face through the vertex (one that meets at it) reconstructs the
 *   vertex's own depth, so it never hides it, at any angle — no bias that a
 *   face seen edge-on could turn into a hole in a wall in front;
 * - a face in front of the point stays in front;
 * - a point within a pixel of an occluder's silhouette is visible from the
 *   side that shows something behind it — the one place the map's pixels
 *   and the exact sight line can differ.
 *
 * The dot shader samples the map; {@link visible} reads the same pixels back
 * and applies the same rule, so a dot is pickable exactly when it is drawn.
 */
export interface PointOcclusion {
  /** Brings the map up to date with the camera and `occluders`; null when nothing occludes. */
  update(occluders: readonly Object3D[]): OcclusionMap | null;
  /** For each world point, whether it is in front of `occluders` — the dot shader's decision. */
  visible(points: readonly { x: number; y: number; z: number }[], occluders: readonly Object3D[]): boolean[];
  /** Frees the map until the next update; nothing is drawn or kept while no dot needs it. */
  release(): void;
  dispose(): void;
}

/**
 * The map and how its texels read. `float`: depth and its two slopes as
 * 32-bit floats. `packed`, where float targets can't be drawn: the depth
 * alone in 24 bits, pushed back by its slope instead (see {@link SLOPE_PIXELS}).
 */
export type OcclusionMap = { texture: Texture; width: number; height: number; encoding: OcclusionEncoding };
export type OcclusionEncoding = 'float' | 'packed';

/** The packed map's depth resolution: 24 bits, the canvas depth buffer's own. */
export const DEPTH_STEPS = 16777215;
/** Packed maps only: how far behind a face's depth its value sits, in its depth slope per pixel. */
export const SLOPE_PIXELS = 2;
/** The comparison's slack, in window depth: rounding, and a curved face between its pixel and the point. */
export const DEPTH_EPSILON = 4 / DEPTH_STEPS;

export function packDepth(depth: number): [number, number, number] {
  let n = Math.floor(Math.min(Math.max(depth, 0), 1) * DEPTH_STEPS + 0.5);
  const r = Math.floor(n / 65536);
  n -= r * 65536;
  const g = Math.floor(n / 256);
  return [r, g, n - g * 256];
}

export function unpackDepth(r: number, g: number, b: number): number {
  return (r * 65536 + g * 256 + b) / DEPTH_STEPS;
}

/**
 * GLSL shared with the dot shader: the depth the face in `texel` has at
 * `point` (map pixel coordinates, bottom-left origin). Needs a sampler
 * named `occlusion`; `OCCLUSION_PACKED` selects the packed encoding.
 */
export const OCCLUDER_DEPTH_GLSL = /* glsl */ `
float occluderDepthAt(ivec2 texel, vec2 point) {
  vec4 t = texelFetch(occlusion, texel, 0);
#ifdef OCCLUSION_PACKED
  vec3 bytes = floor(t.rgb * 255.0 + 0.5);
  return dot(bytes, vec3(65536.0, 256.0, 1.0)) / ${DEPTH_STEPS.toFixed(1)};
#else
  vec2 offset = point - (vec2(texel) + 0.5);
  return t.r + t.g * offset.x + t.b * offset.y;
#endif
}
float occluderDepthAround(vec2 point, vec2 size) {
  ivec2 p0 = ivec2(floor(point - 0.5));
  ivec2 last = ivec2(size) - 1;
  float deepest = 0.0;
  for (int dy = 0; dy <= 1; dy++) {
    for (int dx = 0; dx <= 1; dx++) {
      deepest = max(deepest, occluderDepthAt(clamp(p0 + ivec2(dx, dy), ivec2(0), last), point));
    }
  }
  return deepest;
}`;

/** A point's position on the map (pixels, bottom-left origin) and its window depth; null outside the view. */
export function mapSample(
  point: { x: number; y: number; z: number }, viewProjection: Matrix4, width: number, height: number,
): { x: number; y: number; depth: number } | null {
  const v = new Vector4(point.x, point.y, point.z, 1).applyMatrix4(viewProjection);
  if (!(v.w > 0)) {
    return null;
  }
  const nx = v.x / v.w;
  const ny = v.y / v.w;
  const nz = v.z / v.w;
  if (!Number.isFinite(nx + ny + nz) || Math.abs(nx) > 1 || Math.abs(ny) > 1 || Math.abs(nz) > 1) {
    return null;
  }
  return { x: (nx * 0.5 + 0.5) * width, y: (ny * 0.5 + 0.5) * height, depth: nz * 0.5 + 0.5 };
}

/**
 * The CPU twin of `occluderDepthAround`: the deepest of the depths the
 * faces in the four texels around `sample` have at its exact position, from
 * texels read into `pixels` (a block whose bottom-left texel is `left`,
 * `bottom`, `w` texels wide).
 */
export function occluderDepthAround(
  sample: { x: number; y: number }, encoding: OcclusionEncoding, pixels: ArrayLike<number>,
  block: { left: number; bottom: number; w: number }, size: { width: number; height: number },
): number {
  const x0 = Math.floor(sample.x - 0.5);
  const y0 = Math.floor(sample.y - 0.5);
  let deepest = 0;
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = 0; dx <= 1; dx++) {
      const tx = Math.min(Math.max(x0 + dx, 0), size.width - 1);
      const ty = Math.min(Math.max(y0 + dy, 0), size.height - 1);
      const i = ((ty - block.bottom) * block.w + tx - block.left) * 4;
      const depth = encoding === 'packed'
        ? unpackDepth(pixels[i], pixels[i + 1], pixels[i + 2])
        : pixels[i] + pixels[i + 1] * (sample.x - (tx + 0.5)) + pixels[i + 2] * (sample.y - (ty + 0.5));
      deepest = Math.max(deepest, depth);
    }
  }
  return deepest;
}

const VERTEX = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
void main() {
  #include <begin_vertex>
  #include <project_vertex>
  #include <clipping_planes_vertex>
}`;

const FRAGMENT = /* glsl */ `
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  float z = gl_FragCoord.z;
  // The face's depth plane across this pixel: its slopes, from the derivatives.
  float sx = dFdx(z);
  float sy = dFdy(z);
#ifdef OCCLUSION_PACKED
  float depth = clamp(z + max(abs(sx), abs(sy)) * ${SLOPE_PIXELS.toFixed(1)}, 0.0, 1.0);
  float n = floor(depth * ${DEPTH_STEPS.toFixed(1)} + 0.5);
  float r = floor(n / 65536.0);
  n -= r * 65536.0;
  float g = floor(n / 256.0);
  gl_FragColor = vec4(r, g, n - g * 256.0, 255.0) / 255.0;
#else
  gl_FragColor = vec4(z, sx, sy, 1.0);
#endif
}`;

/**
 * The GPU {@link PointOcclusion}: the occluders redrawn into a map at the
 * canvas's CSS resolution, only when the camera or an occluder changed.
 */
export class OccluderDepthMap implements PointOcclusion {
  private target: WebGLRenderTarget | null = null;
  private encoding: OcclusionEncoding | null = null;
  private readonly scene = new Scene();
  /** A stand-in per occluder sharing its geometry, drawn with a depth material. */
  private readonly proxies = new Map<Object3D, Mesh>();
  private readonly materials = new Map<Material, ShaderMaterial>();
  private signature: number[] = [];
  private readonly size = new Vector2();
  private readonly clearColor = new Color();

  constructor(
    private readonly ctx: { readonly renderer: WebGLRenderer; readonly camera: Camera },
  ) {
    this.scene.matrixWorldAutoUpdate = false;
  }

  update(occluders: readonly Object3D[]): OcclusionMap | null {
    if (occluders.length === 0) {
      return null;
    }
    const { renderer, camera } = this.ctx;
    this.encoding ??= renderer.extensions.has('EXT_color_buffer_float') ? 'float' : 'packed';
    renderer.getSize(this.size);
    const width = Math.max(1, Math.floor(this.size.x));
    const height = Math.max(1, Math.floor(this.size.y));
    camera.updateMatrixWorld();
    const signature = this.signatureOf(occluders, camera, width, height);
    if (!this.target || !OccluderDepthMap.sameNumbers(signature, this.signature)) {
      this.signature = signature;
      this.draw(occluders, width, height);
    }
    return { texture: this.target!.texture, width, height, encoding: this.encoding };
  }

  visible(points: readonly { x: number; y: number; z: number }[], occluders: readonly Object3D[]): boolean[] {
    const map = this.update(occluders);
    if (!map || !this.target) {
      return points.map(() => true);
    }
    const { camera, renderer } = this.ctx;
    const viewProjection = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const samples = points.map(point => mapSample(point, viewProjection, map.width, map.height));
    const placed = samples.filter(sample => sample !== null);
    if (placed.length === 0) {
      return points.map(() => false);
    }
    // One read of the block covering every point's four texels.
    const clampX = (x: number) => Math.min(Math.max(x, 0), map.width - 1);
    const clampY = (y: number) => Math.min(Math.max(y, 0), map.height - 1);
    const left = clampX(Math.min(...placed.map(s => Math.floor(s.x - 0.5))));
    const bottom = clampY(Math.min(...placed.map(s => Math.floor(s.y - 0.5))));
    const right = clampX(Math.max(...placed.map(s => Math.floor(s.x - 0.5) + 1)));
    const top = clampY(Math.max(...placed.map(s => Math.floor(s.y - 0.5) + 1)));
    const w = right - left + 1;
    const h = top - bottom + 1;
    const pixels = map.encoding === 'float' ? new Float32Array(w * h * 4) : new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(this.target, left, bottom, w, h, pixels);
    return samples.map(sample => sample !== null
      && sample.depth <= occluderDepthAround(sample, map.encoding, pixels, { left, bottom, w }, map) + DEPTH_EPSILON);
  }

  release(): void {
    this.target?.dispose();
    this.target = null;
    this.signature = [];
    for (const proxy of this.proxies.values()) {
      proxy.removeFromParent();
    }
    this.proxies.clear();
    for (const material of this.materials.values()) {
      material.dispose();
    }
    this.materials.clear();
  }

  dispose(): void {
    this.release();
  }

  private draw(occluders: readonly Object3D[], width: number, height: number): void {
    const { renderer, camera } = this.ctx;
    if (!this.target || this.target.width !== width || this.target.height !== height) {
      this.target?.dispose();
      this.target = new WebGLRenderTarget(width, height, {
        format: RGBAFormat, type: this.encoding === 'float' ? FloatType : UnsignedByteType,
        minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false,
        depthBuffer: true, stencilBuffer: false,
      });
    }
    this.syncProxies(occluders);
    const previousTarget = renderer.getRenderTarget();
    const previousAlpha = renderer.getClearAlpha();
    const previousAutoClear = renderer.autoClear;
    renderer.getClearColor(this.clearColor);
    renderer.setRenderTarget(this.target);
    // The far plane, flat: a pixel no face covers hides nothing.
    renderer.setClearColor(this.encoding === 'float' ? 0xff0000 : 0xffffff, 1);
    renderer.autoClear = false;
    renderer.clear(true, true, false);
    renderer.render(this.scene, camera);
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(this.clearColor, previousAlpha);
    renderer.autoClear = previousAutoClear;
  }

  /** One stand-in per occluder: its geometry and placement, a depth material with its side and clipping. */
  private syncProxies(occluders: readonly Object3D[]): void {
    const keep = new Set(occluders);
    for (const [source, proxy] of this.proxies) {
      if (!keep.has(source)) {
        proxy.removeFromParent();
        this.proxies.delete(source);
      }
    }
    for (const source of occluders) {
      const mesh = source as Mesh;
      let proxy = this.proxies.get(source);
      if (!proxy) {
        proxy = new Mesh();
        proxy.matrixAutoUpdate = false;
        proxy.matrixWorldAutoUpdate = false;
        this.scene.add(proxy);
        this.proxies.set(source, proxy);
      }
      proxy.geometry = mesh.geometry;
      proxy.matrixWorld.copy(source.matrixWorld);
      proxy.frustumCulled = source.frustumCulled;
      proxy.material = Array.isArray(mesh.material)
        ? mesh.material.map(material => this.depthMaterial(material))
        : this.depthMaterial(mesh.material);
    }
    // A re-render replaces the faces' materials: drop the depth twins of the old ones.
    const used = new Set(occluders.flatMap(source => {
      const material = (source as Mesh).material;
      return Array.isArray(material) ? material : [material];
    }));
    for (const [source, material] of this.materials) {
      if (!used.has(source)) {
        material.dispose();
        this.materials.delete(source);
      }
    }
  }

  private depthMaterial(source: Material): ShaderMaterial {
    let material = this.materials.get(source);
    if (!material) {
      material = new ShaderMaterial({
        vertexShader: VERTEX, fragmentShader: FRAGMENT, clipping: true, blending: NoBlending,
        defines: this.encoding === 'packed' ? { OCCLUSION_PACKED: '' } : {},
      });
      this.materials.set(source, material);
    }
    material.side = source.side;
    material.clippingPlanes = source.clippingPlanes;
    material.clipIntersection = source.clipIntersection;
    return material;
  }

  /** Everything the map depends on: the camera, the map's size and each occluder's geometry, placement, side and clipping. */
  private signatureOf(occluders: readonly Object3D[], camera: Camera, width: number, height: number): number[] {
    const out = [width, height, ...camera.matrixWorld.elements, ...camera.projectionMatrix.elements];
    for (const object of occluders) {
      const mesh = object as Mesh;
      const position = mesh.geometry?.attributes.position;
      out.push(object.id, mesh.geometry?.id ?? -1, position && 'version' in position ? position.version : -1,
        mesh.geometry?.index?.version ?? -1, ...object.matrixWorld.elements);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        out.push(material?.side ?? -1, material?.clipIntersection ? 1 : 0);
        for (const plane of material?.clippingPlanes ?? []) {
          out.push(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
        }
      }
    }
    return out;
  }

  private static sameNumbers(a: number[], b: number[]): boolean {
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
}
