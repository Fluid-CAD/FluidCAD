import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Sketch } from "./2d/sketch.js";
import { Axis } from "../math/axis.js";
import { Matrix4 } from "../math/matrix4.js";
import { Plane } from "../math/plane.js";
import { Point2D } from "../math/point.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { AxisFromEdge } from "./axis-from-edge.js";
import { AxisFromSketch } from "./axis-from-sketch.js";
import { LazyVertex } from "./lazy-vertex.js";
import { SolvedGeometryBase } from "./2d/solved/solved-base.js";
import { Copy2DInstance } from "./copy2d-instance-ref.js";
import { Mirror2DInstance } from "./mirror2d-instance-ref.js";
import { collectSourceEntities, sourceEntitiesPayload } from "./2d/solved/source-entities.js";
import {
  entityPointFromParams,
  reflectionAffine,
  registerDuplicateEntity,
  validateInstanceRole,
} from "./2d/solved/copy-entities.js";
import {
  solverEntitiesOf,
  solverEntityForShape,
  type DerivedEntityProducer,
  type SolverEntityRecord,
} from "./2d/solved/derived-entities.js";
import { X_AXIS_ENTITY, Y_AXIS_ENTITY } from "../sketch-solver/index.js";
import type { EntityKind, PointRole, SolverRef } from "../sketch-solver/index.js";

/** The mirror line as the solver sees it: a line entity (a sketched line,
 * a datum axis) or a constant line [sx, sy, ex, ey] in sketch coordinates
 * (a world axis). */
type MirrorAxisRef = SolverRef | [number, number, number, number];

/** Statement-time record of one registered image entity. */
type ImageRecord = { sourceEntityId: number; dupId: number; kind: EntityKind };

/** Everything instance() resolution needs, captured at registration. Null
 * when registration degraded (axis unknown at statement time). */
type ImageRegistration = {
  axis: MirrorAxisRef;
  /** The axis line's entity id when it is one — its own image is itself. */
  axisEntityId: number | null;
  /** Images keyed by SOURCE entity id, in registration order. */
  images: Map<number, ImageRecord>;
  /** The sibling statements the mirror stamps (targets minus exclusions). */
  candidates: Set<SceneObject>;
};

/**
 * In-sketch mirror: stamps a reflected duplicate of every source shape
 * across a line. The mirror owns only the duplicates — the sources keep
 * their own statements — and, when the mirror line is known at statement
 * time, every solver-backed source registers one IMAGE entity rigidly tied
 * to it (SketchSystem.addMirrorTie): `m.instance(l)` is then a first-class
 * constraint target, and constraining an image moves its source — and, for
 * a sketched mirror line, can move the line itself — through the tie.
 *
 * Images register at STATEMENT time — the mirror() factory calls
 * registerSolverImages right after addSceneObject, like the 2D copies — so
 * entity ids exist before any constraint can name `m.instance(l)`, and the
 * payload stays complete across SceneCompare-cached renders (which skip a
 * solved sketch's builds; anything registered from build() would vanish).
 */
export class MirrorShape2D extends GeometrySceneObject implements DerivedEntityProducer {
  private _images: ImageRegistration | null = null;
  private _imagesResolved = false;
  private _degradeReason: string | null = null;

  constructor(
    private axis: AxisObjectBase,
    private targetObjects: SceneObject[] = null) {
    super();
  }

  // -- solver image registration (statement time) ---------------------------

  /**
   * Register one image entity per solver-backed entity the mirror stamps,
   * tied to its source across the mirror line. Called by the mirror()
   * factory right after addSceneObject; idempotent. Degrades silently (no
   * images, instance() errors honestly) when the mirror line is not
   * statically known.
   */
  registerSolverImages(sk: Sketch | null): void {
    if (this._imagesResolved) {
      return;
    }
    this._imagesResolved = true;
    const ctx = sk?.solver() ?? null;
    if (!sk || !ctx) {
      this._degradeReason = 'the mirror is not inside a constraint sketch';
      return;
    }
    const axisRef = this.resolveAxisRef(sk);
    if (axisRef === null) {
      return;
    }
    const axisEntityId = Array.isArray(axisRef) ? null : axisRef.entity;
    const axisLine = Array.isArray(axisRef)
      ? axisRef
      : ctx.entityParams(axisRef.entity) as [number, number, number, number];
    let affine: ReturnType<typeof reflectionAffine>;
    try {
      affine = reflectionAffine(axisLine);
    } catch {
      this._degradeReason = 'the mirror line has no length';
      return;
    }

    const candidates = this.candidateSources(sk);
    const images = new Map<number, ImageRecord>();
    for (const obj of candidates) {
      const entities = solverEntitiesOf(obj);
      if (!entities) {
        continue;
      }
      for (const { entityId, kind } of entities) {
        // The mirror line reflects onto itself — no image to register.
        if (entityId === axisEntityId || images.has(entityId)) {
          continue;
        }
        const dupId = registerDuplicateEntity(ctx, this, { entityId, solverKind: kind }, affine);
        ctx.addMirrorTie(entityId, dupId, axisRef);
        images.set(entityId, { sourceEntityId: entityId, dupId, kind });
      }
    }
    this._images = { axis: axisRef, axisEntityId, images, candidates: new Set(candidates) };
  }

