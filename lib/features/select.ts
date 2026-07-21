import type { TopoDS_Shape, TopTools_MapOfShape } from "ocjs-fluidcad";
import { Matrix4 } from "../math/matrix4.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { FilterBuilderBase } from "../filters/filter-builder-base.js";
import { ShapeFilter } from "../filters/filter.js";
import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { ISelect } from "../core/interfaces.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { ShapeType } from "../common/shape-type.js";
import { Face } from "../common/face.js";
import { FromSceneObjectFilter } from "../filters/from-object.js";
import { injectBelongsToFaceScope } from "../filters/scope-injection.js";
import { TopologyIndex } from "../oc/topology-index.js";
import { ShapeHasher } from "../oc/shape-hash.js";
import { Edge } from "../common/edge.js";
import { Wire } from "../common/wire.js";
import { Sketch } from "./2d/sketch.js";

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

  override isSelection(): boolean {
    return true;
  }

  build(context: BuildSceneObjectContext) {
    const sketch = this.findParentSketch();
    if (sketch) {
      this.buildInSketch(sketch, context);
      return;
    }

    const parent = this.getParent();
    const transform = context.getTransform();
    let filters = this.filters;

    let sceneObjects = context.getSceneObjects();
    let excludedObjects: Shape[] = [];
    let narrowedToCloneGroup = false;

    if (transform) {
      filters = filters.map(f => f.transform(transform));

      if (!this.constraintObject && parent) {
        const snapshot = parent.getSnapshot();
        excludedObjects = snapshot ? Array.from(snapshot.values()).flat() : [];
        // Restrict to this clone instance's own siblings. Other instances of
        // the same repeat share the parent container but carry a different
        // clone transform, and the container itself would re-expose their
        // shapes through getChildShapes.
        const transformRef = this.getTransformRef();
        sceneObjects = context.getSceneObjectsFromTo(parent, this)
          .filter(o => o.getTransformRef() === transformRef);
        narrowedToCloneGroup = true;
      }
    }

    // Objects passed explicitly via `from(...)` bypass the part scope so that
    // cross-part selection works (e.g. select(face().from(p1)) from inside p2).
    if (!this.constraintObject) {
      const fromObjects = this.collectFromSceneObjects(filters);
      if (fromObjects.length > 0) {
        sceneObjects = sceneObjects.slice();
        for (const obj of fromObjects) {
          if (!sceneObjects.includes(obj)) {
            sceneObjects.push(obj);
          }
        }
      }
    }

    const allShapes = this.constraintObject ? this.constraintObject.getShapes() : this.getAllShapes(sceneObjects, excludedObjects);
    let scopeHasher: ShapeHasher | null = null;
    if (this.type === "edge") {
      scopeHasher = this.injectScopeFaces(filters, sceneObjects);
    }
    const fromFilters = this.injectFromMembershipSets(filters);
    try {
      let filteredShapes = this.applyFilters(allShapes, filters);
      if (filteredShapes.length === 0 && narrowedToCloneGroup) {
        // Nothing matched within the cloned group: the original selection
        // resolved to geometry outside the repeated objects (e.g. a wrap
        // target face on a base solid). Reuse that resolution — re-running
        // the transformed filters against base geometry cannot match.
        const source = this.getCloneSource();
        if (source instanceof SelectSceneObject) {
          filteredShapes = source.getAddedShapes();
        }
      }
      this.addShapes(filteredShapes);
    } finally {
      for (const { filter, set } of fromFilters) {
        filter.setMembershipSet(null);
        set.delete();
      }
      scopeHasher?.delete();
    }
  }

  private findParentSketch(): Sketch | null {
    let parent = this.getParent();
    while (parent && !(parent instanceof Sketch)) {
      parent = parent.getParent();
    }
    return (parent as Sketch) ?? null;
  }

  /**
   * Sketch-scoped selection: the universe is the active sketch's edges from
   * prior siblings (real geometry only — lazy accessors and other selections
   * are skipped). No belongsTo-face scope injection; edge-only inference.
   */
  private buildInSketch(sketch: Sketch, context: BuildSceneObjectContext) {
    if (this.type === "face") {
      throw new Error("select(face()...) is not supported inside a sketch — sketch selections are edge-only.");
    }

    const transform = context.getTransform();
    let filters = this.filters;
    if (transform) {
      filters = filters.map(f => f.transform(transform));
    }

    const universe: Edge[] = [];
    for (const sibling of sketch.getPreviousSiblings(this)) {
      if (sibling.isLazy() || sibling.isSelection()) {
        continue;
      }
      for (const shape of sibling.getShapes()) {
        if (shape instanceof Edge) {
          universe.push(shape);
        } else if (shape instanceof Wire) {
          universe.push(...shape.getEdges());
        }
      }
    }

    const fromFilters = this.injectFromMembershipSets(filters);
    try {
      this.addShapes(this.applyFilters(universe, filters));
    } finally {
      for (const { filter, set } of fromFilters) {
        filter.setMembershipSet(null);
        set.delete();
      }
    }
  }

  private injectFromMembershipSets(filters: FilterBuilderBase<Shape>[]): { filter: FromSceneObjectFilter<Shape>; set: TopTools_MapOfShape }[] {
    const allocated: { filter: FromSceneObjectFilter<Shape>; set: TopTools_MapOfShape }[] = [];
    for (const builder of filters) {
      for (const filter of builder.getFilters()) {
        if (filter instanceof FromSceneObjectFilter) {
          const shapeType = filter.getShapeType();
          const rawShapes: TopoDS_Shape[] = [];
          for (const obj of filter.getSceneObjects()) {
            for (const owner of obj.getShapes()) {
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
    }
    return allocated;
  }

  private collectFromSceneObjects(filters: FilterBuilderBase<Shape>[]): SceneObject[] {
    const objects: SceneObject[] = [];
    for (const builder of filters) {
      for (const filter of builder.getFilters()) {
        if (filter instanceof FromSceneObjectFilter) {
          for (const obj of filter.getSceneObjects()) {
            if (!objects.includes(obj)) {
              objects.push(obj);
            }
          }
        }
      }
    }
    return objects;
  }

  private getAllShapes(scope: SceneObject[], exludedShapes: Shape[]) {
    const scopeShapes = scope.flatMap(obj => obj.getShapes({}, 'solid').map(s => s.getSubShapes(this.type)).flat());
    const flatExcluded = exludedShapes.flatMap(s => s.getSubShapes(this.type));
    if (flatExcluded.length === 0) {
      return scopeShapes;
    }

    const excludedSet = TopologyIndex.buildShapeSet(flatExcluded.map(s => s.getShape()));
    try {
      return scopeShapes.filter(shape => !excludedSet.Contains(shape.getShape()));
    } finally {
      excludedSet.delete();
    }
  }

  override getDependencies(): SceneObject[] {
    const deps: SceneObject[] = [];
    if (this.constraintObject) {
      deps.push(this.constraintObject);
    }
    for (const obj of this.collectFromSceneObjects(this.filters)) {
      if (!deps.includes(obj)) {
        deps.push(obj);
      }
    }
    return deps;
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

  private injectScopeFaces(filters: FilterBuilderBase<Shape>[], sceneObjects: SceneObject[]): ShapeHasher | null {
    return injectBelongsToFaceScope(filters, () => {
      if (this.constraintObject) {
        const constraintShapes = this.constraintObject.getShapes();
        return {
          solids: constraintShapes.filter(s => s.isSolid()) as Solid[],
          // Faces directly in the constraint (not part of a solid) need the
          // legacy linear-scan path since they don't have a cached index.
          extraFaces: constraintShapes
            .filter(s => !s.isSolid())
            .flatMap(s => s.getSubShapes("face")) as Face[],
        };
      }
      return {
        solids: sceneObjects.flatMap(obj => obj.getShapes({}, 'solid')) as Solid[],
        extraFaces: [],
      };
    });
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


