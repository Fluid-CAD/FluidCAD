import { Scene } from "../rendering/scene.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Part } from "../features/part.js";
import { SelectSceneObject } from "../features/select.js";
import { FilterBuilderBase } from "../filters/filter-builder-base.js";
import { face, edge } from "../filters/index.js";
import { classifyEdge, classifyFace } from "../oc/measure/classify.js";
import { EntitySummaryBuilder } from "../oc/measure/entity-summary.js";
import type { EntitySummary } from "../oc/measure/entity-summary.js";
import type { MeasureEntityKind, MeasurePose } from "../oc/measure/measure-types.js";
import { Convert } from "../oc/convert.js";
import { getOC } from "../oc/init.js";
import type { LengthUnit } from "../units/units.js";

/** Where a filter expression is evaluated — see {@link SelectionResolver}. */
export type SelectionScopeInput =
  | { sceneObjectId: string }
  | { part: string }
  | { instanceId: string };

export type ResolvedSelectionScope =
  | { kind: 'root' }
  | { kind: 'part'; partId: string; part: string }
  | { kind: 'sceneObject'; sceneObjectId: string; partId: string | null; part: string | null }
  | { kind: 'instance'; instanceId: string; partId: string; part: string };

/** One matched face or edge, addressed the way `measure` and `hit_test` address entities. */
export type ResolvedSelectionMatch = {
  shapeId: string;
  kind: MeasureEntityKind;
  index: number;
  /** Assembly instance scope only — the entity feeds `measure` unchanged. */
  instanceId?: string;
  /** The instance's statement pose, for the same reason. */
  pose?: MeasurePose;
  sceneObjectId: string;
  sceneObjectName: string;
  /** The owning part's name (null at root outside any part); the scope carries the part id. */
  part: string | null;
  summary: EntitySummary;
};

export type ResolveSelectionRequest = {
  expression: string;
  scope?: SelectionScopeInput;
};

export type ResolveSelectionErrorCode = 'unknown-scope' | 'ambiguous-scope' | 'evaluation-error' | 'not-a-selection';

export type ResolveSelectionResult =
  | { ok: true; matches: ResolvedSelectionMatch[]; count: number; scope: ResolvedSelectionScope; unit: LengthUnit; warning?: string }
  | { ok: false; code: ResolveSelectionErrorCode; reason: string; candidates?: string[] };

type ScopeResolution =
  | { ok: true; scope: ResolvedSelectionScope; candidates: SceneObject[]; instance?: { instanceId: string; pose: MeasurePose } }
  | { ok: false; code: 'unknown-scope' | 'ambiguous-scope'; reason: string; candidates?: string[] };

type EvaluatedExpression =
  | { kind: 'filters'; filters: FilterBuilderBase<Shape>[] }
  | { kind: 'selection'; object: SceneObject };

type EntityOwner = { object: SceneObject; solid: Shape; index: number };

/**
 * Evaluates a FluidCAD filter expression (`face().onPlane("xy", 10)`,
 * `edge().circle(5)`, `face().from($obj["extrude-3"])`) against a finished
 * scene, in a closed scope: only `face`, `edge` and `$obj` (scene objects by
 * id) are bound. The expression may also yield a selection object — a lazy
 * accessor such as `$obj["extrude-3"].endFaces()` or an existing `select()`
 * statement — whose resolved shapes are the matches.
 *
 * A `new Function` with an explicit parameter list is the repo's pattern for
 * running model source outside a module (see the lib tests). The parameter
 * list also shadows the host globals a stray expression could reach, so the
 * closed scope is a scope rule rather than a sandbox — the agent already
 * writes arbitrary source through write_file.
 */
export class SelectionExpression {

  private static readonly SHADOWED_GLOBALS = [
    'globalThis', 'global', 'window', 'self', 'process', 'require', 'module', 'exports', 'Function', 'fetch', 'Buffer',
  ];

  static evaluate(expression: string, objectsById: Record<string, SceneObject>): EvaluatedExpression {
    const body = `"use strict";\nreturn (\n${expression}\n);`;
    const fn = new Function('face', 'edge', '$obj', ...SelectionExpression.SHADOWED_GLOBALS, body);
    const value = fn(face, edge, objectsById, ...SelectionExpression.SHADOWED_GLOBALS.map(() => undefined));
    return SelectionExpression.classify(value);
  }

  private static classify(value: unknown): EvaluatedExpression {
    if (value instanceof FilterBuilderBase) {
      return { kind: 'filters', filters: [value] };
    }
    if (Array.isArray(value) && value.length > 0 && value.every(v => v instanceof FilterBuilderBase)) {
      return { kind: 'filters', filters: value as FilterBuilderBase<Shape>[] };
    }
    if (value instanceof SceneObject) {
      if (value.isSelection() || value.isLazy()) {
        return { kind: 'selection', object: value };
      }
      throw new Error(
        `The expression yields a ${value.getType()} object, not a selection. `
        + `Select its geometry with face().from($obj["${value.id}"]) / edge().from($obj["${value.id}"]), `
        + `or an accessor such as $obj["${value.id}"].endFaces() where the object has one.`,
      );
    }
    const described = value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value;
    throw new Error(
      `The expression must yield a face()/edge() filter (or an array of them) or a selection; it yielded ${described}.`,
    );
  }
}

