import {
  BufferAttribute, type Color, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry, Mesh,
  ShaderMaterial, Vector2,
} from 'three';
import { DEPTH_EPSILON, OCCLUDER_DEPTH_GLSL, type OcclusionMap } from './occluder-depth';

/** One dot of the batch: where it stands, its colour, opacity and radius in CSS pixels. */
export type VertexDot = {
  position: { x: number; y: number; z: number };
  color: Color;
  opacity: number;
  radiusPx: number;
};

const VERTEX = /* glsl */ `
attribute vec3 center;
attribute vec3 dotColor;
attribute float dotAlpha;
attribute float dotRadius;
uniform sampler2D occlusion;
uniform float useOcclusion;
uniform vec2 mapSize;
uniform vec2 bufferSize;
uniform float pixelRatio;
varying vec2 vOffset;
varying vec3 vColor;
varying float vAlpha;
varying float vRadius;
${OCCLUDER_DEPTH_GLSL}
void main() {
  vec4 clip = projectionMatrix * viewMatrix * vec4(center, 1.0);
  vec3 ndc = clip.xyz / clip.w;
  bool hidden = dotAlpha <= 0.0 || clip.w <= 0.0 || any(greaterThan(abs(ndc), vec3(1.0)));
  if (!hidden && useOcclusion > 0.5) {
    // Behind the deepest face plane of the four map pixels around the centre (see OccluderDepthMap).
    vec2 point = (ndc.xy * 0.5 + 0.5) * mapSize;
    hidden = ndc.z * 0.5 + 0.5 > occluderDepthAround(point, mapSize) + ${DEPTH_EPSILON.toExponential(6)};
  }
  if (hidden) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // A screen-aligned square one device pixel wider than the dot, for its antialiased rim.
  float extent = dotRadius * pixelRatio + 1.0;
  vOffset = position.xy * extent;
  vColor = dotColor;
  vAlpha = dotAlpha;
  vRadius = dotRadius * pixelRatio;
  gl_Position = vec4(clip.xy + position.xy * extent * 2.0 / bufferSize * clip.w, clip.z, clip.w);
}`;

const FRAGMENT = /* glsl */ `
varying vec2 vOffset;
varying vec3 vColor;
varying float vAlpha;
varying float vRadius;
void main() {
  float coverage = clamp(vRadius + 0.5 - length(vOffset), 0.0, 1.0);
  if (coverage <= 0.0) {
    discard;
  }
  gl_FragColor = vec4(vColor, vAlpha * coverage);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * Every vertex dot in one instanced draw. Each dot is a screen-aligned
 * square sized in CSS pixels; the vertex shader hides a dot whose centre an
 * occluder covers (the {@link OcclusionMap}), so visibility costs the GPU a
 * few texel reads per dot and the CPU nothing per frame. Dots draw over
 * edges and faces (no depth test), as the single markers did.
 */
export class VertexDots extends Mesh<InstancedBufferGeometry, ShaderMaterial> {
  private dots: VertexDot[] = [];
  private capacity = 0;

  constructor() {
    super(VertexDots.geometryFor(0), new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        occlusion: { value: null },
        useOcclusion: { value: 0 },
        mapSize: { value: new Vector2(1, 1) },
        bufferSize: { value: new Vector2(1, 1) },
        pixelRatio: { value: 1 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }));
    this.name = 'vertex-pick-dot-batch';
    this.frustumCulled = false;
    this.renderOrder = 4;
  }

  /** Draw these dots, in order: a later dot paints over an earlier one. */
  setDots(dots: readonly VertexDot[]): void {
    this.dots = [...dots];
    if (dots.length > this.capacity) {
      this.capacity = Math.max(dots.length, this.capacity * 2, 64);
      this.geometry.dispose();
      this.geometry = VertexDots.geometryFor(this.capacity);
    }
    const attributes = this.geometry.attributes;
    const center = attributes.center as InstancedBufferAttribute;
    const color = attributes.dotColor as InstancedBufferAttribute;
    const alpha = attributes.dotAlpha as InstancedBufferAttribute;
    const radius = attributes.dotRadius as InstancedBufferAttribute;
    dots.forEach((dot, i) => {
      center.setXYZ(i, dot.position.x, dot.position.y, dot.position.z);
      color.setXYZ(i, dot.color.r, dot.color.g, dot.color.b);
      alpha.setX(i, dot.opacity);
      radius.setX(i, dot.radiusPx);
    });
    for (const attribute of [center, color, alpha, radius]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, dots.length * attribute.itemSize);
      attribute.needsUpdate = true;
    }
    this.geometry.instanceCount = dots.length;
    this.visible = dots.length > 0;
  }

  /** The dots the batch draws, in draw order — what a test or a probe reads back. */
  get drawn(): readonly VertexDot[] {
    return this.dots;
  }

  /** The occlusion map the shader tests each centre against; null draws every dot. */
  setOcclusion(map: OcclusionMap | null): void {
    const uniforms = this.material.uniforms;
    uniforms.occlusion.value = map ? map.texture : null;
    uniforms.useOcclusion.value = map ? 1 : 0;
    if (map) {
      (uniforms.mapSize.value as Vector2).set(map.width, map.height);
      const packed = map.encoding === 'packed';
      if (packed !== ('OCCLUSION_PACKED' in this.material.defines)) {
        this.material.defines = packed ? { OCCLUSION_PACKED: '' } : {};
        this.material.needsUpdate = true;
      }
    }
  }

  /** The canvas's drawing-buffer size and pixel ratio, which turn CSS-pixel radii into clip space. */
  setViewport(drawingBuffer: Vector2, pixelRatio: number): void {
    (this.material.uniforms.bufferSize.value as Vector2).copy(drawingBuffer);
    this.material.uniforms.pixelRatio.value = pixelRatio;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.removeFromParent();
  }

  private static geometryFor(capacity: number): InstancedBufferGeometry {
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const instanced = (itemSize: number) => {
      const attribute = new InstancedBufferAttribute(new Float32Array(Math.max(capacity, 1) * itemSize), itemSize);
      attribute.setUsage(DynamicDrawUsage); // rewritten as hover and selection change
      return attribute;
    };
    geometry.setAttribute('center', instanced(3));
    geometry.setAttribute('dotColor', instanced(3));
    geometry.setAttribute('dotAlpha', instanced(1));
    geometry.setAttribute('dotRadius', instanced(1));
    geometry.instanceCount = 0;
    return geometry;
  }
}
