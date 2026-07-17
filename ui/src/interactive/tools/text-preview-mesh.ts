import { BufferAttribute, BufferGeometry, LineBasicMaterial, LineSegments } from 'three';

const PREVIEW_COLOR = 0x11a4ed;

/**
 * Builds the viewport mesh for a text outline preview: one LineSegments over
 * every polyline `/api/text-preview` returned — a single draw call however
 * many glyph edges the layout produced. Shared by the Text tool (create)
 * and the text edit dialog.
 */
export class TextPreviewMesh {
  static build(polylines: number[][]): LineSegments | null {
    let segmentCount = 0;
    for (const line of polylines) {
      segmentCount += Math.max(0, line.length / 3 - 1);
    }
    if (segmentCount === 0) {
      return null;
    }
    const verts = new Float32Array(segmentCount * 6);
    let offset = 0;
    for (const line of polylines) {
      for (let i = 0; i + 5 < line.length; i += 3) {
        verts.set(line.slice(i, i + 6), offset);
        offset += 6;
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(verts, 3));
    const mat = new LineBasicMaterial({ color: PREVIEW_COLOR, depthTest: false });
    const mesh = new LineSegments(geo, mat);
    mesh.renderOrder = 3;
    return mesh;
  }
}