  /**
   * The mirror line for the solver, without build state. A sketched solved
   * line (`mirror(l)`, `mirror(axis(l))`) and the datum axes (`xAxis()`,
   * `yAxis()`) are line ENTITIES — the tie then follows the line through
   * the solve; anything else resolvable at statement time (a world axis)
   * becomes a constant line in sketch coordinates. Null degrades, with the
   * reason stashed for the instance() error.
   */
  private resolveAxisRef(sk: Sketch): MirrorAxisRef | null {
    let axis: AxisObjectBase = this.axis;
    while (axis instanceof AxisFromEdge && axis.source instanceof AxisObjectBase) {
      axis = axis.source;
    }
    if (axis instanceof AxisFromEdge) {
      const source = axis.source;
      if (source instanceof SolvedGeometryBase && source.entityId >= 0) {
        if (source.solverKind !== 'line') {
          this._degradeReason = `the mirror line is a ${source.getType()}, not a line`;
          return null;
        }
        if (axis.options) {
          this._degradeReason = 'the mirror axis carries a transform (offset/rotation)';
          return null;
        }
        return { entity: source.entityId };
      }
      this._degradeReason = 'the mirror line has no solver identity — mirror across a drawn line, xAxis()/yAxis(), or a world axis';
      return null;
    }
    if (axis instanceof AxisFromSketch && !axis.options
      && (axis.direction === 'x' || axis.direction === 'y')) {
      return { entity: axis.direction === 'x' ? X_AXIS_ENTITY : Y_AXIS_ENTITY };
    }
    // A constant axis (a world axis string, a raw Axis): express it in
    // sketch coordinates — both ends of a unit segment through the plane.
    let a: Axis | undefined;
    try {
      a = axis.resolveAxis();
    } catch {
      a = undefined;
    }
    if (!a) {
      this._degradeReason = 'the mirror axis is not known at statement time';
      return null;
    }
    let plane: Plane | null = null;
    try {
      plane = sk.getPlane();
    } catch {
      plane = null;
    }
    if (!plane) {
      this._degradeReason = 'the sketch plane is not known at statement time';
      return null;
    }
    const o = plane.worldToLocal(a.origin);
    const e = plane.worldToLocal(a.origin.add(a.direction));
    if (Math.hypot(e.x - o.x, e.y - o.y) < 1e-9) {
      this._degradeReason = 'the mirror axis is normal to the sketch plane';
      return null;
    }
    return [o.x, o.y, e.x, e.y];
  }

  /** Statement-time view of the build-time source walk: explicit targets
   * filtered to actual siblings, or every previous sibling — never
   * lazies/selections (they stamp nothing). Guides stay: the build mirrors
   * guide shapes too. */
  private candidateSources(sk: Sketch): SceneObject[] {
    const siblings = sk.getPreviousSiblings(this);
    const objects = this.targetObjects && this.targetObjects.length > 0
      ? siblings.filter(obj => this.targetObjects!.includes(obj))
      : siblings;
    return objects.filter(obj =>
      obj instanceof GeometrySceneObject && !obj.isLazy() && !obj.isSelection());
  }

  // -- derived-entity exposure (for ops downstream of this mirror) ----------

  solverDuplicates(): SolverEntityRecord[] {
    const images = this._images?.images;
    if (!images) {
      return [];
    }
    return [...images.values()].map(i => ({ entityId: i.dupId, kind: i.kind }));
  }

  duplicateEntityForShape(shape: Shape): number | null {
    const shapes = this.imageShapes;
    const images = this._images?.images;
    if (!shapes || !images) {
      return null;
    }
    for (const [sourceEntityId, stamped] of shapes) {
      if (stamped === shape) {
        return images.get(sourceEntityId)?.dupId ?? null;
      }
    }
    return null;
  }

