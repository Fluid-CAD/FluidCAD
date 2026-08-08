import {
  BufferAttribute,
  BufferGeometry,
  InterleavedBufferAttribute,
  LineSegments,
  Material,
  Matrix4,
  Mesh,
  Object3D,
  Plane,
} from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineResolutionRegistry } from '../meshes/shape-meshes/line-resolution';

type PositionAttribute = BufferAttribute | InterleavedBufferAttribute;

// CPU-side classification tolerance for "lies on the section plane", relative
// to the geometry's coordinate magnitude and floored at the CAD kernel's
// absolute tolerance. It only decides which primitives are exempt from
// clipping — no rendered geometry is ever displaced by it.
const RELATIVE_TOLERANCE = 1e-5;
const ABSOLUTE_TOLERANCE = 1e-7;

/**
 * Applies the sketch-mode section clipping plane to the compiled scene mesh
 * while keeping geometry that lies exactly ON the plane stable.
 *
 * Material clipping is a per-fragment signed-distance test, so fragments of
 * geometry coplanar with the plane (the face being sketched on, its boundary
 * edges, construction-plane quads) land on the float rounding edge and
 * flicker between kept and discarded — a z-fight-like speckle. Offsetting the
 * plane or the geometry would trade that for a visible gap on small models,
 * so instead coplanar geometry is exempted from the clip test:
 *  - objects lying entirely on the plane simply keep unclipped materials;
 *  - partially coplanar objects (a solid whose face is the sketch plane) are
 *    clipped as usual, and their coplanar triangles / line segments are drawn
 *    again by an unclipped overlay built from the exact same vertex
 *    coordinates, so every speckled fragment resolves to the identical
 *    surface with zero offset.
 */
export class SectionClipper {
  private overlays: Object3D[] = [];

  apply(root: Object3D, plane: Plane): void {
    this.removeOverlays();
    root.updateMatrixWorld(true);
    this.visit(root, plane);
  }

  clear(root: Object3D): void {
    this.removeOverlays();
    root.traverse((node) => {
      SectionClipper.setClipping(node, null);
    });
  }

  // -------------------------------------------------------------------------
  // Traversal
  // -------------------------------------------------------------------------

  private visit(node: Object3D, plane: Plane): void {
    // Sketch UI lives on the section plane and would be half-clipped by it.
    if (node.userData.isSketchRoot) {
      return;
    }
    if (node.userData.isSectionOverlay) {
      return;
    }

    if ((node as LineSegments2).isLineSegments2) {
      this.clipFatLines(node as LineSegments2, plane);
    } else if ((node as LineSegments).isLineSegments) {
      this.clipThinLines(node as LineSegments, plane);
    } else if ((node as Mesh).isMesh) {
      this.clipMesh(node as Mesh, plane);
    } else if ((node as Mesh).material) {
      SectionClipper.setClipping(node, plane);
    }

    for (const child of node.children) {
      this.visit(child, plane);
    }
  }

  // -------------------------------------------------------------------------
  // Per-object handlers
  // -------------------------------------------------------------------------

