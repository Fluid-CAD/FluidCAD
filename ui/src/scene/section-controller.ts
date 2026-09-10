import {
  AlwaysStencilFunc,
  BackSide,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DecrementWrapStencilOp,
  DoubleSide,
  FrontSide,
  Group,
  IncrementWrapStencilOp,
  InterleavedBufferAttribute,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshPhongMaterial,
  NotEqualStencilFunc,
  Object3D,
  Plane,
  PlaneGeometry,
  Quaternion,
  ReplaceStencilOp,
  Vector3,
} from 'three';
import { SectionClipper } from './section-clipper';
import { SectionPlaneMath, type ResolvedSection, type SectionSpec, type Vec3Tuple } from './section-spec';
import { themeColors } from './theme-colors';

export type { ResolvedSection, SectionPlaneName, SectionPlaneSpec, SectionSpec, Vec3Tuple } from './section-spec';
export { SectionPlaneMath } from './section-spec';

type PositionAttribute = BufferAttribute | InterleavedBufferAttribute;

/** The three.js side of {@link SectionPlaneMath}: a resolved section as a clipping `Plane`. */
export class SectionPlanes {

  /** The material clipping plane (fragments with a negative signed distance are discarded). */
  static clipPlane(section: ResolvedSection): Plane {
    return new Plane(new Vector3(...section.clipPlane.normal), section.clipPlane.constant);
  }

  static vector(v: Vec3Tuple): Vector3 {
    return new Vector3(v[0], v[1], v[2]);
  }
}

/**
 * A section (cut-away) view on a scene root: the half on the spec's normal
 * side is clipped away and every solid the plane passes through gets its
 * cut face capped, so bodies read as solid rather than hollow.
 *
 * Clipping is {@link SectionClipper}'s: material clipping planes with the
 * coplanar-exemption technique (geometry lying exactly on the plane is drawn
 * unclipped, no offsets, no displaced geometry). Capping is the stencil
 * technique: for each cut solid, its clipped surface is drawn into the
 * stencil buffer only (back faces count up, front faces count down, so the
 * count is non-zero exactly where the view ray is inside the solid at the
 * plane), then a quad on the plane is drawn where the count is non-zero, in
 * a cap colour derived from that solid's face colour, and resets the count
 * so the next solid starts clean. Everything is ordered by `renderOrder`
 * ahead of the model, so one ordinary `renderer.render` produces the picture.
 *
 * Coplanar faces follow the clipper's rule so a cap never fights a real
 * face: triangles on the plane are left out of the clipped stencil pass
 * (they sit on the rounding edge) and drawn unclipped instead when their
 * outward normal points into the removed half, which is when the solid
 * behind them is kept and its own face covers the cut. A solid that lies
 * entirely on one side gets no cap.
 *
 * Contract:
 *  - The renderer must be created with `stencil: true` (three r163+ defaults
 *    it off; without a stencil buffer the caps draw as full squares) and
 *    `localClippingEnabled = true`.
 *  - `apply(root, spec)` is idempotent and re-entrant: call it once for a
 *    one-shot export, or again with a new spec (or after the scene rebuilt
 *    under the same root) from a live loop; it tears down its previous state
 *    first. `clear()` removes every overlay and clipping plane it added and
 *    disposes every geometry and material it created. The model's own
 *    resources are never disposed. Nothing else on the scene is touched: no
 *    camera, lights, backgrounds or visibility.
 *  - Apply it after any other visibility change of a capture (hide, focus,
 *    solids-only) and clear it before undoing them: the caps are built from
 *    what is visible at apply time and the overlays are children of the
 *    model meshes.
 *  - `root` is the geometry root (the compiled mesh or the assembly
 *    container); helpers like the grid and axes outside it stay uncut.
 *  - Highlight overlays inside the root are clipped like the model, so a
 *    highlighted internal face reads as cut; they draw after the caps.
 *
 * The interactive UI drives it the same way: keep one controller per scene,
 * `apply` on every spec change and after every render that replaces the
 * geometry root's children, `clear` when the section view closes.
 */
