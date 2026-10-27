import type { TopoDS_Shape } from "ocjs-fluidcad";
import { ShapeType } from "./shape-type.js";
import type { ShapeMeshPieces } from "../rendering/mesh-pieces.js";
import { Matrix4 } from "../math/matrix4.js";
import type { ResolvedHelixGeometry } from "../math/helix-geometry.js";
import type { Face } from "./face.js";
import type { Edge } from "./edge.js";

export interface ShapeFilter {
  excludeMeta?: boolean;
  excludeGuide?: boolean;
  /**
   * Keep the shapes a display-only consumer hid (a sketch after its extrude)
   * in a scoped read, which then honours hard removals only: what the viewer
   * can draw again on request (the timeline eye) and so can be picked.
   */
  includeDisplayHidden?: boolean;
}

export abstract class Shape<T extends TopoDS_Shape = TopoDS_Shape> {
  isMetaShapeFlag = false;
  isGuideFlag = false;
  /**
   * Marks a solid as carrying delicate, intentionally un-unified geometry
   * (e.g. thread flanks from a helix sweep). Downstream booleans skip the
   * global UnifySameDomain face-merge for results derived from it, so the
   * feature isn't collapsed elsewhere on the body, and re-propagate the flag.
   */
  noSimplifyFlag = false;
  metaType?: string;
  metaData?: Record<string, any>;
  /** Role within the owning feature (e.g. rect 'top', polygon 'side'). */
  role?: string;
  /** Disambiguates repeated roles (e.g. polygon 'side' 0..n, 'corner-arc' 0..3). */
  roleIndex?: number;
  /** How a derived edge was produced (e.g. 'fillet-arc', 'bridge', 'offset-of'). */
  provenance?: string;
  id: string;

  /** The renderer's scope-free geometry cache — see `ShapeMeshPieces`. */
  private meshPieces: ShapeMeshPieces | null = null;
  private _meshSource: { shape: Shape; matrix: Matrix4 } | null = null;
  private _released: boolean = false;
  /** Independently owned native handles: rewrapped/cached paths do not depend on a source wrapper's lifetime. */
  private _helixEdges: { edge: TopoDS_Shape; geometry: ResolvedHelixGeometry }[] = [];
  /** Independently owned span boundaries suppressed only in solid line rendering. */
  private _renderSeams: TopoDS_Shape[] = [];

  getRenderSeams(): readonly TopoDS_Shape[] {
    return this._renderSeams;
  }

  recordRenderSeam(edge: TopoDS_Shape): void {
    if (!this._renderSeams.some(existing => existing.IsSame(edge))) {
      this._renderSeams.push(edge.Oriented(edge.Orientation()));
    }
  }

  getHelixEdges(): readonly { edge: TopoDS_Shape; geometry: ResolvedHelixGeometry }[] {
    return this._helixEdges;
  }

  recordHelixGeometry(edge: TopoDS_Shape, geometry: ResolvedHelixGeometry): void {
    if (this._helixEdges.some(entry => entry.edge.IsSame(edge))) return;
    this._helixEdges.push({ edge: edge.Oriented(edge.Orientation()), geometry });
  }

  constructor(private shape: T) {
    // globalThis.crypto works in Node >= 19 and the browser; node:crypto does not.
    this.id = globalThis.crypto.randomUUID()
  }

  abstract getType(): ShapeType;

  getShape(): T {
    if (this._released) {
      throw new Error(`Shape ${this.id} (${this.getType()}) used after its OC memory was released`);
    }
    return this.shape;
  }

  /**
   * The sub-shapes of one type the shape holds: a solid's faces or edges, a
   * face's edges, a wire's edges, an edge itself. Asked for faces or edges,
   * the list is typed as faces or edges; every subclass repeats these
   * overloads.
   */
  abstract getSubShapes(type: 'face'): Face[];
  abstract getSubShapes(type: 'edge'): Edge[];
  abstract getSubShapes(type: ShapeType): Shape[];

  isSame(other: Shape): boolean {
    if (!(other instanceof Shape)) {
      return false;
    }

    return this.getShape().IsSame(other.getShape());
  }

  isPartner(other: Shape): boolean {
    if (!(other instanceof Shape)) {
      return false;
    }

    return this.getShape().IsPartner(other.getShape());
  }

  isEqual(other: Shape): boolean {
    if (!(other instanceof Shape)) {
      return false;
    }

    return this.getShape().IsEqual(other.getShape());
  }

  isSolid() {
    return false;
  }

  isFace() {
    return false;
  }

  isEdge() {
    return false;
  }

  isWire() {
    return false;
  }

  isVertex() {
    return false;
  }