  private clipMesh(mesh: Mesh, plane: Plane): void {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position') as PositionAttribute | undefined;
    if (!position) {
      SectionClipper.setClipping(mesh, plane);
      return;
    }

    const { localPlane, tolerance } = SectionClipper.toLocal(mesh, geometry, plane);
    const onPlane = SectionClipper.vertexFlags(position, localPlane, tolerance);

    const index = geometry.getIndex();
    const triangleCount = Math.floor((index ? index.count : position.count) / 3);
    const coplanarIndices: number[] = [];
    for (let t = 0; t < triangleCount; t++) {
      const a = index ? index.getX(t * 3) : t * 3;
      const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      if (onPlane[a] && onPlane[b] && onPlane[c]) {
        coplanarIndices.push(a, b, c);
      }
    }

    if (triangleCount > 0 && coplanarIndices.length === triangleCount * 3) {
      SectionClipper.setClipping(mesh, null);
      return;
    }

    SectionClipper.setClipping(mesh, plane);

    if (coplanarIndices.length === 0) {
      return;
    }
    const material = mesh.material;
    if (Array.isArray(material) || material.transparent) {
      // An unclipped second draw would double-blend translucent surfaces, and
      // material groups don't map onto a single overlay clone.
      return;
    }

    const overlayGeometry = new BufferGeometry();
    overlayGeometry.setAttribute(
      'position',
      new BufferAttribute(SectionClipper.gatherVertices(position, coplanarIndices), 3),
    );
    const normal = geometry.getAttribute('normal') as PositionAttribute | undefined;
    if (normal) {
      overlayGeometry.setAttribute(
        'normal',
        new BufferAttribute(SectionClipper.gatherVertices(normal, coplanarIndices), 3),
      );
    }
    overlayGeometry.computeBoundingSphere();

    const overlayMaterial = material.clone();
    overlayMaterial.clippingPlanes = null;

    this.attachOverlay(mesh, new Mesh(overlayGeometry, overlayMaterial));
  }

  private clipThinLines(lines: LineSegments, plane: Plane): void {
    const geometry = lines.geometry;
    const position = geometry.getAttribute('position') as PositionAttribute | undefined;
    if (!position) {
      SectionClipper.setClipping(lines, plane);
      return;
    }

    const { localPlane, tolerance } = SectionClipper.toLocal(lines, geometry, plane);
    const onPlane = SectionClipper.vertexFlags(position, localPlane, tolerance);

    const index = geometry.getIndex();
    const segmentCount = Math.floor((index ? index.count : position.count) / 2);
    const coplanarIndices: number[] = [];
    for (let s = 0; s < segmentCount; s++) {
      const a = index ? index.getX(s * 2) : s * 2;
      const b = index ? index.getX(s * 2 + 1) : s * 2 + 1;
      if (onPlane[a] && onPlane[b]) {
        coplanarIndices.push(a, b);
      }
    }

    if (segmentCount > 0 && coplanarIndices.length === segmentCount * 2) {
      SectionClipper.setClipping(lines, null);
      return;
    }

    SectionClipper.setClipping(lines, plane);

    if (coplanarIndices.length === 0) {
      return;
    }
    const material = lines.material;
    if (Array.isArray(material) || material.transparent) {
      return;
    }

    const overlayGeometry = new BufferGeometry();
    overlayGeometry.setAttribute(
      'position',
      new BufferAttribute(SectionClipper.gatherVertices(position, coplanarIndices), 3),
    );
    overlayGeometry.computeBoundingSphere();

    const overlayMaterial = material.clone();
    overlayMaterial.clippingPlanes = null;

    this.attachOverlay(lines, new LineSegments(overlayGeometry, overlayMaterial));
  }

  private clipFatLines(lines: LineSegments2, plane: Plane): void {
    const geometry = lines.geometry;
    const start = geometry.getAttribute('instanceStart') as InterleavedBufferAttribute | undefined;
    const end = geometry.getAttribute('instanceEnd') as InterleavedBufferAttribute | undefined;
    if (!start || !end) {
      SectionClipper.setClipping(lines, plane);
      return;
    }

    const { localPlane, tolerance } = SectionClipper.toLocal(lines, geometry, plane);
    const { normal, constant } = localPlane;

    const coplanarSegments: number[] = [];
    for (let i = 0; i < start.count; i++) {
      const ds = normal.x * start.getX(i) + normal.y * start.getY(i) + normal.z * start.getZ(i) + constant;
      const de = normal.x * end.getX(i) + normal.y * end.getY(i) + normal.z * end.getZ(i) + constant;
      if (Math.abs(ds) <= tolerance && Math.abs(de) <= tolerance) {
        coplanarSegments.push(i);
      }
    }

    if (start.count > 0 && coplanarSegments.length === start.count) {
      SectionClipper.setClipping(lines, null);
      return;
    }

    SectionClipper.setClipping(lines, plane);

    if (coplanarSegments.length === 0) {
      return;
    }
    const material = lines.material;
    if (material.transparent) {
      return;
    }

    const positions = new Float32Array(coplanarSegments.length * 6);
    for (let j = 0; j < coplanarSegments.length; j++) {
      const s = coplanarSegments[j];
      const o = j * 6;
      positions[o] = start.getX(s);
      positions[o + 1] = start.getY(s);
      positions[o + 2] = start.getZ(s);
      positions[o + 3] = end.getX(s);
      positions[o + 4] = end.getY(s);
      positions[o + 5] = end.getZ(s);
    }

    const overlayGeometry = new LineSegmentsGeometry();
    overlayGeometry.setPositions(positions);

    const overlayMaterial = material.clone() as LineMaterial;
    overlayMaterial.clippingPlanes = null;
    LineResolutionRegistry.register(overlayMaterial);

    this.attachOverlay(lines, new LineSegments2(overlayGeometry, overlayMaterial));
  }