  // -- build ----------------------------------------------------------------

  /** Source entity id → index of its stamped image in this mirror's
   * sceneShapes (the payload join). State: SceneCompare-cached renders
   * skip build() and serve the transferred map. */
  private get imageShapeIndex(): Map<number, number> | undefined {
    return this.getState('mirror-image-shape-index');
  }

  /** Source entity id → the stamped image shape itself (instance() reads). */
  private get imageShapes(): Map<number, Shape> | undefined {
    return this.getState('mirror-image-shapes');
  }

  build(context: BuildSceneObjectContext) {
    let targetObjects = this.targetObjects;
    let sketch: Sketch  = this.sketch;
    let axis: Axis;
    const objects = sketch.getPreviousSiblings(this);

    if (this.targetObjects && this.targetObjects.length > 0) {
      targetObjects = objects.filter(obj => this.targetObjects.includes(obj));
    }
    else {
      // The target-less walk takes every previous sibling — in a solved
      // sketch that includes constraint statements, which own no shapes and
      // only add noise to the transform loop.
      targetObjects = objects.filter(obj => obj.getShapes({ excludeMeta: false, excludeGuide: false }).length > 0);
    }

    // Duplicates follow their sources AND the mirror line — the viewport
    // tints them constrained only when all of those are.
    this.setState('source-entities', collectSourceEntities(targetObjects, { axes: [this.axis] }));

    this.axis.removeShapes(this)

    axis = this.axis.getAxis();

    const transformedShapes: Shape[] = [];
    const shapeIndexBySource = new Map<number, number>();
    const shapeBySource = new Map<number, Shape>();

    const plane = sketch.getPlane();
    const mirrorPlaneNormal = axis.direction.cross(plane.normal);
    const matrix = Matrix4.mirrorPlane(mirrorPlaneNormal, axis.origin);

    for (const obj of targetObjects) {
      const shapes = obj.getShapes({ excludeMeta: false, excludeGuide: false });
      for (const shape of shapes) {
        const transformed = ShapeOps.transform(shape, matrix);
        // Solver-backed source shapes join their image entity by the
        // stamped index — the same join the payload and instance() read.
        const sourceEntityId = solverEntityForShape(obj, shape);
        if (sourceEntityId !== null && !shapeIndexBySource.has(sourceEntityId)) {
          shapeIndexBySource.set(sourceEntityId, transformedShapes.length);
          shapeBySource.set(sourceEntityId, transformed);
        }
        transformedShapes.push(transformed);
      }
    }

    // Copies keep the source role (via ShapeOps.transform) but are derived.
    for (const shape of transformedShapes) {
      if (!shape.isMetaShape() && !shape.isGuideShape()) {
        shape.setProvenance('mirror-copy');
      }
    }

    this.addShapes(transformedShapes);
    this.setState('mirror-image-shape-index', shapeIndexBySource);
    this.setState('mirror-image-shapes', shapeBySource);
  }

  // -- instance() constraint resolution -------------------------------------

  /** The SOURCE solver entity an instance() argument names. */
  private sourceEntityOf(source: SceneObject, what: string): number {
    if (source instanceof SolvedGeometryBase) {
      if (source.entityId < 0) {
        throw new Error(`${what}: ${source.getType()}() has no solver identity — write it inside the sketch callback`);
      }
      return source.entityId;
    }
    if (source instanceof Copy2DInstance || source instanceof Mirror2DInstance) {
      return source.solverRef(what).entity;
    }
    if (source instanceof LazyVertex) {
      throw new Error(`${what}: instance() takes the mirrored statement, not one of its points — write m.instance(l).start()`);
    }
    throw new Error(
      `${what}: instance() expects a mirrored line/arc/circle/point statement, a copy instance (cp.instance(k)) or another mirror's instance`,
    );
  }

  /** The statement an instance() argument belongs to, for the not-mirrored
   * diagnosis. */
  private static statementOf(source: SceneObject): SceneObject | null {
    if (source instanceof SolvedGeometryBase) {
      return source;
    }
    if (source instanceof Copy2DInstance) {
      return source.copyOwner;
    }
    if (source instanceof Mirror2DInstance) {
      return source.mirrorOwner;
    }
    return null;
  }