export class SectionController {
  private readonly clipper = new SectionClipper();
  private readonly caps = new SectionCaps();
  private root: Object3D | null = null;
  private spec: SectionSpec | null = null;
  /** Every model material's clipping planes as found at apply time, put back on clear. */
  private priorClipping = new Map<Material, Plane[] | null>();

  /** The spec currently applied, or null. */
  get current(): SectionSpec | null {
    return this.spec;
  }

  apply(root: Object3D, spec: SectionSpec): void {
    if (this.root && this.root !== root) {
      this.clear();
    }
    const section = SectionPlaneMath.resolve(spec);
    const plane = SectionPlanes.clipPlane(section);
    // Caps first: their markers must not be there when the clipper visits,
    // and the clipper's own overlays must be there before the caps classify.
    this.caps.dispose();
    if (this.root !== root) {
      this.priorClipping = SectionController.snapshotClipping(root);
    }
    this.clipper.apply(root, plane);
    this.caps.build(root, section, plane);
    this.root = root;
    this.spec = spec;
  }

  clear(): void {
    if (!this.root) {
      return;
    }
    this.caps.dispose();
    this.clipper.clear(this.root);
    // The clipper's clear blanks every material; a section taken over
    // another clip (sketch mode's) hands that clip back.
    for (const [material, planes] of this.priorClipping) {
      material.clippingPlanes = planes;
    }
    this.priorClipping = new Map();
    this.root = null;
    this.spec = null;
  }

  private static snapshotClipping(root: Object3D): Map<Material, Plane[] | null> {
    const snapshot = new Map<Material, Plane[] | null>();
    root.traverse((node) => {
      if (node.userData.isSectionOverlay) {
        return;
      }
      const material = (node as Mesh).material as Material | Material[] | undefined;
      if (!material) {
        return;
      }
      for (const m of Array.isArray(material) ? material : [material]) {
        if (!snapshot.has(m)) {
          snapshot.set(m, m.clippingPlanes ? [...m.clippingPlanes] : m.clippingPlanes);
        }
      }
    });
    return snapshot;
  }
}

/** One cut solid's cap: its stencil markers and the coloured quad. */
type CapEntry = { markers: Object3D[]; quad: Mesh };

/**
 * The stencil caps of a section: see {@link SectionController} for the
 * technique. Builds one cap per visible solid the plane cuts; `dispose`
 * removes and frees everything it built.
 */
export class SectionCaps {

  /** Below every model object (solids draw at 1-2, helpers at 0). */
  static readonly RENDER_ORDER_BASE = -1000;
  /** The cap colour is the solid's face colour, shaded so the cut reads as a section. */
  static readonly CAP_SHADE = 0.8;
  static readonly GROUP_NAME = 'sectionCaps';

  private group: Group | null = null;
  private readonly entries: CapEntry[] = [];
  private readonly owned: Array<BufferGeometry | Material> = [];

  /** The caps built by the last {@link build}: one per cut solid. */
  get count(): number {
    return this.entries.length;
  }

  build(root: Object3D, section: ResolvedSection, plane: Plane): void {
    this.dispose();
    root.updateMatrixWorld(true);
    const group = new Group();
    group.name = SectionCaps.GROUP_NAME;
    group.userData.isSectionOverlay = true;
    // Children are placed in world space whatever the root's own transform.
    group.matrixAutoUpdate = false;
    group.matrix.copy(root.matrixWorld).invert();
    group.matrixWorldNeedsUpdate = true;
    root.add(group);
    this.group = group;

    for (const solid of SectionCaps.cutSolids(root, section)) {
      this.addCap(solid, section, plane);
    }
    group.updateMatrixWorld(true);
  }

  dispose(): void {
    for (const entry of this.entries) {
      for (const marker of entry.markers) {
        marker.removeFromParent();
      }
      entry.quad.removeFromParent();
    }
    for (const resource of this.owned) {
      resource.dispose();
    }
    this.entries.length = 0;
    this.owned.length = 0;
    this.group?.removeFromParent();
    this.group = null;
  }

  // -------------------------------------------------------------------------
  // Which solids the plane cuts
  // -------------------------------------------------------------------------

