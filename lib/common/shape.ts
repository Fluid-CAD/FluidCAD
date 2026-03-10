import type { TopoDS_Shape } from "occjs-wrapper";
import { ShapeType } from "./shape-type.js";
import { SceneObjectMesh } from "../rendering/scene.js";
import { randomUUID } from "crypto";

export interface ShapeFilter {
  excludeMeta?: boolean;
  excludeGuide?: boolean;
}

export abstract class Shape<T extends TopoDS_Shape = TopoDS_Shape> {
  isMetaShapeFlag = false;
  isGuideFlag = false;
  id: string;

  colorMap: Array<{ shape: TopoDS_Shape; color: string }> = [];

  private meshes: SceneObjectMesh[]

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

  markAsMetaShape() {
    this.isMetaShapeFlag = true;
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
