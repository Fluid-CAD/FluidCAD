import {
  BufferGeometry,
  Color,
  DoubleSide,
  Line,
  ShaderMaterial,
  ShaderMaterialParameters,
} from 'three';
import { trackPixelsPerWorld } from './screen-scale';

// Dash-dot pattern parameters (in screen pixels)
const DASH_LENGTH_PX = 10;
const GAP_LENGTH_PX = 4;
const DOT_LENGTH_PX = 2;
const PATTERN_LENGTH_PX = DASH_LENGTH_PX + GAP_LENGTH_PX + DOT_LENGTH_PX + GAP_LENGTH_PX;

const vertexShader = /* glsl */ `
  attribute float lineDistance;
  uniform float pixelsPerWorld;
  varying float vLineDistance;

  void main() {
    vLineDistance = lineDistance * pixelsPerWorld;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 color;
  uniform float dashLength;
  uniform float gapLength;
  uniform float dotLength;
  uniform float patternLength;

  varying float vLineDistance;

  void main() {
    float t = mod(vLineDistance, patternLength);

    // Pattern: [dash][gap][dot][gap]
    if (t < dashLength) {
      // In the dash segment — draw
    } else if (t < dashLength + gapLength) {
      discard; // First gap
    } else if (t < dashLength + gapLength + dotLength) {
      // In the dot segment — draw
    } else {
      discard; // Second gap
    }

    gl_FragColor = vec4(color, 1.0);
  }
`;

type DashDotMaterialParams = Omit<
  ShaderMaterialParameters,
  'uniforms' | 'vertexShader' | 'fragmentShader'
>;

/**
 * Builds a dash-dot line whose pattern is sized in screen pixels: the
 * pixels-per-world factor is re-evaluated before every draw so the dashes
 * keep the same apparent size at any zoom level.
 */
export function createDashDotLine(
  geometry: BufferGeometry,
  color: Color | { r: number; g: number; b: number },
  materialParams: DashDotMaterialParams = {},
): Line {
  const material = new ShaderMaterial({
    uniforms: {
      color: { value: color },
      dashLength: { value: DASH_LENGTH_PX },
      gapLength: { value: GAP_LENGTH_PX },
      dotLength: { value: DOT_LENGTH_PX },
      patternLength: { value: PATTERN_LENGTH_PX },
      pixelsPerWorld: { value: 1 },
    },
    vertexShader,
    fragmentShader,
    side: DoubleSide,
    transparent: true,
    ...materialParams,
  });

  const line = new Line(geometry, material);
  line.computeLineDistances();
  trackPixelsPerWorld(line, (pixelsPerWorld) => {
    material.uniforms.pixelsPerWorld.value = pixelsPerWorld;
  });
  return line;
}
