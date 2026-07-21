import type { TopoDS_Shape } from "ocjs-fluidcad";
import { ShapeType } from "./shape-type.js";
import { SceneObjectMesh } from "../rendering/scene.js";
import { Matrix4 } from "../math/matrix4.js";
import { randomUUID } from "crypto";

export interface ShapeFilter {
  excludeMeta?: boolean;
  excludeGuide?: boolean;
}

export abstract class Shape<T extends TopoDS_Shape = TopoDS_Shape> {
  isMetaShapeFlag = false;
  isGuideFlag = false;
  metaType?: string;
  metaData?: Record<string, any>;
  /** Role within the owning feature (e.g. rect 'top', polygon 'side'). */
  role?: string;
  /** Disambiguates repeated roles (e.g. polygon 'side' 0..n, 'corner-arc' 0..3). */
  roleIndex?: number;
  /** How a derived edge was produced (e.g. 'fillet-arc', 'bridge', 'offset-of'). */
  provenance?: string;
  id: string;

  colorMap: Array<{ shape: TopoDS_Shape; color: string }> = [];

  private meshes: SceneObjectMesh[]
  private _meshSource: { shape: Shape; matrix: Matrix4 } | null = null;
  private _released: boolean = false;

  constructor(private shape: T) {
    this.id = randomUUID()
  }

  abstract getType(): ShapeType;

  getShape(): T {
    if (this._released) {
      throw new Error(`Shape ${this.id} (${this.getType()}) used after its OC memory was released`);
    }
    return this.shape;
  }

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
    this.shape?.delete();
    this.shape = null;
  }

  isReleased(): boolean {
    return this._released;
  }

  /**
   * Reclaim the OC (WASM) memory behind this wrapper as part of scene
   * invalidation. `retainedRaw` holds raw handles still referenced by
   * surviving wrappers — `Solid.copy()` and `colorMap` entries share raw
   * handles across wrappers, so those are skipped. `deletedRaw` dedupes
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
    this.shape = null;
    this.meshes = null;
    this._meshSource = null;
    this.colorMap = [];
  }

  /** Raw OC handles this wrapper points at — the dedup keys for `release`. */
  collectRawHandles(out: Set<object>): void {
    if (this._released) {
      return;
    }
    if (this.shape) {
      out.add(this.shape);
    }
    for (const entry of this.colorMap) {
      out.add(entry.shape);
    }
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
    for (const entry of this.colorMap) {
      Shape.deleteRawHandle(entry.shape, retainedRaw, deletedRaw);
    }
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

  isMetaShape(): boolean {
    return this.isMetaShapeFlag;
  }

  isGuideShape(): boolean {
    return this.isGuideFlag;
  }

  getMeshes(): SceneObjectMesh[] {
    return this.meshes;
  }

  setMeshes(meshes: SceneObjectMesh[]) {
    this.meshes = meshes;
  }

  setMeshSource(source: Shape, matrix: Matrix4) {
    this._meshSource = { shape: source, matrix };
  }

  getMeshSource(): { shape: Shape; matrix: Matrix4 } | null {
    return this._meshSource;
  }

  setColor(face: TopoDS_Shape, color: string) {
    if (this.isEdge()) {
      throw new Error("Cannot set color on edge shape");
    }

    if (this.isWire()) {
      throw new Error("Cannot set color on wire shape");
    }

    if (this.isVertex()) {
      throw new Error("Cannot set color on vertex shape");
    }

    const existing = this.colorMap.findIndex(c => c.shape.IsSame(face));
    if (existing >= 0) {
      this.colorMap[existing] = { shape: face, color };
    } else {
      this.colorMap.push({ shape: face, color });
    }
  }

  getColor(face: TopoDS_Shape): string | undefined {
    const entry = this.colorMap.find(c => c.shape.IsSame(face));
    return entry?.color;
  }

  hasColors() {
    return this.colorMap.length > 0;
  }

  copy(): Shape {
    throw new Error("Copy method not implemented for shape type: " + this.getType());
  }
}
