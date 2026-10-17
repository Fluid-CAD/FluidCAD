import type { TopoDS_Shape, TopTools_MapOfShape } from "ocjs-fluidcad";
import { Matrix4 } from "../math/matrix4.js";
import { Shape } from "../common/shapes.js";
import { ShapeType } from "../common/shape-type.js";
import { SceneObject } from "../common/scene-object.js";
import { TopologyIndex } from "../oc/topology-index.js";
import { FilterBase } from "./filter-base.js";
import type { FilterBuilderBase } from "./filter-builder-base.js";

export class FromSceneObjectFilter<TShape extends Shape> extends FilterBase<TShape> {
  private membershipSet: TopTools_MapOfShape | null = null;

  constructor(
    private sceneObjects: SceneObject[],
    private shapeType: ShapeType,
  ) {
    super();
  }

  getSceneObjects(): SceneObject[] {
    return this.sceneObjects;
  }

  getShapeType(): ShapeType {
    return this.shapeType;
  }

  setMembershipSet(set: TopTools_MapOfShape | null) {
    this.membershipSet = set;
  }

  match(shape: TShape): boolean {
    if (this.membershipSet) {
      return this.membershipSet.Contains(shape.getShape());
    }
    for (const obj of this.sceneObjects) {
      const subShapes = obj.getShapes().flatMap(s => s.getSubShapes(this.shapeType));
      if (subShapes.some(sub => sub.isSame(shape))) {
        return true;
      }
    }
    return false;
  }

  compareTo(other: FromSceneObjectFilter<TShape>): boolean {
    if (this.shapeType !== other.shapeType) {
      return false;
    }
    if (this.sceneObjects.length !== other.sceneObjects.length) {
      return false;
    }
    for (let i = 0; i < this.sceneObjects.length; i++) {
      if (!this.sceneObjects[i].compareTo(other.sceneObjects[i])) {
        return false;
      }
    }
    return true;
  }

  transform(_matrix: Matrix4): FromSceneObjectFilter<TShape> {
    return new FromSceneObjectFilter<TShape>(this.sceneObjects, this.shapeType);
  }

  override remap(remap: Map<SceneObject, SceneObject>): FromSceneObjectFilter<TShape> {
    const remapped = this.sceneObjects.map(obj => remap.get(obj) ?? obj);
    return new FromSceneObjectFilter<TShape>(remapped, this.shapeType);
  }
}

/**
 * Give every `from()` filter in the builders its membership set — the
 * sub-shapes its scene objects hold — and return the disposer that clears and
 * frees them. `removalScope` bounds which removals count when reading those
 * objects' shapes (see SceneObject.getOwnShapes), exactly as it bounds the
 * candidate universe: a statement-boundary evaluation passes the objects
 * before the boundary, so a solid the edited statement (or anything after
 * it) consumed still belongs to its owner there — as it does when that
 * statement's arguments build.
 */
export function injectFromMembership(
  filters: FilterBuilderBase<Shape>[],
  removalScope?: Set<SceneObject>,
): () => void {
  const allocated: { filter: FromSceneObjectFilter<Shape>; set: TopTools_MapOfShape }[] = [];
  for (const builder of filters) {
    for (const filter of builder.getFilters()) {
      if (!(filter instanceof FromSceneObjectFilter)) {
        continue;
      }
      const shapeType = filter.getShapeType();
      const rawShapes: TopoDS_Shape[] = [];
      for (const obj of filter.getSceneObjects()) {
        for (const owner of obj.getShapes({}, undefined, removalScope)) {
          for (const sub of owner.getSubShapes(shapeType)) {
            rawShapes.push(sub.getShape());
          }
        }
      }
      const set = TopologyIndex.buildShapeSet(rawShapes);
      filter.setMembershipSet(set);
      allocated.push({ filter, set });
    }
  }
  return () => {
    for (const { filter, set } of allocated) {
      filter.setMembershipSet(null);
      set.delete();
    }
  };
}
