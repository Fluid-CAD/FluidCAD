// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  BackSide, Color, DoubleSide, FloatType, Matrix4, Mesh, MeshBasicMaterial, OrthographicCamera, PerspectiveCamera, Plane,
  PlaneGeometry, ShaderMaterial, UnsignedByteType, Vector2, Vector3, type WebGLRenderer, type WebGLRenderTarget,
} from 'three';
import {
  DEPTH_EPSILON, DEPTH_STEPS, mapSample, OccluderDepthMap, occluderDepthAround, packDepth, unpackDepth,
} from '../src/interactive/occluder-depth';
import { VertexDots } from '../src/interactive/vertex-dots';

function camera() {
  const cam = new PerspectiveCamera(50, 1, 0.1, 100);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

/** A renderer that records the map's draws and serves reads from a texel function. */
function fakeRenderer(texel: (x: number, y: number) => number[], float = true) {
  const renders: unknown[] = [];
  const reads: number[][] = [];
  const renderer = {
    extensions: { has: (name: string) => float && name === 'EXT_color_buffer_float' },
    getSize: (size: Vector2) => size.set(100, 80),
    getRenderTarget: () => null,
    setRenderTarget: vi.fn(),
    getClearAlpha: () => 0,
    getClearColor: (color: Color) => color.set(0),
    setClearColor: vi.fn(),
    autoClear: true,
    clear: vi.fn(),
    render: vi.fn((scene: unknown) => renders.push(scene)),
    readRenderTargetPixels: (_target: WebGLRenderTarget, x: number, y: number, w: number, h: number, out: Float32Array | Uint8Array) => {
      reads.push([x, y, w, h]);
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          out.set(texel(x + i, y + j), (j * w + i) * 4);
        }
      }
    },
  };
  return { renderer: renderer as unknown as WebGLRenderer, renders, reads };
}

