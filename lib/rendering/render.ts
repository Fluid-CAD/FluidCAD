import { RenderedShape, Scene, SceneObjectMesh, SceneObjectRender } from "./scene.js";
import { MeshBuilder } from "./mesh-builder.js";
import { SceneObject } from "../common/scene-object.js";
import { callSiteKey } from "../common/call-site.js";
import { Shape } from "../common/shape.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { Sketch } from "../features/2d/sketch.js";
import { GeometrySceneObject } from "../features/2d/geometry.js";
import { Exposed } from "../features/exposed.js";
import type { Part } from "../features/part.js";
import { scaleForeignPart } from "../features/part-scale.js";
import { transformMeshes } from "./mesh-transform.js";
import { attachSketchSnapVertices } from "./sketch-snap.js";
import { attachConnectorHosts } from "./connector-host.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { Mesh, bboxDiagonal, bucketDiagonal, meshSizeBucket, resolveMeshConfig } from "../oc/mesh.js";
import type { MeshQuality, MeshSettings } from "../oc/mesh.js";
import { Profiler } from "../common/profiler.js";
import { describeError } from "../common/describe-error.js";
import { withUnit } from "../units/registry.js";
import type { LengthUnit } from "../units/units.js";

type RenderEmit = {
  sceneShapes: RenderedShape[];
  visible: boolean;
  hasError: boolean;
  errorMessage?: string;
  buildDurationMs?: number;
  profiler?: Profiler;
  scope?: Set<SceneObject>;
};

