import {
  DoubleSide,
  MeshStandardMaterial,
  ShaderChunk,
  Vector3,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import type { Appearance } from '../../../../lib/common/appearances';

/**
 * The material a part's `.appearance(id)` shades its unpainted faces with:
 * a physically-based `MeshStandardMaterial` (roughness, metalness, the
 * scene's environment for reflections) built from a preset of the shared
 * appearance table. A `color()`-painted face never gets one — paint is the
 * override — and neither does the default look, which stays Phong.
 *
 * A wood preset adds procedural grain in the shader, nothing downloaded:
 * stripes along the body's longest axis on the faces that run with it,
 * rings on the end faces, blended by the face normal (the tessellation has
 * no UVs, and projection is what keeps the grain continuous across every
 * face and seamless at every edge). The grain is computed from the
 * part-space position in millimetres, so a stripe is the same width in an inch
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
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
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

/** Millimetres per grain unit — see {@link installShader}. */
const GRAIN_UNIT_MM = 64;

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
  // Part-space units → grain units. The grain functions put a stripe every
  // ~0.09 grain units; at 64 mm per unit that is a stripe every ~6 mm, the
  // scale that reads on parts tens of millimetres across.
  const grainScale = 1 / (GRAIN_UNIT_MM * options.unitsPerMm);

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

// The grain functions: value noise driving sinusoidal stripes with a slow
// sway and a fine ripple for the faces along the grain, wobbling rings for
// the end grain. Coordinates in grain units (GRAIN_UNIT_MM).
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

float grainNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 local = fract(p);
  float a = grainHash(cell);
  float b = grainHash(cell + vec2(1.0, 0.0));
  float c = grainHash(cell + vec2(0.0, 1.0));
  float d = grainHash(cell + vec2(1.0, 1.0));
  vec2 blend = local * local * (3.0 - 2.0 * local);
  return mix(a, b, blend.x) + (c - a) * blend.y * (1.0 - blend.x) + (d - b) * blend.x * blend.y;
}

// coord.x runs along the grain, coord.y across it.
float faceGrain(vec2 coord) {
  float across = coord.y * 2.8;
  float sway = grainNoise(coord * vec2(1.1, 3.8)) * 0.7;
  float ripple = grainNoise(coord * vec2(3.4, 9.0)) * 0.2;
  float rawBands = 0.5 + 0.5 * sin((across + sway + ripple) * 24.0);
  float bands = 1.0 - smoothstep(0.0, 0.1, rawBands);
  float pores = grainNoise(coord * vec2(6.0, 18.0));
  return clamp(bands * 0.92 + pores * 0.08, 0.0, 1.0);
}

float endGrain(vec2 coord) {
  vec2 scaled = coord * 3.2;
  float wobble = grainNoise(scaled * 1.5) - 0.5;
  vec2 offset = vec2(wobble, grainNoise(scaled * 1.9 + 4.2) - 0.5) * 0.35;
  float radius = length(scaled + offset);
  float rings = 0.5 + 0.5 * sin(radius * 18.0 + wobble * 4.0);
  return mix(rings, grainNoise(scaled * 4.0), 0.12);
}

// The grain seen from each axis, blended by the face normal: the projection
// facing along the grain axis shows end grain, the other two the stripes.
float woodGrain(vec3 p, vec3 n) {
  vec3 w = pow(abs(n), vec3(6.0));
  w /= w.x + w.y + w.z + 0.0001;
  float gx, gy, gz;
  if (uGrainAxis.x > 0.5) {
    gx = endGrain(p.yz);
    gy = faceGrain(vec2(p.x, p.z));
    gz = faceGrain(vec2(p.x, p.y));
  } else if (uGrainAxis.y > 0.5) {
    gx = faceGrain(vec2(p.y, p.z));
    gy = endGrain(p.xz);
    gz = faceGrain(vec2(p.y, p.x));
  } else {
    gx = faceGrain(vec2(p.z, p.y));
    gy = faceGrain(vec2(p.z, p.x));
    gz = endGrain(p.xy);
  }
  return gx * w.x + gy * w.y + gz * w.z;
}
`;

const GRAIN_MAP_FRAGMENT = /* glsl */ `
float grain = woodGrain(vGrainPos * uGrainScale, normalize(vGrainNormal));
float stripeMask = smoothstep(0.18, 0.78, grain);
diffuseColor.rgb *= 1.0 - stripeMask * uStripeVisibility * 0.28;
`;