  private resolveImage(source: SceneObject, what: string): { entityId: number; kind: EntityKind } {
    const registration = this._images;
    if (!registration) {
      throw new Error(
        `${what}: this mirror's images have no solver identity — ${this._degradeReason ?? 'the mirror line is not known at statement time'}; constrain the source statement instead`,
      );
    }
    const sourceEntityId = this.sourceEntityOf(source, what);
    if (sourceEntityId === registration.axisEntityId) {
      throw new Error(`${what}: the mirror line is its own image — constrain it directly`);
    }
    const record = registration.images.get(sourceEntityId);
    if (record) {
      return { entityId: record.dupId, kind: record.kind };
    }
    const statement = MirrorShape2D.statementOf(source);
    const name = statement ? `${statement.getType()}()` : 'that geometry';
    throw new Error(
      `${what}: ${name} is not mirrored by this statement — it comes after the mirror or is not among its targets`,
    );
  }

  /** Solver ref for `m.instance(source)` (optionally one of its points). */
  instanceSolverRef(source: SceneObject, what: string, role?: PointRole): SolverRef {
    const { entityId, kind } = this.resolveImage(source, what);
    if (role === undefined || kind === 'point') {
      return { entity: entityId };
    }
    validateInstanceRole(kind, role, what);
    return { entity: entityId, point: role };
  }

  /** Current value of one of an image's named points (guesses until the
   * solve has run) — the Mirror2DInstancePointRef vertex read. */
  instancePointValue(source: SceneObject, role: PointRole): Point2D {
    const what = `instance ${role}`;
    const { entityId, kind } = this.resolveImage(source, what);
    if (kind !== 'point') {
      validateInstanceRole(kind, role, what);
    }
    const ctx = this.sketch?.solver();
    if (!ctx) {
      throw new Error(`${what}: the mirror is not inside a constraint sketch`);
    }
    return entityPointFromParams(kind, ctx.entityParams(entityId), role);
  }

  // -- selection accessors --------------------------------------------------

  /** The still-live stamped image of `source`'s geometry (build order). */
  getInstanceShapes(source: SceneObject): Shape[] {
    const shapes = this.imageShapes;
    if (!shapes) {
      return [];
    }
    let sourceEntityId: number;
    try {
      sourceEntityId = this.sourceEntityOf(source, 'instance');
    } catch {
      return [];
    }
    const shape = shapes.get(sourceEntityId);
    if (!shape) {
      return [];
    }
    const live = new Set<Shape>(this.getShapes({ excludeGuide: false }));
    return live.has(shape) ? [shape] : [];
  }

  /**
   * The mirror image of one mirrored statement: a lazy whole-geometry
   * selection over its stamped shape, and — when the source is solver-backed
   * — a constraint target resolving to the image entity.
   */
  instance(source: SceneObject): Mirror2DInstance {
    return new Mirror2DInstance(this.generateUniqueName('instance'), this, source);
  }

  // -- payload --------------------------------------------------------------

  /** One record per stamped image with solver identity, joining the
   * statement-time entity to the build-time shape by source entity. */
  private imageEntitiesPayload(): Record<string, unknown> {
    const registration = this._images;
    const index = this.imageShapeIndex;
    if (!registration || registration.images.size === 0 || !index) {
      return {};
    }
    const entities: { entityId: number; kind: EntityKind; shapeIndex: number; sourceEntityId: number }[] = [];
    for (const image of registration.images.values()) {
      const shapeIndex = index.get(image.sourceEntityId);
      if (shapeIndex === undefined) {
        continue;
      }
      entities.push({
        entityId: image.dupId,
        kind: image.kind,
        shapeIndex,
        sourceEntityId: image.sourceEntityId,
      });
    }
    return entities.length > 0 ? { entities } : {};
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const axis = (remap.get(this.axis) as AxisObjectBase) || this.axis;
    const targetObjects = this.targetObjects
      ? this.targetObjects.map(obj => remap.get(obj) || obj)
      : null;
    return new MirrorShape2D(axis, targetObjects);
  }

  compareTo(other: MirrorShape2D): boolean {
    if (!(other instanceof MirrorShape2D)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!this.axis.compareTo(other.axis)) {
      return false;
    }

    const thisTargetObjects = this.targetObjects || [];
    const otherTargetObjects = other.targetObjects || [];

    if (thisTargetObjects.length !== otherTargetObjects.length) {
      return false;
    }

    for (let i = 0; i < thisTargetObjects.length; i++) {
      if (!thisTargetObjects[i].compareTo(otherTargetObjects[i])) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return "mirror";
  }

  getUniqueType(): string {
    return 'mirror-shape-2d'
  }

  serialize() {
    return {
      axis: this.axis.serialize(),
      ...sourceEntitiesPayload(this.getState('source-entities')),
      ...this.imageEntitiesPayload(),
    }
  }
}
