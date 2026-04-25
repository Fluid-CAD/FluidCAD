import { Matrix4 } from "../math/matrix4.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { FilterBuilderBase } from "../filters/filter-builder-base.js";
import { ShapeFilter } from "../filters/filter.js";
import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { ISelect } from "../core/interfaces.js";
import { Shape, ShapeFilter as ShapeFilterType } from "../common/shape.js";
import { ShapeType } from "../common/shape-type.js";
import { Face } from "../common/face.js";
import { BelongsToFaceFilter, NotBelongsToFaceFilter } from "../filters/edge/belongs-to-face.js";

export class SelectSceneObject extends SceneObject implements ISelect {

  private type: ShapeType;
  private shapes: Shape[] = [];

  constructor(private filters: FilterBuilderBase<Shape>[], private constraintObject?: SceneObject) {
    super();

    if (filters.every(f => f instanceof FaceFilterBuilder)) {
      this.type = "face";
    }
    else {
      this.type = "edge";
    }
  }

  build(context: BuildSceneObjectContext) {
    const parent = this.getParent();
    const transform = context.getTransform();
    let filters = this.filters;

    let sceneObjects = context.getSceneObjects();
    let excludedObjects: Shape[] = [];

    if (transform) {
      filters = filters.map(f => f.transform(transform));

      if (!this.constraintObject && parent) {
        const snapshot = parent.getSnapshot();
        excludedObjects = snapshot ? Array.from(snapshot.values()).flat() : [];
        sceneObjects = context.getSceneObjectsFromTo(parent, this);
      }
    }

    const allShapes = this.constraintObject ? this.constraintObject.getShapes() : this.getAllShapes(sceneObjects, excludedObjects);
    if (this.type === "edge") {
      this.injectScopeFaces(filters, sceneObjects);
    }
    const filteredShapes = this.applyFilters(allShapes, filters);
    console.log(`SelectSceneObject: shapes after filtering: ${filteredShapes[0]}`);
    this.addShapes(filteredShapes);
  }

  private getAllShapes(scope: SceneObject[], exludedShapes: Shape[]) {
    const scopeShapes = scope.flatMap(obj => obj.getShapes({}, 'solid').map(s => s.getSubShapes(this.type)).flat());
    exludedShapes = exludedShapes.flatMap(s => s.getSubShapes(this.type));
    const finalShapes = scopeShapes.filter(shape => !exludedShapes.some(exShape => exShape.isSame(shape)));

    console.log('=== Scope Objects:', scope.length, ' Shapes:', scopeShapes.length)
    console.log('=== Excluded Shapes:', exludedShapes.length)
    console.log('=== Final Shapes after exclusion:', finalShapes.length)

    let allShapes: Shape[] = [];
    for (const shape of finalShapes) {
      allShapes.push(shape);
    }

    console.log('SelectSceneObject: total shapes collected for filtering:', allShapes.length);
    return allShapes;
  }

  override getDependencies(): SceneObject[] {
    return this.constraintObject ? [this.constraintObject] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const remappedConstraint = this.constraintObject
      ? (remap.get(this.constraintObject) || this.constraintObject)
      : undefined;
    const remappedFilters = this.filters.map(f => f.remap(remap));
    return new SelectSceneObject(remappedFilters, remappedConstraint);
  }

  transform(matrix: Matrix4): SelectSceneObject {
    const mirroredFilters = this.filters.map(f => f.transform(matrix));
    return new SelectSceneObject(mirroredFilters, this.constraintObject);
  }

  private injectScopeFaces(filters: FilterBuilderBase<Shape>[], sceneObjects: SceneObject[]) {
    let scopeFaces: Face[] | null = null;
    for (const builder of filters) {
      for (const filter of builder.getFilters()) {
        if (filter instanceof BelongsToFaceFilter || filter instanceof NotBelongsToFaceFilter) {
          if (!scopeFaces) {
            scopeFaces = this.constraintObject
              ? this.constraintObject.getShapes().flatMap(s => s.getSubShapes("face")) as Face[]
              : sceneObjects.flatMap(obj =>
                  obj.getShapes({}, 'solid').flatMap(s => s.getSubShapes("face"))
                ) as Face[];
          }
          filter.setScopeFaces(scopeFaces);
        }
      }
    }
  }

  applyFilters(shapes: Shape[], filters: FilterBuilderBase<Shape>[]): Shape[] {
    const shapeFilter = new ShapeFilter(shapes, ...filters);
    return shapeFilter.apply();
  }

  compareTo(other: SelectSceneObject): boolean {
    if (!(other instanceof SelectSceneObject)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.type !== other.type) {
      return false;
    }

    const thisHasConstraint = !!this.constraintObject;
    const otherHasConstraint = !!other.constraintObject;
    if (thisHasConstraint !== otherHasConstraint) {
      return false;
    }
    if (thisHasConstraint && otherHasConstraint) {
      if (!this.constraintObject!.compareTo(other.constraintObject!)) {
        return false;
      }
    }

    if (this.filters.length !== other.filters.length) {
      return false;
    }

    for (let i = 0; i < this.filters.length; i++) {
      if (!this.filters[i].equals(other.filters[i])) {
        return false;
      }
    }

    return true;
  }

  shapeType(): string {
    return this.type;
  }

  getType(): string {
    return "select";
  }

  serialize() {
    return {
      selectionLength: this.shapes.length,
      type: this.type
    }
  }
}

