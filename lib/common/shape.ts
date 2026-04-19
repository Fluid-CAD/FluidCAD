import type { TopoDS_Shape } from "occjs-wrapper";
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
  id: string;

  colorMap: Array<{ shape: TopoDS_Shape; color: string }> = [];

  private meshes: SceneObjectMesh[]
  private _meshSource: { shape: Shape; matrix: Matrix4 } | null = null;

  constructor(private shape: T) {
    this.id = randomUUID()
  }

  abstract getType(): ShapeType;

  getShape(): T {
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

  dispose() {
    this.shape?.delete();
  }

  markAsMetaShape(type?: string) {
    this.isMetaShapeFlag = true;
    this.metaType = type;
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

    this.colorMap.push({ shape: face, color });
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