// 0-based execution index per object for call sites that ran more than once
// in this render (a user loop/helper). Objects from single-execution call
// sites are absent — their payload sourceLocation stays untouched. Derived
// from scene order alone; nothing is stamped back onto the objects.
function computeCallSiteOccurrences(sceneObjects: SceneObject[]): Map<SceneObject, number> {
  const counts = new Map<string, number>();
  for (const obj of sceneObjects) {
    const key = callSiteKey(obj);
    if (key) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const seen = new Map<string, number>();
  const occurrences = new Map<SceneObject, number>();
  for (const obj of sceneObjects) {
    const key = callSiteKey(obj);
    if (!key) {
      continue;
    }
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    if ((counts.get(key) ?? 0) > 1) {
      occurrences.set(obj, index);
    }
  }
  return occurrences;
}

/**
 * The parts in this render whose definition unit differs from the unit they
 * are consumed in, keyed by the scene index of their LAST member — where the
 * renderer rescales them. Members are found by enclosing part, not by
 * position: a donor definition materialized mid-body interleaves with the
 * consumer's children in the flat list.
 */
function collectForeignParts(
  scene: Scene,
  sceneObjects: SceneObject[],
): Map<number, { part: Part; members: SceneObject[] }[]> {
  const lastIndex = new Map<Part, number>();
  const members = new Map<Part, SceneObject[]>();
  for (let i = 0; i < sceneObjects.length; i++) {
    const part = scene.findEnclosingPart(sceneObjects[i]);
    if (!part || !part.isForeignUnit()) {
      continue;
    }
    lastIndex.set(part, i);
    let list = members.get(part);
    if (!list) {
      list = [];
      members.set(part, list);
    }
    list.push(sceneObjects[i]);
  }

  const byIndex = new Map<number, { part: Part; members: SceneObject[] }[]>();
  for (const [part, index] of lastIndex) {
    let due = byIndex.get(index);
    if (!due) {
      due = [];
      byIndex.set(index, due);
    }
    due.push({ part, members: members.get(part)! });
  }
  return byIndex;
}

export class SceneRenderer {
  private readonly meshQuality: MeshQuality;
  private readonly meshBuilder: MeshBuilder;
  /** Recomputed at the top of every render pass — see computeCallSiteOccurrences. */
  private occurrenceIndexes: Map<SceneObject, number> = new Map();

  constructor(settings: MeshSettings) {
    this.meshBuilder = new MeshBuilder(settings);
    this.meshQuality = this.meshBuilder.quality;
  }

  render(scene: Scene): Scene {
    const sceneObjects = scene.getAllSceneObjects();
    console.log("============ Rendering ==============", sceneObjects.length);
    this.occurrenceIndexes = computeCallSiteOccurrences(sceneObjects);

    const skippedContainers = new Set<SceneObject>();
    const buildDurations = new Map<SceneObject, number>();
    const profilers = new Map<SceneObject, Profiler>();
    const foreignParts = collectForeignParts(scene, sceneObjects);

    for (let i = 0; i < sceneObjects.length; i++) {
      const object = sceneObjects[i];
      // Skip descendants of cloned sketches — their edges are already
      // computed by the parent sketch's clone-mode build.
      const parent = object.getParent();
      if (parent && skippedContainers.has(parent)) {
        skippedContainers.add(object);
      } else {
        console.log("Rendering object:", object.getUniqueType());

        if (!scene.isCached(object)) {
          const result = this.buildObject(object, scene);
          buildDurations.set(object, result.totalMs);
          profilers.set(object, result.profiler);
        }

        // After building, mark cloned sketches so their children are skipped —
        // the sketch's build() already populated them with transformed shapes.
        if (object instanceof Sketch && object.getCloneSource()) {
          skippedContainers.add(object);
        }
      }

      // A foreign-unit part is rescaled the moment its last member has
      // built: its members had to build in the definition unit, and the
      // first consumer outside the part (which comes later in scene order)
      // must read it in the scene's. Cached members already carry scaled
      // state from the previous render (the compares keep such parts
      // atomic, so it is all or nothing).
      const due = foreignParts.get(i);
      if (due) {
        for (const { part, members } of due) {
          const built = members.filter(m => !scene.isCached(m));
          if (built.length > 0) {
            scaleForeignPart(part, built, scene);
          }
        }
      }
    }

    for (const object of sceneObjects) {
      if (skippedContainers.has(object)) {
        continue;
      }
      object.clean(scene.getPartScopedAllObjects(object));
    }

    this.batchTriangulate(sceneObjects, skippedContainers);

    // The render scope: every object in the scene. Passing it makes the
    // shape collection honor render-only (soft) removals — an exposure's
    // published selection stays out of the picture — while feature reads,
    // which call getShapes() scope-less, keep seeing those shapes.
    const renderScope = new Set<SceneObject>(sceneObjects);

    const prepared = new Map<SceneObject, { renderedSceneShapes: RenderedShape[]; ownShapeCount: number; prepError?: string }>();
    for (const object of sceneObjects) {
      const profiler = profilers.get(object);
      const start = performance.now();
      prepared.set(object, this.prepareRenderedShapes(object, profiler, renderScope));
      const meshMs = performance.now() - start;
      const existing = buildDurations.get(object);
      if (existing !== undefined) {
        buildDurations.set(object, existing + meshMs);
      }
    }

    this.aggregateContainerDurations(sceneObjects, scene, buildDurations);

    for (const object of sceneObjects) {
      this.emitRenderObject(
        object,
        scene,
        prepared.get(object) ?? { renderedSceneShapes: [], ownShapeCount: 0 },
        buildDurations.get(object),
        profilers.get(object),
      );
    }

    attachSketchSnapVertices(scene);
    attachConnectorHosts(scene, renderScope);

    return scene;
  }

  /**
   * Re-emit the scene restricted to `scope` — the view-only rollback pass
   * (nothing rebuilds; consumed shapes whose consumer is out of scope
   * reappear via the membership rule in getOwnShapes). Without an explicit
   * scope the classic prefix `[0..rollbackIndex]` is used; callers that
   * want a non-prefix view (part-scoped rollback) pass their own set.
   */
  renderRollback(scene: Scene, rollbackIndex: number, scope?: Set<SceneObject>): Scene {
    console.log("============ Rollback Rendering ==============", rollbackIndex);

    const allObjects = scene.getAllSceneObjects();
    this.occurrenceIndexes = computeCallSiteOccurrences(allObjects);
    if (!scope) {
      scope = new Set<SceneObject>();
      for (let i = 0; i <= rollbackIndex && i < allObjects.length; i++) {
        scope.add(allObjects[i]);
      }
    }

    scene.clearRenderedObjects();

    for (const obj of allObjects) {
      if (!scope.has(obj) || obj.isLazy()) {
        this.emitRendered(obj, scene, {
          sceneShapes: [],
          visible: false,
          hasError: false,
          scope,
        });
        continue;
      }

      const sceneShapes = obj.getOwnShapes({ excludeMeta: false, excludeGuide: false }, scope);
      const renderedSceneShapes = sceneShapes.map(s => this.toRenderedShape(s, obj.getUnit()));

      // A rollback re-emits already-built objects rather than rebuilding them,
      // but an object that failed to build still carries its error — dropping
      // it here would report a clean scene for a broken feature that happens
      // to sit inside the rollback scope.
      const errorMessage = obj.getError();
      this.emitRendered(obj, scene, {
        sceneShapes: renderedSceneShapes,
        visible: this.computeVisibility(obj, scene, sceneShapes.length, scope),
        hasError: !!errorMessage,
        errorMessage: errorMessage || undefined,
        scope,
      });
    }

    attachConnectorHosts(scene, scope);

    const result = scene.getRenderedObjects();
    console.table(result);

    return scene;
  }

  // Mesh every shape that still needs triangulation in one
  // BRepMesh_IncrementalMesh call per size bucket. OC's parallel mode then
  // balances faces across all shapes of a bucket at once instead of running
  // per-shape sequentially. The triangulation lives on each TFace, so the
  // per-shape extraction in prepareRenderedShapes finds it cached and
  // short-circuits its own ensureTriangulated call — which asks for the same
  // bucket-resolved deflection (resolveRenderMeshConfig), so the cache check
  // agrees.
  //
  // Buckets are keyed on the owning object's unit as well as its size: until
  // Phase 5 scales foreign parts, objects in one scene may run in different
  // units, and a deflection is only meaningful in the unit it was resolved in.
  private batchTriangulate(
    sceneObjects: SceneObject[],
    skippedContainers: Set<SceneObject>,
  ): void {
    const buckets = new Map<string, { unit: LengthUnit; bucket: number; targets: Set<Shape> }>();
    let total = 0;

    for (const object of sceneObjects) {
      if (skippedContainers.has(object) || object.isLazy()) {
        continue;
      }
      const unit = object.getUnit();
      const shapes = object.getOwnShapes({ excludeMeta: false, excludeGuide: false });
      for (const shape of shapes) {
        if (shape.getMeshes()) {
          continue;
        }
        const source = shape.getMeshSource();
        const target = source ? source.shape : shape;
        if (target.getMeshes()) {
          continue;
        }
        const bucket = meshSizeBucket(bboxDiagonal(target.getShape()));
        const key = `${unit}:${bucket}`;
        let entry = buckets.get(key);
        if (!entry) {
          entry = { unit, bucket, targets: new Set<Shape>() };
          buckets.set(key, entry);
        }
        if (!entry.targets.has(target)) {
          entry.targets.add(target);
          total++;
        }
      }
    }

    if (total <= 1) {
      return;
    }

    const t0 = performance.now();
    for (const { unit, bucket, targets } of buckets.values()) {
      const compound = ShapeOps.makeCompoundRaw([...targets].map(s => s.getShape()));
      try {
        Mesh.ensureTriangulated(compound, resolveMeshConfig(bucketDiagonal(bucket), this.meshQuality, unit));
      } finally {
        compound.delete();
      }
    }
    console.log(`Batched mesh: ${total} shapes in ${buckets.size} bucket(s) in ${(performance.now() - t0).toFixed(1)}ms`);
  }

  private prepareRenderedShapes(
    obj: SceneObject,
    profiler: Profiler | undefined,
    renderScope: Set<SceneObject>,
  ): { renderedSceneShapes: RenderedShape[]; ownShapeCount: number; prepError?: string } {
    const renderedSceneShapes: RenderedShape[] = [];
    if (obj.isLazy()) {
      return { renderedSceneShapes, ownShapeCount: 0 };
    }
    try {
      const sceneShapes = obj.getOwnShapes({ excludeMeta: false, excludeGuide: false }, renderScope);
      if (sceneShapes.length) {
        console.log(` - Scene shapes: ${sceneShapes.length}`);
        for (const shape of sceneShapes) {
          renderedSceneShapes.push(this.toRenderedShape(shape, obj.getUnit(), profiler));
        }
      }
      return { renderedSceneShapes, ownShapeCount: sceneShapes.length };
    } catch (error) {
      const message = describeError(error);
      console.error(`Error rendering object ${obj.getUniqueType()}:`, message);
      return { renderedSceneShapes, ownShapeCount: renderedSceneShapes.length, prepError: message };
    }
  }

  private emitRenderObject(
    obj: SceneObject,
    scene: Scene,
    prepared: { renderedSceneShapes: RenderedShape[]; ownShapeCount: number; prepError?: string },
    buildDurationMs: number | undefined,
    profiler: Profiler | undefined,
  ): void {
    if (prepared.prepError) {
      this.emitRendered(obj, scene, {
        sceneShapes: prepared.renderedSceneShapes,
        visible: false,
        hasError: true,
        errorMessage: prepared.prepError,
        buildDurationMs,
        profiler,
      });
      return;
    }

    const errorMessage = obj.getError();
    this.emitRendered(obj, scene, {
      sceneShapes: prepared.renderedSceneShapes,
      visible: this.computeVisibility(obj, scene, prepared.ownShapeCount),
      hasError: !!errorMessage,
      errorMessage: errorMessage || undefined,
      buildDurationMs,
      profiler,
    });
  }

  private buildObject(object: SceneObject, scene: Scene): { totalMs: number; profiler: Profiler } {
    object.clearError();
    const start = performance.now();
    const profiler = new Profiler();

    try {
      object.validate();
      // A deferred build runs outside its statement's call stack: re-enter
      // the unit the statement was authored in (a foreign part's features).
      withUnit(object.getUnit(), () => object.build({
        getSceneObjects: () => scene.getPartScopedObjectsUpTo(object),
        getActiveSceneObjects: () => scene.getPartScopedActiveObjectsUpTo(object),
        getSceneObjectsFromTo: (from: SceneObject, to: SceneObject) => scene.getSceneObjectsFromTo(from, to),
        getTransform: () => object.getTransform(),
        getLastObject: () => {
          const objects = scene.getSceneObjectsUpTo(object);
          for (let i = objects.length - 1; i >= 0; i--) {
            const obj = objects[i];
            if (!(obj instanceof PlaneObjectBase) && !(obj instanceof AxisObjectBase)) {
              return obj;
            }
          }
          return null;
        },
        getProfiler: () => profiler,
      }));

      const appliedTransform = object.getAppliedTransform();
      if (appliedTransform && !object.isContainer()) {
        const shapes = object.getAddedShapes();
        for (let i = 0; i < shapes.length; i++) {
          shapes[i] = ShapeOps.transform(shapes[i], appliedTransform);
        }
      }
    } catch (error) {
      const message = describeError(error);
      console.error(`Error building object ${object.getUniqueType()}:`, message);
      object.setError(message);
    }

    const totalMs = performance.now() - start;
    return { totalMs, profiler };
  }

  // Meshing runs outside the object's build scope, so the owning object's
  // unit travels explicitly: the deflection is resolved in that unit.
  private getOrBuildMeshes(shape: Shape, unit: LengthUnit, profiler?: Profiler): SceneObjectMesh[] | null {
    const existing = shape.getMeshes();
    if (existing) {
      return existing;
    }

    profiler?.start("Triangulation");
    try {
      let meshes: SceneObjectMesh[] | null;
      const meshSource = shape.getMeshSource();
      if (meshSource) {
        let sourceMeshes = meshSource.shape.getMeshes();
        if (!sourceMeshes) {
          sourceMeshes = this.meshBuilder.build(meshSource.shape, unit);
          meshSource.shape.setMeshes(sourceMeshes);
        }
        meshes = sourceMeshes ? transformMeshes(sourceMeshes, meshSource.matrix) : this.meshBuilder.build(shape, unit);
      } else {
        meshes = this.meshBuilder.build(shape, unit);
      }

      shape.setMeshes(meshes);
      return meshes;
    } finally {
      profiler?.end("Triangulation");
    }
  }

  private toRenderedShape(shape: Shape, unit: LengthUnit, profiler?: Profiler): RenderedShape {
    return {
      shapeId: shape.id,
      meshes: this.getOrBuildMeshes(shape, unit, profiler),
      shapeType: shape.getType(),
      isMetaShape: shape.isMetaShape() || undefined,
      isGuide: shape.isGuideShape() || undefined,
      metaType: shape.metaType || undefined,
      metaData: shape.metaData || undefined,
      role: shape.role,
      roleIndex: shape.roleIndex,
      provenance: shape.provenance,
    };
  }

  private computeVisibility(
    obj: SceneObject,
    scene: Scene,
    ownShapeCount: number,
    scope?: Set<SceneObject>,
  ): boolean {
    if (obj.isAlwaysVisible()) {
      return true;
    }
    if (obj.isContainer()) {
      const children = scene.getChildren(obj);
      return children.some(child => {
        if (scope && !scope.has(child)) {
          return false;
        }
        const shapes = scope
          ? child.getOwnShapes({ excludeMeta: true }, scope)
          : child.getOwnShapes();
        return shapes.length > 0;
      });
    }
    return ownShapeCount > 0;
  }

  private aggregateContainerDurations(
    sceneObjects: SceneObject[],
    scene: Scene,
    durations: Map<SceneObject, number>,
  ): void {
    for (let i = sceneObjects.length - 1; i >= 0; i--) {
      const object = sceneObjects[i];
      if (!object.isContainer()) {
        continue;
      }
      const own = durations.get(object);
      if (own === undefined) {
        continue;
      }
      let total = own;
      for (const child of scene.getChildren(object)) {
        const childDuration = durations.get(child);
        if (childDuration !== undefined) {
          total += childDuration;
        }
      }
      durations.set(object, total);
    }
  }

  /**
   * An exposure's published shapes (its source selection, hidden from the
   * display by the expose itself) — read scope-less, the way every consumer
   * of the exposure reads them. Only for rows the render actually reached:
   * a rolled-back or errored exposure has nothing to show.
   */
  private referencedShapes(obj: SceneObject, opts: RenderEmit): RenderedShape[] | undefined {
    if (!(obj instanceof Exposed) || opts.hasError || (opts.scope && !opts.scope.has(obj))) {
      return undefined;
    }
    try {
      return obj.source.getShapes().map(s => this.toRenderedShape(s, obj.source.getUnit()));
    } catch {
      return undefined;
    }
  }

  private emitRendered(obj: SceneObject, scene: Scene, opts: RenderEmit): void {
    const categories = opts.profiler?.getCategories();
    const profileCategories = categories && categories.length > 0 ? categories : undefined;

    const displayName = obj.hasCustomName()
      ? obj.getName()
      : obj.getDisplayType();

    // Serialization can dereference state that a failed build never produced —
    // e.g. a sketch whose plane could not be built reads plane.localToWorld.
    // Contain that to this object (mark it errored) instead of letting one bad
    // object abort the whole scene render.
    let serialized: any;
    let hasError = opts.hasError;
    let errorMessage = opts.errorMessage;
    try {
      serialized = obj.serialize(opts.scope);
    } catch (error) {
      const message = describeError(error);
      obj.setError(message);
      hasError = true;
      errorMessage = errorMessage || message;
      serialized = {};
    }

    // A copy, never a mutation of the stamped location — occurrence is a
    // render-derived index, not part of the object's identity.
    const location = obj.getSourceLocation();
    const occurrence = this.occurrenceIndexes.get(obj);
    const sourceLocation = location && occurrence !== undefined
      ? { ...location, occurrence }
      : location || undefined;

    const rendered: SceneObjectRender = {
      id: obj.id,
      name: displayName,
      hasCustomName: obj.hasCustomName() || undefined,
      parentId: obj.parentId,
      object: serialized,
      sceneShapes: opts.sceneShapes,
      referencedShapes: this.referencedShapes(obj, opts),
      type: obj.getType(),
      uniqueType: obj.getUniqueType(),
      interactivity: obj instanceof GeometrySceneObject && obj.getParent() instanceof Sketch
        ? obj.getSketchInteractivity()
        : undefined,
      unit: obj.getUnit(),
      fromCache: scene.isCached(obj),
      visible: opts.visible,
      reusable: obj.isReusable() || undefined,
      internal: obj.isInternal() || undefined,
      isContainer: obj.isContainer(),
      hideChildren: obj.hidesChildren() || undefined,
      hasError,
      errorMessage,
      sourceLocation,
      buildDurationMs: opts.buildDurationMs,
      profileCategories,
    };

    scene.addRenderedObject(obj, rendered);
  }
}