  /**
   * Free the underlying OC handle of a wrapper the caller solely owns
   * (build-time temporaries). Scene-owned wrappers are reclaimed through
   * `release` instead, which respects handles shared between wrappers.
   */
  dispose() {
    if (this._released) {
      return;
    }
    this._released = true;
    this.disposeSubShapes();
    for (const entry of this._helixEdges) entry.edge.delete();
    this._helixEdges = [];
    for (const edge of this._renderSeams) edge.delete();
    this._renderSeams = [];
    this.shape?.delete();
    this.shape = null;
    this.meshPieces = null;
    this._meshSource = null;
  }

  /**
   * Free the sub-shape wrappers this wrapper built and cached for itself
   * (a face's edges, a solid's faces): they are copies of its own
   * sub-shapes, so a wrapper the caller solely owns owns them too.
   */
  protected disposeSubShapes(): void {}

  isReleased(): boolean {
    return this._released;
  }

  /**
   * Reclaim the OC (WASM) memory behind this wrapper as part of scene
   * invalidation. `retainedRaw` holds raw handles still referenced by
   * surviving wrappers — `Solid.copy()` shares its raw handle with the
   * original, so those are skipped. `deletedRaw` dedupes
   * handles shared between dying wrappers. Cached sub-shape wrappers are
   * not released here: the scene-disposal walker reaches them through
   * `getLinkedShapes()` and releases each exactly once.
   */
  release(retainedRaw: ReadonlySet<object>, deletedRaw: Set<object>): void {
    if (this._released) {
      return;
    }
    this._released = true;
    this.deleteOwnedHandles(retainedRaw, deletedRaw);
    this._helixEdges = [];
    this._renderSeams = [];
    this.shape = null;
    this.meshPieces = null;
    this._meshSource = null;
  }

  /** Raw OC handles this wrapper points at — the dedup keys for `release`. */
  collectRawHandles(out: Set<object>): void {
    if (this._released) {
      return;
    }
    if (this.shape) {
      out.add(this.shape);
    }
    for (const entry of this._helixEdges) out.add(entry.edge);
    for (const edge of this._renderSeams) out.add(edge);
  }

  /**
   * Other wrappers this one links to (mesh source, cached sub-shape
   * wrappers). Used by the scene-disposal walker to reach wrappers that
   * are not stored in scene-object state directly.
   */
  getLinkedShapes(): Shape[] {
    return this._meshSource ? [this._meshSource.shape] : [];
  }

  protected deleteOwnedHandles(retainedRaw: ReadonlySet<object>, deletedRaw: Set<object>): void {
    Shape.deleteRawHandle(this.shape, retainedRaw, deletedRaw);
    for (const entry of this._helixEdges) Shape.deleteRawHandle(entry.edge, retainedRaw, deletedRaw);
    for (const edge of this._renderSeams) Shape.deleteRawHandle(edge, retainedRaw, deletedRaw);
  }

  protected static deleteRawHandle(
    raw: { delete(): void } | null,
    retainedRaw: ReadonlySet<object>,
    deletedRaw: Set<object>,
  ): void {
    if (!raw || retainedRaw.has(raw) || deletedRaw.has(raw)) {
      return;
    }
    deletedRaw.add(raw);
    raw.delete();
  }

  markAsMetaShape(type?: string) {
    this.isMetaShapeFlag = true;
    this.metaType = type;
  }

  setRole(role: string, roleIndex?: number) {
    this.role = role;
    this.roleIndex = roleIndex;
  }

  setProvenance(provenance: string) {
    this.provenance = provenance;
  }

  /** Carry role + provenance across a transform/copy/rebuild of the same edge. */
  copyRoleFrom(source: Shape) {
    this.role = source.role;
    this.roleIndex = source.roleIndex;
    this.provenance = source.provenance;
  }

  markAsGuide() {
    this.isGuideFlag = true;
  }

  markNoSimplify() {
    this.noSimplifyFlag = true;
  }

  noSimplify(): boolean {
    return this.noSimplifyFlag;
  }

  isMetaShape(): boolean {
    return this.isMetaShapeFlag;
  }

  isGuideShape(): boolean {
    return this.isGuideFlag;
  }

  getMeshPieces(): ShapeMeshPieces | null {
    return this.meshPieces;
  }

  setMeshPieces(pieces: ShapeMeshPieces | null) {
    this.meshPieces = pieces;
  }

  setMeshSource(source: Shape, matrix: Matrix4) {
    this._meshSource = { shape: source, matrix };
  }

  getMeshSource(): { shape: Shape; matrix: Matrix4 } | null {
    return this._meshSource;
  }

  copy(): Shape {
    throw new Error("Copy method not implemented for shape type: " + this.getType());
  }
}
