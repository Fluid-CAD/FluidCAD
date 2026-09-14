import { Color, DoubleSide, Group } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { EdgeMeshOptions, SceneObjectPart } from '../../types';
import { themeColors } from '../../scene/theme-colors';
import { viewerSettings } from '../../scene/viewer-settings';
import { LineResolutionRegistry } from './line-resolution';

/**
 * How far a tangent-junction edge's color is pulled from the edge color
 * toward the face color: 1 would hide it, 0 would draw it as a crease.
 */
const SMOOTH_EDGE_BLEND = 0.75;

const DEFAULTS: Required<EdgeMeshOptions> = {
  color: '',
  lineWidth: 1,
  opacity: 1,
  depthWrite: true,
  transparent: false,
};

export class EdgeMesh extends Group {
  constructor(shape: SceneObjectPart, options: EdgeMeshOptions = {}) {
    super();
    const opts = { ...DEFAULTS, ...options };

    for (const meshData of shape.meshes) {
      const positions = EdgeMesh.expandIndexedPositions(meshData.vertices, meshData.indices);

      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(positions);

      const material = new LineMaterial({
        color: EdgeMesh.lineColor(meshData.smooth === true, opts.color),
        linewidth: opts.lineWidth,
        transparent: opts.transparent || opts.opacity < 1,
        opacity: opts.opacity,
        side: DoubleSide,
        depthWrite: opts.depthWrite,
        depthTest: opts.depthWrite,
      });
      LineResolutionRegistry.register(material);

      const ls = new LineSegments2(geometry, material);
      ls.userData.isEdgeLine = true;
      if (meshData.edgeIndex !== undefined) {
        ls.userData.edgeIndex = meshData.edgeIndex;
      }
      if (meshData.smooth) {
        ls.userData.smoothEdge = true;
      }
      this.add(ls);
    }
  }

  /**
   * The resting color of one edge line. An explicit color option (selection
   * highlights, ghosts, sketch wires) always wins; otherwise a tangent (G1)
   * junction the engine flagged `smooth` draws like any other edge unless
   * the `dimTangentEdges` setting pulls it toward the face color.
   */
  static lineColor(smooth: boolean, explicit: string): number {
    if (explicit) {
      return new Color(explicit).getHex();
    }
    if (smooth && viewerSettings.current.dimTangentEdges) {
      return themeColors.edgeColor.clone().lerp(themeColors.faceColor, SMOOTH_EDGE_BLEND).getHex();
    }
    return themeColors.edgeColor.getHex();
  }

  /**
   * LineSegmentsGeometry wants a flat positions array of segment-pair endpoints
   * (no index buffer). Expand the indexed input into that form.
   */
  static expandIndexedPositions(vertices: number[], indices: number[]): Float32Array {
    const positions = new Float32Array(indices.length * 3);
    for (let i = 0; i < indices.length; i++) {
      const v = indices[i] * 3;
      positions[i * 3] = vertices[v];
      positions[i * 3 + 1] = vertices[v + 1];
      positions[i * 3 + 2] = vertices[v + 2];
    }
    return positions;
  }
}