  // -------------------------------------------------------------------------
  // Overlay bookkeeping
  // -------------------------------------------------------------------------

  private attachOverlay(source: Object3D, overlay: Object3D): void {
    overlay.userData.isSectionOverlay = true;
    // The overlay re-draws fragments the source already owns for picking.
    overlay.raycast = () => {};
    // Child of the source with an identity local transform: exact same world
    // placement, and it inherits visibility and disposal with the tree.
    source.add(overlay);
    this.overlays.push(overlay);
  }

  private removeOverlays(): void {
    for (const overlay of this.overlays) {
      overlay.removeFromParent();
      const resource = overlay as Mesh;
      resource.geometry?.dispose();
      const material = resource.material;
      if (Array.isArray(material)) {
        for (const m of material) { m.dispose(); }
      } else {
        material?.dispose();
      }
    }
    this.overlays = [];
  }

  // -------------------------------------------------------------------------
  // Geometry helpers
  // -------------------------------------------------------------------------

  private static setClipping(node: Object3D, plane: Plane | null): void {
    const material = (node as Mesh).material as Material | Material[] | undefined;
    if (!material) {
      return;
    }
    const materials = Array.isArray(material) ? material : [material];
    for (const m of materials) {
      m.clippingPlanes = plane ? [plane] : [];
    }
  }

  private static toLocal(
    object: Object3D,
    geometry: BufferGeometry,
    plane: Plane,
  ): { localPlane: Plane; tolerance: number } {
    const inverse = new Matrix4().copy(object.matrixWorld).invert();
    const localPlane = plane.clone().applyMatrix4(inverse);
    if (geometry.boundingSphere === null) {
      geometry.computeBoundingSphere();
    }
    const sphere = geometry.boundingSphere;
    const magnitude = sphere ? sphere.center.length() + sphere.radius : 0;
    const tolerance = Math.max(ABSOLUTE_TOLERANCE, magnitude * RELATIVE_TOLERANCE);
    return { localPlane, tolerance };
  }

  private static vertexFlags(position: PositionAttribute, plane: Plane, tolerance: number): Uint8Array {
    const { normal, constant } = plane;
    const flags = new Uint8Array(position.count);
    for (let i = 0; i < position.count; i++) {
      const d = normal.x * position.getX(i) + normal.y * position.getY(i) + normal.z * position.getZ(i) + constant;
      if (Math.abs(d) <= tolerance) {
        flags[i] = 1;
      }
    }
    return flags;
  }

  /** Expand the picked indices into a compact non-indexed vertex array. */
  private static gatherVertices(attribute: PositionAttribute, indices: number[]): Float32Array {
    const out = new Float32Array(indices.length * 3);
    for (let i = 0; i < indices.length; i++) {
      const v = indices[i];
      out[i * 3] = attribute.getX(v);
      out[i * 3 + 1] = attribute.getY(v);
      out[i * 3 + 2] = attribute.getZ(v);
    }
    return out;
  }
}