/**
 * Resolves filter expressions against the scene with exactly the candidate
 * set a `select(...)` statement sees at the requested scope:
 *
 * - scope = scene object or part → the objects of that object's enclosing
 *   part (`Scene.getPartScopedAllObjects`), so a filter scoped to
 *   `part("base")` never matches faces of `part("pillar")`;
 * - no scope → the whole scene, as a root-level `select()` sees it, each
 *   match naming the part that owns it;
 * - scope = assembly instance → that instance's part template, matches
 *   carrying the instance id and its statement pose; their summaries are
 *   posed the way `measure` poses instance entities.
 *
 * `.from(obj)` inside the expression bypasses the scope, as in source, because
 * the candidate assembly is `SelectSceneObject.evaluateFilters` itself.
 */
export class SelectionResolver {

  static resolve(scene: Scene, request: ResolveSelectionRequest): ResolveSelectionResult {
    const scope = SelectionResolver.resolveScope(scene, request.scope);
    if (scope.ok === false) {
      return { ok: false, code: scope.code, reason: scope.reason, ...(scope.candidates ? { candidates: scope.candidates } : {}) };
    }

    let evaluated: EvaluatedExpression;
    try {
      evaluated = SelectionExpression.evaluate(request.expression, SelectionResolver.objectsById(scene));
    } catch (e: any) {
      return { ok: false, code: 'evaluation-error', reason: e?.message ?? String(e) };
    }

    let shapes: Shape[];
    try {
      shapes = SelectionResolver.shapesOf(evaluated, scope.candidates);
    } catch (e: any) {
      return { ok: false, code: 'not-a-selection', reason: e?.message ?? String(e) };
    }

    const owners = SelectionResolver.ownersOf(scene, shapes);
    const matches: ResolvedSelectionMatch[] = [];
    let orphaned = 0;
    for (let i = 0; i < shapes.length; i++) {
      const owner = owners[i];
      if (!owner) {
        orphaned++;
        continue;
      }
      matches.push(SelectionResolver.toMatch(scene, shapes[i], owner, scope.instance));
    }

    const result: ResolveSelectionResult = { ok: true, matches, count: matches.length, scope: scope.scope, unit: scene.unit };
    if (orphaned > 0) {
      result.warning = SelectionResolver.orphanWarning(orphaned, shapes.length);
    }
    return result;
  }

  /**
   * A selection can name sub-shapes no solid in the final model carries — a
   * feature accessor whose members a later operation consumed, or a stale
   * select(). Dropping them silently reads as "matches nothing"; say what
   * happened instead.
   */
  private static orphanWarning(orphaned: number, total: number): string {
    return `${orphaned} of ${total} selected shape(s) belong to no solid in the final model and were dropped — `
      + 'a later feature consumed or reshaped them. Re-select on the final geometry (a face()/edge() filter), '
      + 'or consume the accessor in source right after the feature that owns it.';
  }

  private static objectsById(scene: Scene): Record<string, SceneObject> {
    const map: Record<string, SceneObject> = Object.create(null);
    for (const obj of scene.getAllSceneObjects()) {
      map[obj.id] = obj;
    }
    return map;
  }

  private static resolveScope(scene: Scene, input: SelectionScopeInput | undefined): ScopeResolution {
    if (!input) {
      return { ok: true, scope: { kind: 'root' }, candidates: scene.getAllSceneObjects() };
    }

    if ('instanceId' in input) {
      return SelectionResolver.resolveInstanceScope(scene, input.instanceId);
    }

    if ('part' in input) {
      const parts = scene.getAllSceneObjects().filter(
        (o): o is Part => o instanceof Part && (o.id === input.part || o.partName === input.part),
      );
      if (parts.length === 0) {
        return { ok: false, code: 'unknown-scope', reason: `No part "${input.part}" in the scene (pass a part name or a part's scene object id).` };
      }
      if (parts.length > 1) {
        const ids = parts.map(p => p.id);
        return {
          ok: false,
          code: 'ambiguous-scope',
          reason: `Part "${input.part}" names ${parts.length} variants in the scene; scope by scene object id instead: ${ids.join(', ')}.`,
          candidates: ids,
        };
      }
      const part = parts[0];
      return {
        ok: true,
        scope: { kind: 'part', partId: part.id, part: part.partName },
        candidates: scene.getPartScopedAllObjects(part),
      };
    }

    const obj = scene.getSceneObjectById(input.sceneObjectId);
    if (!obj) {
      return { ok: false, code: 'unknown-scope', reason: `No scene object "${input.sceneObjectId}" in the scene (ids come from get_scene_summary).` };
    }
    const part = scene.findEnclosingPart(obj);
    return {
      ok: true,
      scope: { kind: 'sceneObject', sceneObjectId: obj.id, partId: part?.id ?? null, part: part?.partName ?? null },
      candidates: scene.getPartScopedAllObjects(obj),
    };
  }

