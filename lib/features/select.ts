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
import { FromSceneObjectFilter } from "../filters/from-object.js";
import { injectFilterScope } from "../filters/scope-injection.js";
import { TopologyIndex } from "../oc/topology-index.js";
import { ShapeHasher } from "../oc/shape-hash.js";
import { Edge } from "../common/edge.js";
import { Wire } from "../common/wire.js";
import { Sketch } from "./2d/sketch.js";
import { AnchorableSelection } from "./anchored-vertex.js";

export class SelectSceneObject extends AnchorableSelection implements ISelect {

  private type: ShapeType;
  private shapes: Shape[] = [];
  private _claimed: boolean = false;

  constructor(private filters: FilterBuilderBase<Shape>[]) {
    super();
    this.type = SelectSceneObject.shapeTypeOf(filters);
  }

  /** Face selection when every builder is a face filter, else edge. */
  static shapeTypeOf(filters: FilterBuilderBase<Shape>[]): ShapeType {
    if (filters.every(f => f instanceof FaceFilterBuilder)) {
      return "face";
    }
    return "edge";
  }

  override isSelection(): boolean {
    return true;
  }

  /**
   * Parse-time record that a feature call took this selection as an explicit
   * operand — `fillet(2, select(...))`, `connector('c1', select(...).center())`,
   * `plane(select(...))`. Its shapes belong to that feature once it builds, so
   * a later bare `color()` / `fillet(2)` must not fall back to it as the
   * implicit "last selection": that only fails at build time with a
   * consumed-geometry error naming the feature. Reusable selections keep
   * their shapes through consumption and stay eligible.
   */
  markClaimed(): void {
    this._claimed = true;
  }

  isClaimed(): boolean {
    return this._claimed && !this.isReusable();
  }

  /**
   * Claims every selection a builder call received as an operand — passed
   * bare, or wrapped in a lazy accessor such as `select(...).center()` whose
   * dependencies lead back to the selection.
   */
  static claimOperands(args: ArrayLike<unknown>): void {
    const visit = (value: unknown, depth: number) => {
      if (!(value instanceof SceneObject) || depth > 2) {
        return;
      }
      if (value instanceof SelectSceneObject) {
        value.markClaimed();
        return;
      }
      for (const dep of value.getDependencies()) {
        visit(dep, depth + 1);
      }
    };
    for (const arg of Array.from(args)) {
      visit(arg, 0);
    }
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

      if (parent) {
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

    let filteredShapes = SelectSceneObject.evaluateFilters(filters, sceneObjects, excludedObjects);
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
  }

  /**
   * The candidate set and match a `select(filters)` statement resolves over
   * `sceneObjects` (the objects its part scope exposes to it), as one shared
   * step: objects named by `.from(...)` join the universe so cross-part
   * selection works, edge filters get their belongsTo-face scope injected,
   * `.from` filters get their membership sets, and the filters run over
   * every solid's faces or edges minus `excludedShapes`. Shared with the
   * scene-level evaluator (`SelectionResolver`) so a tool that evaluates a
   * filter expression sees exactly what the statement would.
   */
  /**
   * `removalScope` bounds which removals count when reading the candidates'
   * solids (see SceneObject.getOwnShapes): a statement-boundary evaluation
   * passes the objects before the boundary, so a solid a later feature
   * consumed is still a candidate there. Absent, hard removals apply as for
   * any feature build.
   */
  static evaluateFilters(
    filters: FilterBuilderBase<Shape>[],
    sceneObjects: SceneObject[],
    excludedShapes: Shape[] = [],
    removalScope?: Set<SceneObject>,
  ): Shape[] {
    const type = SelectSceneObject.shapeTypeOf(filters);

    // Objects passed explicitly via `from(...)` bypass the part scope so that
    // cross-part selection works (e.g. select(face().from(p1)) from inside p2).
    const fromObjects = SelectSceneObject.collectFromSceneObjects(filters);
    if (fromObjects.length > 0) {
      sceneObjects = sceneObjects.slice();
      for (const obj of fromObjects) {
        if (!sceneObjects.includes(obj)) {
          sceneObjects.push(obj);
        }
      }
    }

    const allShapes = SelectSceneObject.getAllShapes(type, sceneObjects, excludedShapes, removalScope);
    let scopeHasher: ShapeHasher | null = null;
    if (type === "edge") {
      scopeHasher = SelectSceneObject.injectScopeFaces(filters, sceneObjects, removalScope);
    }
    const fromFilters = SelectSceneObject.injectFromMembershipSets(filters);
    try {
      return SelectSceneObject.applyFilters(allShapes, filters);
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

    const fromFilters = SelectSceneObject.injectFromMembershipSets(filters);
    try {
      this.addShapes(SelectSceneObject.applyFilters(universe, filters));
    } finally {
      for (const { filter, set } of fromFilters) {
        filter.setMembershipSet(null);
        set.delete();
      }
    }
  }

  private static injectFromMembershipSets(filters: FilterBuilderBase<Shape>[]): { filter: FromSceneObjectFilter<Shape>; set: TopTools_MapOfShape }[] {
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

  static collectFromSceneObjects(filters: FilterBuilderBase<Shape>[]): SceneObject[] {
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

  private static getAllShapes(type: ShapeType, scope: SceneObject[], exludedShapes: Shape[], removalScope?: Set<SceneObject>) {
    const scopeShapes = scope.flatMap(obj => obj.getShapes({}, 'solid', removalScope).map(s => s.getSubShapes(type)).flat());
    const flatExcluded = exludedShapes.flatMap(s => s.getSubShapes(type));
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
    for (const obj of SelectSceneObject.collectFromSceneObjects(this.filters)) {
      if (!deps.includes(obj)) {
        deps.push(obj);
      }
    }
    // Lazily-resolved filter references (plane-ref selections) are
    // dependencies too, but never join the selection universe.
    for (const builder of this.filters) {
      for (const filter of builder.getFilters()) {
        for (const obj of filter.getSceneObjectRefs()) {
          if (!deps.includes(obj)) {
            deps.push(obj);
          }
        }
      }
    }
    return deps;
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const remappedFilters = this.filters.map(f => f.remap(remap));
    return new SelectSceneObject(remappedFilters);
  }

  getFilters(): FilterBuilderBase<Shape>[] {
    return this.filters;
  }

  transform(matrix: Matrix4): SelectSceneObject {
    const mirroredFilters = this.filters.map(f => f.transform(matrix));
    return new SelectSceneObject(mirroredFilters);
  }

  private static injectScopeFaces(
    filters: FilterBuilderBase<Shape>[],
    sceneObjects: SceneObject[],
    removalScope?: Set<SceneObject>,
  ): ShapeHasher | null {
    return injectFilterScope(filters, () => ({
      solids: sceneObjects.flatMap(obj => obj.getShapes({}, 'solid', removalScope)) as Solid[],
      extraFaces: [],
    }));
  }

  static applyFilters(shapes: Shape[], filters: FilterBuilderBase<Shape>[]): Shape[] {
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

  serialize() {
    return {
      selectionLength: this.shapes.length,
      type: this.type
    }
  }
}


