import { Matrix4 } from "../math/matrix4.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { FilterBuilderBase } from "../filters/filter-builder-base.js";
import { ShapeFilter } from "../filters/filter.js";
import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shapes.js";

export type Selectable = "edge" | "face";

export class SelectSceneObject extends SceneObject {

  private type: Selectable;
  private shapes: Shape[] = [];

  constructor(private filters: FilterBuilderBase<Shape>[]) {
    super();

    if (filters.every(f => f instanceof FaceFilterBuilder)) {
      this.type = "face";
    }
    else {
      this.type = "edge";
    }
    // else {
    //   throw new Error("All filters must be of the same type, either face() or edge()");
    // }
  }

  build(context: BuildSceneObjectContext) {
    const parent = this.getParent();
    const transform = this.getTransform();
    let filters = this.filters;

    let sceneObjects = context.getSceneObjects();
    let excludedObjects: Map<SceneObject, Shape[]> = new Map();

    if (transform) {
      filters = filters.map(f => f.transform(transform));
      console.log('SelectSceneObject: transform applied to selection filters.', filters);
      if (parent) {
        excludedObjects = parent.getSnapshot()
        console.log('SelectSceneObject: snapshot of parent for exclusion:', excludedObjects.size);
        sceneObjects = context.getSceneObjectsFromTo(parent, this)
        console.log('SelectSceneObject: scene objects from parent to self:', sceneObjects.length);
      }
    }

    const shapes = this.doBuild(sceneObjects, excludedObjects, filters);
    this.addShapes(shapes);
  }

  doBuild(sceneObjects: SceneObject[], excludedObjects: Map<SceneObject, Shape[]>, filters: FilterBuilderBase<Shape>[]): Shape[] {
    let actualShapes: Shape[] = [];
    let actualExcludedShapes: Shape[] = [];

    let sceneShapes = sceneObjects.flatMap(o => o.getShapes(false, 'solid'));
    let excludedShapes = Array.from(excludedObjects.values()).flat()

    for (const shape of sceneShapes) {
      actualShapes.push(...shape.getSubShapes(this.type));
    }

    for (const shape of excludedShapes) {
      actualExcludedShapes.push(...shape.getSubShapes(this.type));
    }

    if (actualExcludedShapes.length > 0) {
      actualShapes = actualShapes.filter(s => !actualExcludedShapes.some(es => s.getShape().IsSame(es.getShape())));
    }

    console.log('======= Shapes after exclusion:', actualShapes.length);

    if (actualShapes.length === 0) {
      actualShapes = actualExcludedShapes;
    }

    console.log('======= Shapes before filtering:', actualShapes.length);

    actualShapes = this.applyFilters(actualShapes, filters);

    console.log(`======= Selection length: ${actualShapes.length}`);

    return actualShapes;
  }

  override clone(): SceneObject[] {
    const cloned = new SelectSceneObject(this.filters);
    return [cloned];
  }

  transform(matrix: Matrix4) {
    const mirroredFilters = this.filters.map(f => f.transform(matrix));
    console.log('SelectSceneObject: transform applied to selection filters.', mirroredFilters);
    return new SelectSceneObject(mirroredFilters);
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

  isTransformable(): boolean {
    return true;
  }

  serialize() {
    return {
      selectionLength: this.shapes.length,
      type: this.type
    }
  }
}