  /**
   * Every visible solid subtree (`userData.isSolid`, not a meta shape or a
   * select overlay) whose world bounds straddle the cut plane, with its
   * face meshes and bounds.
   */
  static cutSolids(root: Object3D, section: ResolvedSection): Array<{ meshes: Mesh[]; box: Box3 }> {
    const found: Array<{ meshes: Mesh[]; box: Box3 }> = [];
    const visit = (node: Object3D): void => {
      if (!node.visible || node.userData.isSectionOverlay) {
        return;
      }
      if (node.userData.isSolid) {
        if (!node.userData.isMetaShape && node.renderOrder < 999) {
          const meshes = SectionCaps.faceMeshes(node);
          const box = SectionCaps.worldBox(meshes);
          if (meshes.length > 0 && SectionCaps.straddles(box, section)) {
            found.push({ meshes, box });
          }
        }
        return;
      }
      for (const child of node.children) {
        visit(child);
      }
    };
    visit(root);
    return found;
  }

  /** Whether the box has corners on both sides of the cut (a corner on the plane counts as kept). */
  static straddles(box: Box3, section: ResolvedSection): boolean {
    if (box.isEmpty()) {
      return false;
    }
    let kept = 0;
    let removed = 0;
    for (let i = 0; i < 8; i++) {
      const corner: Vec3Tuple = [
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      ];
      if (SectionPlaneMath.keeps(section, corner)) {
        kept++;
      } else {
        removed++;
      }
    }
    return kept > 0 && removed > 0;
  }

  private static faceMeshes(solid: Object3D): Mesh[] {
    const meshes: Mesh[] = [];
    solid.traverse((obj) => {
      const mesh = obj as Mesh;
      if (mesh.isMesh && obj.visible && !obj.userData.isSectionOverlay && mesh.geometry?.getAttribute('position')) {
        meshes.push(mesh);
      }
    });
    return meshes;
  }

  private static worldBox(meshes: Mesh[]): Box3 {
    const box = new Box3();
    for (const mesh of meshes) {
      mesh.geometry.computeBoundingBox();
      if (mesh.geometry.boundingBox) {
        box.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
      }
    }
    return box;
  }

  // -------------------------------------------------------------------------
  // One solid's cap
  // -------------------------------------------------------------------------

  private addCap(solid: { meshes: Mesh[]; box: Box3 }, section: ResolvedSection, plane: Plane): void {
    const order = SectionCaps.RENDER_ORDER_BASE + this.entries.length * 2;
    const markers: Object3D[] = [];
    for (const mesh of solid.meshes) {
      const partition = SectionCaps.markerPartition(mesh, section, plane);
      if (!partition) {
        continue;
      }
      for (const marker of this.markersFor(mesh, partition.clipped, plane, order)) {
        markers.push(marker);
      }
      for (const marker of this.markersFor(mesh, partition.coplanarKept, null, order)) {
        markers.push(marker);
      }
    }
    if (markers.length === 0) {
      return;
    }
    const quad = this.quadFor(solid, section, order + 1);
    this.entries.push({ markers, quad });
  }

  /**
   * The vertex data a solid's face mesh contributes to the stencil pass:
   * `clipped` is every triangle off the plane (drawn under the clip plane),
   * `coplanarKept` the triangles on the plane whose outward normal points
   * into the removed half (drawn unclipped). Coplanar triangles facing the
   * kept half bound a removed body and contribute nothing. Null when the
   * mesh has no positions.
   */
  static markerPartition(mesh: Mesh, section: ResolvedSection, plane: Plane): { clipped: Float32Array; coplanarKept: Float32Array } | null {
    const classified = SectionClipper.classifyTriangles(mesh, plane, true);
    if (!classified) {
      return null;
    }
    const position = mesh.geometry.getAttribute('position') as PositionAttribute;
    const normal = mesh.geometry.getAttribute('normal') as PositionAttribute | undefined;
    const removedLocal = classified.localPlane.normal.clone().negate();
    const kept: number[] = [];
    const { coplanarIndices } = classified;
    for (let t = 0; t < coplanarIndices.length; t += 3) {
      const a = coplanarIndices[t];
      const b = coplanarIndices[t + 1];
      const c = coplanarIndices[t + 2];
      const outward = SectionCaps.triangleNormal(position, normal, a, b, c);
      if (outward.dot(removedLocal) > 0) {
        kept.push(a, b, c);
      }
    }
    return {
      clipped: SectionClipper.gatherVertices(position, classified.offPlaneIndices),
      coplanarKept: SectionClipper.gatherVertices(position, kept),
    };
  }