  private static resolveInstanceScope(scene: Scene, instanceId: string): ScopeResolution {
    if (!(scene instanceof AssemblyScene)) {
      return { ok: false, code: 'unknown-scope', reason: `Instance scope "${instanceId}" needs an assembly file; this scene is a part.` };
    }
    const instance = scene.getInstance(instanceId);
    const serialized = scene.getSerializedInstances().find(i => i.instanceId === instanceId);
    if (!instance || !serialized) {
      return { ok: false, code: 'unknown-scope', reason: `No instance "${instanceId}" in the assembly (instance ids come from get_scene_summary).` };
    }
    const part = instance.part;
    return {
      ok: true,
      scope: { kind: 'instance', instanceId, partId: part.id, part: part.partName },
      candidates: scene.getPartScopedAllObjects(part),
      instance: { instanceId, pose: { position: serialized.position, quaternion: serialized.quaternion } },
    };
  }

  private static shapesOf(evaluated: EvaluatedExpression, candidates: SceneObject[]): Shape[] {
    if (evaluated.kind === 'filters') {
      return SelectSceneObject.evaluateFilters(evaluated.filters, candidates);
    }
    const object = evaluated.object;
    if (object.isLazy()) {
      // A lazy accessor built outside the render (`$obj[id].endFaces()`)
      // has not resolved yet; one already in the scene latches and no-ops.
      object.build();
    }
    return object.getAddedShapes().filter(s => s instanceof Face || s instanceof Edge);
  }

  /**
   * The solid each matched face/edge belongs to, its index in that solid's
   * face/edge list (the index `measure` and `hit_test` use), and the leaf
   * scene object that owns the solid. Sub-shape wrappers are cached per
   * solid, so identity matches first and `isSame` covers re-wrapped shapes.
   */
  private static ownersOf(scene: Scene, shapes: Shape[]): (EntityOwner | null)[] {
    const leaves = scene.getAllSceneObjects().filter(o => !o.isContainer());
    const solids: { object: SceneObject; solid: Shape }[] = [];
    for (const object of leaves) {
      for (const solid of object.getShapes({}, 'solid')) {
        solids.push({ object, solid });
      }
    }
    return shapes.map(shape => {
      const kind = SelectionResolver.kindOf(shape);
      for (const { object, solid } of solids) {
        const subShapes = solid.getSubShapes(kind);
        let index = subShapes.indexOf(shape);
        if (index < 0) {
          index = subShapes.findIndex(s => s.isSame(shape));
        }
        if (index >= 0) {
          return { object, solid, index };
        }
      }
      return null;
    });
  }

  private static kindOf(shape: Shape): MeasureEntityKind {
    return shape instanceof Face ? 'face' : 'edge';
  }

  private static toMatch(
    scene: Scene,
    shape: Shape,
    owner: EntityOwner,
    instance: { instanceId: string; pose: MeasurePose } | undefined,
  ): ResolvedSelectionMatch {
    const kind = SelectionResolver.kindOf(shape);
    const part = scene.findEnclosingPart(owner.object);
    const match: ResolvedSelectionMatch = {
      shapeId: owner.solid.id,
      kind,
      index: owner.index,
      sceneObjectId: owner.object.id,
      sceneObjectName: owner.object.getName(),
      part: part?.partName ?? null,
      summary: SelectionResolver.summarize(shape, kind, scene.unit, instance?.pose),
    };
    if (instance) {
      match.instanceId = instance.instanceId;
      match.pose = instance.pose;
    }
    return match;
  }

  /** The entity's summary, posed like `measure` poses assembly entities when a pose is given. */
  static summarize(shape: Shape, kind: MeasureEntityKind, unit: LengthUnit, pose?: MeasurePose): EntitySummary {
    let topo = shape.getShape();
    const disposers: (() => void)[] = [];
    if (pose) {
      const [trsf, disposeTrsf] = Convert.toGpTrsfPose(pose.position, pose.quaternion);
      const location = new (getOC().TopLoc_Location)(trsf);
      topo = topo.Moved(location, false);
      disposers.push(() => {
        location.delete();
        disposeTrsf();
      });
    }
    try {
      const classified = kind === 'face' ? classifyFace(topo) : classifyEdge(topo);
      return EntitySummaryBuilder.fromClassified(classified, unit);
    } finally {
      for (const dispose of disposers) {
        dispose();
      }
    }
  }
}
