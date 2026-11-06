import {
  DoubleSide,
  MeshStandardMaterial,
  ShaderChunk,
  Vector3,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import type { Appearance } from '../../../../lib/common/appearances';
import { faceDepthOffset } from '../shape-meshes/face-depth-offset';

/**
 * The material a part's `.appearance(id)` shades its unpainted faces with:
 * a physically-based `MeshStandardMaterial` (roughness, metalness, the
 * scene's environment for reflections) built from a preset of the shared
 * appearance table. A `color()`-painted face never gets one — paint is the
 * override — and neither does the default look, which stays Phong.
 *
 * A wood preset adds procedural grain in the shader, nothing downloaded:
 * lines along the body's longest axis on the faces that run with it,
 * rings on the end faces, blended by the face normal (the tessellation has
 * no UVs, and projection is what keeps the grain continuous across every
 * face and seamless at every edge). The grain is computed from the
 * part-space position in millimetres, so a line is the same width in an inch
 * document and follows an assembly instance through its pose.
 */

/** The axis the grain runs along — the solid's longest extent. */
export type GrainAxis = 'x' | 'y' | 'z';

export type AppearanceMaterialOptions = {
  /** How many scene units one millimetre is — the grain is sized in millimetres. */
  unitsPerMm: number;
  /** The grain direction of the body this material shades (wood presets). */
  grainAxis?: GrainAxis;
  opacity?: number;
  depthTest?: boolean;
  /** Push the faces back by their depth slope too — see face-depth-offset.ts. */
  slopeOffset?: boolean;
};

/**
 * A fresh material for `appearance`. Materials are per mesh (the viewer
 * mutates `color`, `opacity` and `transparent` in place for highlights,
 * ghosting and the Shapes panel's transparency).
 */
export function createAppearanceMaterial(appearance: Appearance, options: AppearanceMaterialOptions): MeshStandardMaterial {
  const opacity = options.opacity ?? 1;
  const material = new MeshStandardMaterial({
    color: appearance.color,
    roughness: appearance.roughness,
    metalness: appearance.metalness,
    transparent: opacity < 1,
    opacity,
    depthTest: options.depthTest ?? true,
    // Same slot as the Phong faces: behind the edge lines, in front of nothing.
    polygonOffset: true,
    ...faceDepthOffset(false, options.slopeOffset),
    side: DoubleSide,
  });
  material.userData.appearance = appearance.id;
  if (appearance.metalness < 0.5) {
    material.envMapIntensity = DIELECTRIC_ENV_INTENSITY;
  }
  installShader(material, appearance, options);
  return material;
}

/**
 * The scene's ambient light is tuned for the Phong faces (2.5× — see
 * SceneContext), far above what a physically-based surface expects on top
 * of the environment that already lights it: at full strength a pale wood
 * tone-maps to near white. Appearance materials take this much of it.
 */
const AMBIENT_SCALE = 0.15;

/**
 * The studio environment at full strength lifts a pale dielectric the same
 * way; a metal, which is nothing but its reflections, keeps it whole.
 */
const DIELECTRIC_ENV_INTENSITY = 0.7;

/**
 * The mean distance between two grain lines, in millimetres: wide enough
 * that the grain still reads on a cabinet or a wardrobe seen whole, where a
 * finer one falls below the pixels and fades to the plain colour.
 */
const RING_SPACING_MM = 18;

const GRAIN_AXIS_VECTORS: Record<GrainAxis, Vector3> = {
  x: new Vector3(1, 0, 0),
  y: new Vector3(0, 1, 0),
  z: new Vector3(0, 0, 1),
};

/**
 * Patch the standard shader: the ambient term scaled for every preset, and
 * for a wood the grain darkening the diffuse colour.
 */
function installShader(material: MeshStandardMaterial, appearance: Appearance, options: AppearanceMaterialOptions): void {
  const wood = appearance.wood;
  // Part-space units → rings: the grain functions work in units of one
  // ring spacing.
  const grainScale = 1 / (RING_SPACING_MM * options.unitsPerMm);

  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_begin>',
      ShaderChunk.lights_fragment_begin.replace(
        'getAmbientLightIrradiance( ambientLightColor )',
        `getAmbientLightIrradiance( ambientLightColor ) * ${AMBIENT_SCALE.toFixed(2)}`,
      ),
    );
    if (!wood) {
      return;
    }
    shader.uniforms.uGrainScale = { value: grainScale };
    shader.uniforms.uGrainAxis = { value: GRAIN_AXIS_VECTORS[options.grainAxis ?? 'x'] };
    shader.uniforms.uStripeVisibility = { value: wood.stripeVisibility };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${GRAIN_VERTEX_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${GRAIN_VERTEX_BODY}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GRAIN_FRAGMENT_DECL}`)
      .replace('#include <map_fragment>', GRAIN_MAP_FRAGMENT);
  };
  // Materials patched the same way compile one program; without a key three
  // would compile one per material.
  material.customProgramCacheKey = () => `fluidcad-appearance:${wood ? 'wood' : ''}`;
}

const GRAIN_VERTEX_DECL = /* glsl */ `
varying vec3 vGrainPos;
varying vec3 vGrainNormal;
`;

// Object (part) space: the mesh sits at the identity under its part, and
// the instance pose is on the group above, so the grain rides along.
const GRAIN_VERTEX_BODY = /* glsl */ `
vGrainPos = transformed;
vGrainNormal = objectNormal;
`;

// The grain functions. Each projection is a ring field t with its gradient:
// a grain line wherever t crosses a whole number. Along the grain t counts
// rings across the face, swayed by value noise; on the end grain it is the
// wobbled distance from the pith. A line is drawn by its distance from the
// pixel (the gap in t over the gradient), never by thresholding t itself:
// where the sway flattens the field a thresholded band swells into a dark
// blotch, a measured line keeps its width. Coordinates are in rings
// (RING_SPACING_MM).
const GRAIN_FRAGMENT_DECL = /* glsl */ `
uniform float uGrainScale;
uniform vec3 uGrainAxis;
uniform float uStripeVisibility;
varying vec3 vGrainPos;
varying vec3 vGrainNormal;

float grainHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 34.45);
  return fract(p.x * p.y);
}