describe('occluder depth map', () => {
  it('packs depth into three bytes and back within one step', () => {
    for (const depth of [0, 1e-7, 0.25, 0.5, 0.999123, 1]) {
      const [r, g, b] = packDepth(depth);
      expect([r, g, b].every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)).toBe(true);
      expect(Math.abs(unpackDepth(r, g, b) - depth)).toBeLessThanOrEqual(1 / DEPTH_STEPS);
    }
    expect(packDepth(1)).toEqual([255, 255, 255]);
  });

  it('places a point on the map the way the shader does: pixels from the bottom-left, window depth', () => {
    const cam = camera();
    const viewProjection = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const point = new Vector3(0.5, -0.25, 1);
    const ndc = point.clone().project(cam);
    const sample = mapSample(point, viewProjection, 100, 80)!;
    expect(sample.x).toBeCloseTo((ndc.x * 0.5 + 0.5) * 100, 9);
    expect(sample.y).toBeCloseTo((ndc.y * 0.5 + 0.5) * 80, 9);
    expect(sample.depth).toBeCloseTo(ndc.z * 0.5 + 0.5, 12);
    expect(mapSample(new Vector3(0, 0, 20), viewProjection, 100, 80)).toBeNull();
    expect(mapSample(new Vector3(100, 0, 0), viewProjection, 100, 80)).toBeNull();
  });

  it('reconstructs each texel’s face plane at the point and keeps the deepest of the four', () => {
    // A plane of depth 0.5 + 0.01·x across the map: every texel reconstructs it exactly at the point.
    const plane = (x: number, y: number) => [0.5 + 0.01 * (x + 0.5), 0.01, 0, 1];
    const pixels = new Float32Array(16);
    [[3, 4], [4, 4], [3, 5], [4, 5]].forEach(([x, y], k) => pixels.set(plane(x, y), ((y - 4) * 2 + x - 3) * 4));
    const at = { x: 4.2, y: 5.3 };
    expect(occluderDepthAround(at, 'float', pixels, { left: 3, bottom: 4, w: 2 }, { width: 10, height: 10 }))
      .toBeCloseTo(0.5 + 0.01 * 4.2, 6);
    // One texel showing something deeper (the background) wins: the point counts as uncovered there.
    pixels.set([1, 0, 0, 1], 0);
    expect(occluderDepthAround(at, 'float', pixels, { left: 3, bottom: 4, w: 2 }, { width: 10, height: 10 })).toBe(1);
    // Packed texels read as plain depths.
    const bytes = new Uint8Array(16);
    for (let k = 0; k < 4; k++) {
      bytes.set([...packDepth(0.25 + k * 0.1), 255], k * 4);
    }
    expect(occluderDepthAround(at, 'packed', bytes, { left: 3, bottom: 4, w: 2 }, { width: 10, height: 10 }))
      .toBeCloseTo(0.55, 6);
  });

  it('decides a point visible when no face plane in its four texels stands in front of it', () => {
    const cam = camera();
    const viewProjection = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const front = mapSample(new Vector3(0, 0, 2), viewProjection, 100, 80)!.depth;
    let wallDepth = front;
    const { renderer, reads } = fakeRenderer(() => [wallDepth, 0, 0, 1]);
    const map = new OccluderDepthMap({ renderer, camera: cam });
    const occluder = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial());
    const points = [new Vector3(0, 0, 0), new Vector3(0.1, 0, 3), new Vector3(0, 0, 50)];
    // A face at z = 2 hides the origin, not a point in front of it; a point behind the eye is never visible.
    expect(map.visible(points, [occluder])).toEqual([false, true, false]);
    expect(reads).toHaveLength(1);
    // A point on the face itself is visible: the comparison has its slack.
    wallDepth = mapSample(points[0], viewProjection, 100, 80)!.depth - DEPTH_EPSILON / 2;
    expect(map.visible([points[0]], [occluder])).toEqual([true]);
    // Nothing to occlude: every point is visible and nothing is drawn or read.
    expect(map.visible(points, [])).toEqual([true, true, true]);
    expect(reads).toHaveLength(2);
  });

  it('redraws only when the camera, an occluder, its clipping or the canvas changes', () => {
    const cam = camera();
    const { renderer, renders } = fakeRenderer(() => [1, 0, 0, 1]);
    const map = new OccluderDepthMap({ renderer, camera: cam });
    const material = new MeshBasicMaterial({ side: DoubleSide });
    const face = new Mesh(new PlaneGeometry(1, 1), material);
    face.updateMatrixWorld(true);

    const first = map.update([face])!;
    expect(first).toMatchObject({ width: 100, height: 80, encoding: 'float' });
    expect(first.texture.type).toBe(FloatType);
    map.update([face]);
    expect(renders).toHaveLength(1);

    cam.position.x = 1;
    cam.updateMatrixWorld(true);
    map.update([face]);
    expect(renders).toHaveLength(2);

    face.position.z = 1;
    face.updateMatrixWorld(true);
    map.update([face]);
    expect(renders).toHaveLength(3);

    material.clippingPlanes = [new Plane(new Vector3(1, 0, 0), 0)];
    map.update([face]);
    expect(renders).toHaveLength(4);

    face.geometry.attributes.position.needsUpdate = true;
    map.update([face]);
    expect(renders).toHaveLength(5);

    map.update([face]);
    expect(renders).toHaveLength(5);
    expect(map.update([])).toBeNull();
  });

  it('draws each occluder with a depth twin that keeps its side and clipping, and drops twins it no longer needs', () => {
    const cam = camera();
    const { renderer } = fakeRenderer(() => [1, 0, 0, 1]);
    const map = new OccluderDepthMap({ renderer, camera: cam });
    const planes = [new Plane(new Vector3(0, 1, 0), 2)];
    const face = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ side: BackSide, clippingPlanes: planes, clipIntersection: true }));
    map.update([face]);
    const proxies = (map as unknown as { proxies: Map<object, Mesh> }).proxies;
    const twin = proxies.get(face)!.material as ShaderMaterial;
    expect(proxies.get(face)!.geometry).toBe(face.geometry);
    expect(twin).toBeInstanceOf(ShaderMaterial);
    expect(twin).toMatchObject({ side: BackSide, clippingPlanes: planes, clipIntersection: true, clipping: true });

    const dispose = vi.spyOn(twin, 'dispose');
    face.material = new MeshBasicMaterial();
    face.position.x = 1;
    face.updateMatrixWorld(true);
    map.update([face]);
    expect(dispose).toHaveBeenCalled();
    expect(proxies.get(face)!.material).not.toBe(twin);

    map.release();
    expect(proxies.size).toBe(0);
  });

  it('falls back to a packed 24-bit map where float targets can’t be drawn', () => {
    const cam = camera();
    const { renderer } = fakeRenderer(() => [...packDepth(1), 255], false);
    const map = new OccluderDepthMap({ renderer, camera: cam });
    const face = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial());
    const result = map.update([face])!;
    expect(result.encoding).toBe('packed');
    expect(result.texture.type).toBe(UnsignedByteType);
    const proxies = (map as unknown as { proxies: Map<object, Mesh> }).proxies;
    expect((proxies.get(face)!.material as ShaderMaterial).defines).toHaveProperty('OCCLUSION_PACKED');
    expect(map.visible([new Vector3(0, 0, 0)], [face])).toEqual([true]);
  });

  it('works for an orthographic camera too', () => {
    const cam = new OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
    cam.position.set(0, 0, 10);
    cam.updateMatrixWorld(true);
    const viewProjection = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const wall = mapSample(new Vector3(0, 0, 2), viewProjection, 100, 80)!.depth;
    const { renderer } = fakeRenderer(() => [wall, 0, 0, 1]);
    const map = new OccluderDepthMap({ renderer, camera: cam });
    const face = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial());
    expect(map.visible([new Vector3(1, 1, 0), new Vector3(1, 1, 4)], [face])).toEqual([false, true]);
  });
});

