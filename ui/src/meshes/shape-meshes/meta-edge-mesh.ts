import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Line,
  ShaderMaterial,
} from 'three';
import { SceneObjectPart } from '../../types';

const COLOR = '#b0b0b0';

// Dash-dot pattern parameters (in world units)
const DASH_LENGTH = 4.0;
const GAP_LENGTH = 1.5;
const DOT_LENGTH = 0.6;
const PATTERN_LENGTH = DASH_LENGTH + GAP_LENGTH + DOT_LENGTH + GAP_LENGTH;

const vertexShader = /* glsl */ `
  attribute float lineDistance;
  varying float vLineDistance;

  void main() {
    vLineDistance = lineDistance;
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

/**
 * Renders meta-shape / guide edges as dash-dot light-gray lines.
 *
 * The backend emits edge data as vertex pairs for LineSegments. To get
 * proper dashing we rebuild the data as a continuous polyline so that
 * `computeLineDistances()` accumulates across the whole curve.
 */
export class MetaEdgeMesh extends Group {
  constructor(shape: SceneObjectPart) {
    super();
    this.userData.isMetaShape = true;

    for (const meshData of shape.meshes) {
      const srcVerts = meshData.vertices;
      const indices = meshData.indices;

      // Build a continuous polyline from the segment pairs.
      // Pairs share endpoints: seg0=(A,B), seg1=(B,C), …
      // Take the first vertex of each pair, plus the last vertex of the final pair.
      const positions: number[] = [];
      for (let i = 0; i < indices.length; i += 2) {
        const idx = indices[i] * 3;
        positions.push(srcVerts[idx], srcVerts[idx + 1], srcVerts[idx + 2]);
      }
      // Append the end vertex of the last pair
      if (indices.length >= 2) {
        const lastIdx = indices[indices.length - 1] * 3;
        positions.push(srcVerts[lastIdx], srcVerts[lastIdx + 1], srcVerts[lastIdx + 2]);
      }

      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));

      const material = new ShaderMaterial({
        uniforms: {
          color: { value: { r: 0.69, g: 0.69, b: 0.69 } }, // #b0b0b0
          dashLength: { value: DASH_LENGTH },
          gapLength: { value: GAP_LENGTH },
          dotLength: { value: DOT_LENGTH },
          patternLength: { value: PATTERN_LENGTH },
        },
        vertexShader,
        fragmentShader,
        side: DoubleSide,
        transparent: true,
        polygonOffset: true,
        polygonOffsetFactor: 2,
        polygonOffsetUnits: 1,
      });

      const line = new Line(geometry, material);
      line.computeLineDistances();
      this.add(line);
    }
  }
}