// Value noise and its gradient: (n, dn/dx, dn/dy).
vec3 grainNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 local = fract(p);
  float a = grainHash(cell);
  float b = grainHash(cell + vec2(1.0, 0.0));
  float c = grainHash(cell + vec2(0.0, 1.0));
  float d = grainHash(cell + vec2(1.0, 1.0));
  vec2 blend = local * local * (3.0 - 2.0 * local);
  vec2 slope = 6.0 * local * (1.0 - local);
  float k = a - b - c + d;
  return vec3(
    a + (b - a) * blend.x + (c - a) * blend.y + k * blend.x * blend.y,
    slope.x * (b - a + k * blend.y),
    slope.y * (c - a + k * blend.x)
  );
}

// amp * noise(p * freq + shift) with its gradient in p.
vec3 grainOctave(vec2 p, vec2 freq, float shift, float amp) {
  vec3 n = grainNoise(p * freq + shift);
  return amp * vec3(n.x, n.yz * freq);
}

// A face along the grain: coord.x runs with the grain, coord.y across it.
// The sway wanders slowly along the grain and drifts across it, so
// neighbouring lines run together and part again.
vec3 faceRings(vec2 coord) {
  return vec3(coord.y, 0.0, 1.0)
    + grainOctave(coord, vec2(0.06, 0.25), 0.0, 2.67)
    + grainOctave(coord, vec2(0.2, 0.5), 7.3, 0.2);
}

// An end face: rings around the projection's origin, the centre wobbled.
vec3 endRings(vec2 coord) {
  vec3 wobbleX = grainOctave(coord, vec2(0.12), 0.0, 1.2);
  vec3 wobbleY = grainOctave(coord, vec2(0.12), 4.2, 1.2);
  vec3 ripple = grainOctave(coord, vec2(0.35), 9.1, 0.3);
  vec2 q = coord + vec2(wobbleX.x, wobbleY.x) - 0.6;
  float radius = max(length(q), 1e-4);
  vec2 u = q / radius;
  return vec3(radius, u + u.x * wobbleX.yz + u.y * wobbleY.yz) + ripple;
}

// How dark the grain is at a pixel, 0 … 1: a thin line on each ring of the
// field, of a width and strength of its own and tapering along its run
// (along), with a soft latewood shade in the band leading up to it. The
// line is box-filtered by the pixel's footprint (in rings), and once the
// rings come closer than the pixels can show the grain settles to its mean
// tone rather than shimmering.
float ringLines(vec3 field, float along, float footprint) {
  float slope = max(length(field.yz), 1e-4);
  float index = floor(field.x);
  float f = field.x - index;
  float nearest = f < 0.5 ? index : index + 1.0;
  float dist = min(f, 1.0 - f) / slope;
  float before = (1.0 - f) / slope;
  float strength = 0.45 + 0.55 * grainHash(vec2(nearest, 17.0));
  float taper = 0.6 + 0.8 * grainNoise(vec2(along * 0.12, nearest * 1.7 + 5.0)).x;
  float halfWidth = (0.035 + 0.03 * grainHash(vec2(nearest, 41.0))) * taper;
  float soft = max(footprint, 0.03);
  float line = max(0.0, min(halfWidth, dist + soft * 0.5) - max(-halfWidth, dist - soft * 0.5)) / soft;
  float latewood = (1.0 - smoothstep(0.0, 0.6 + footprint, before))
    * (0.45 + 0.55 * grainHash(vec2(index + 1.0, 17.0))) * 0.14;
  return mix(max(line * strength, latewood), 0.1, smoothstep(0.25, 0.6, footprint));
}

// The grain seen from each axis, blended by the face normal: the projection
// facing along the grain axis shows end grain, the other two the lines.
float woodGrain(vec3 p, vec3 n, float footprint) {
  // Turn the part's axes so that the grain runs along x.
  if (uGrainAxis.y > 0.5) {
    p = p.yzx;
    n = n.yzx;
  } else if (uGrainAxis.z > 0.5) {
    p = p.zxy;
    n = n.zxy;
  }
  vec3 w = pow(abs(n), vec3(6.0));
  w /= w.x + w.y + w.z + 0.0001;
  float grain = 0.0;
  if (w.x > 0.001) {
    grain += w.x * ringLines(endRings(p.yz), p.y + p.z, footprint);
  }
  if (w.y > 0.001) {
    grain += w.y * ringLines(faceRings(p.xz), p.x, footprint);
  }
  if (w.z > 0.001) {
    grain += w.z * ringLines(faceRings(p.xy), p.x, footprint);
  }
  return grain;
}
`;

// The footprint is taken here, in uniform control flow, where the screen
// derivatives are defined.
const GRAIN_MAP_FRAGMENT = /* glsl */ `
vec3 grainPos = vGrainPos * uGrainScale;
float grainFootprint = max(length(dFdx(grainPos)), length(dFdy(grainPos)));
float grain = woodGrain(grainPos, normalize(vGrainNormal), grainFootprint);
diffuseColor.rgb *= 1.0 - grain * uStripeVisibility * 0.28;
`;