  /** A triangle's outward normal: the vertex normal when the mesh carries one, else the winding's. */
  private static triangleNormal(position: PositionAttribute, normal: PositionAttribute | undefined, a: number, b: number, c: number): Vector3 {
    if (normal) {
      return new Vector3(normal.getX(a), normal.getY(a), normal.getZ(a));
    }
    const pa = new Vector3(position.getX(a), position.getY(a), position.getZ(a));
    const pb = new Vector3(position.getX(b), position.getY(b), position.getZ(b));
    const pc = new Vector3(position.getX(c), position.getY(c), position.getZ(c));
    return pb.sub(pa).cross(pc.sub(pa));
  }

  /** Back-face (count up) and front-face (count down) stencil markers for one vertex set, as children of the mesh. */
  private markersFor(mesh: Mesh, positions: Float32Array, plane: Plane | null, order: number): Mesh[] {
    if (positions.length === 0) {
      return [];
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.computeBoundingSphere();
    this.owned.push(geometry);
    const markers: Mesh[] = [];
    for (const [side, op] of [[BackSide, IncrementWrapStencilOp], [FrontSide, DecrementWrapStencilOp]] as const) {
      const material = new MeshBasicMaterial({
        side,
        colorWrite: false,
        depthWrite: false,
        depthTest: false,
        stencilWrite: true,
        stencilFunc: AlwaysStencilFunc,
        stencilFail: op,
        stencilZFail: op,
        stencilZPass: op,
      });
      material.clippingPlanes = plane ? [plane] : [];
      this.owned.push(material);
      const marker = new Mesh(geometry, material);
      marker.renderOrder = order;
      marker.userData.isSectionOverlay = true;
      marker.userData.isSectionMarker = true;
      marker.raycast = () => {};
      // Identity local transform: the exact placement of the surface it counts.
      mesh.add(marker);
      markers.push(marker);
    }
    return markers;
  }

  /** The cap quad: on the plane, covering the solid's bounding sphere, drawn where the stencil count is non-zero and resetting it. */
  private quadFor(solid: { meshes: Mesh[]; box: Box3 }, section: ResolvedSection, order: number): Mesh {
    const center = solid.box.getCenter(new Vector3());
    const radius = solid.box.getSize(new Vector3()).length() / 2;
    const geometry = new PlaneGeometry(radius * 2, radius * 2);
    this.owned.push(geometry);
    const material = new MeshPhongMaterial({
      color: SectionCaps.capColor(solid.meshes),
      shininess: 5,
      side: DoubleSide,
      stencilWrite: true,
      stencilRef: 0,
      stencilFunc: NotEqualStencilFunc,
      stencilFail: ReplaceStencilOp,
      stencilZFail: ReplaceStencilOp,
      stencilZPass: ReplaceStencilOp,
    });
    material.clippingPlanes = [];
    this.owned.push(material);
    const quad = new Mesh(geometry, material);
    quad.renderOrder = order;
    quad.userData.isSectionOverlay = true;
    quad.userData.isSectionCap = true;
    quad.raycast = () => {};
    // Centred on the sphere centre projected onto the plane, facing the removed half.
    const removed = SectionPlanes.vector(section.removedDirection);
    const distance = removed.dot(center.clone().sub(SectionPlanes.vector(section.point)));
    quad.position.copy(center).sub(removed.clone().multiplyScalar(distance));
    quad.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), removed));
    this.group!.add(quad);
    return quad;
  }

  /** The solid's face colour (its untinted one while sketch-mode ghosting is on), shaded. */
  static capColor(meshes: Mesh[]): Color {
    for (const mesh of meshes) {
      const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as { color?: Color; userData?: Record<string, unknown> } | undefined;
      const source = (material?.userData?.ghostOriginalColor as Color | undefined) ?? material?.color;
      if (source instanceof Color) {
        return source.clone().multiplyScalar(SectionCaps.CAP_SHADE);
      }
    }
    return themeColors.faceColor.clone().multiplyScalar(SectionCaps.CAP_SHADE);
  }
}