describe('vertex dot batch', () => {
  const dot = (x: number, opacity = 1, radiusPx = 2.5) => ({ position: { x, y: 0, z: 0 }, color: new Color(1, 0, 0), opacity, radiusPx });

  it('writes one instance per dot and hides itself when empty', () => {
    const dots = new VertexDots();
    dots.setDots([dot(1), dot(2, 0.6, 4.5)]);
    const g = dots.geometry;
    expect(g.instanceCount).toBe(2);
    expect(Array.from((g.attributes.center.array as Float32Array).slice(0, 6))).toEqual([1, 0, 0, 2, 0, 0]);
    expect((g.attributes.dotAlpha.array as Float32Array)[1]).toBeCloseTo(0.6);
    expect((g.attributes.dotRadius.array as Float32Array)[1]).toBe(4.5);
    expect(Array.from((g.attributes.dotColor.array as Float32Array).slice(0, 3))).toEqual([1, 0, 0]);
    expect(dots.visible).toBe(true);
    dots.setDots([]);
    expect(dots.visible).toBe(false);
    expect(dots.material).toMatchObject({ depthTest: false, depthWrite: false, transparent: true });
    expect(dots.renderOrder).toBe(4);
  });

  it('grows its buffers, freeing the old ones', () => {
    const dots = new VertexDots();
    dots.setDots([dot(0)]);
    const first = dots.geometry;
    const dispose = vi.spyOn(first, 'dispose');
    dots.setDots(Array.from({ length: 100 }, (_, i) => dot(i)));
    expect(dispose).toHaveBeenCalled();
    expect(dots.geometry).not.toBe(first);
    expect(dots.geometry.instanceCount).toBe(100);
    const grown = dots.geometry;
    dots.setDots(Array.from({ length: 50 }, (_, i) => dot(i)));
    expect(dots.geometry).toBe(grown);
  });

  it('takes the occlusion map and the viewport, switching its sampling to the map’s encoding', () => {
    const dots = new VertexDots();
    const texture = { type: FloatType } as never;
    dots.setOcclusion({ texture, width: 100, height: 80, encoding: 'float' });
    expect(dots.material.uniforms.useOcclusion.value).toBe(1);
    expect(dots.material.uniforms.occlusion.value).toBe(texture);
    expect(dots.material.uniforms.mapSize.value).toEqual(new Vector2(100, 80));
    expect(dots.material.defines).not.toHaveProperty('OCCLUSION_PACKED');
    const version = dots.material.version;
    dots.setOcclusion({ texture, width: 100, height: 80, encoding: 'packed' });
    expect(dots.material.defines).toHaveProperty('OCCLUSION_PACKED');
    expect(dots.material.version).toBeGreaterThan(version);
    dots.setOcclusion(null);
    expect(dots.material.uniforms.useOcclusion.value).toBe(0);
    dots.setViewport(new Vector2(800, 600), 2);
    expect(dots.material.uniforms.bufferSize.value).toEqual(new Vector2(800, 600));
    expect(dots.material.uniforms.pixelRatio.value).toBe(2);
  });

  it('frees its geometry and material on disposal', () => {
    const dots = new VertexDots();
    const geometry = vi.spyOn(dots.geometry, 'dispose');
    const material = vi.spyOn(dots.material, 'dispose');
    dots.dispose();
    expect(geometry).toHaveBeenCalled();
    expect(material).toHaveBeenCalled();
  });
});
