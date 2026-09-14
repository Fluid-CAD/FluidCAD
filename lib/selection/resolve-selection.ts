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
import type { PickRef, SelectionScene, SynthesizeOptions } from "./types.js";
import { scopedSceneBefore } from "./types.js";
import { SelectionSynthesizer } from "./synthesize-selection.js";
import type { SynthesizedSelection } from "./synthesize-selection.js";

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

/**
 * What to resolve — a filter expression or explicit picks (one of the two) —
 * and where: the part scope a `select()` runs in, and optionally the
 * statement boundary `before`, the index of the statement the selection is
 * written before (an edited statement, or the one a new statement is
 * inserted in front of). With a boundary only the objects strictly before
 * that index exist — the world that statement's arguments see at build time.
 */
export type ResolveSelectionRequest = {
  expression?: string;
  picks?: PickRef[];
  scope?: SelectionScopeInput;
  before?: number;
};

export type ResolveSelectionErrorCode =
  | 'invalid-request'
  | 'unknown-scope'
  | 'ambiguous-scope'
  | 'invalid-boundary'
  | 'unresolved-pick'
  | 'out-of-scope'
  | 'evaluation-error'
  | 'not-a-selection';

export type ResolveSelectionResult =
  | {
    ok: true;
    matches: ResolvedSelectionMatch[];
    count: number;
    scope: ResolvedSelectionScope;
    /** Echo of the request's statement boundary, when one was given. */
    before?: number;
    unit: LengthUnit;
    warning?: string;
    /** The selector the language would write for exactly these matches — see {@link SelectionSynthesizer}. */
    synthesized?: SynthesizedSelection;
  }
  | { ok: false; code: ResolveSelectionErrorCode; reason: string; candidates?: string[]; pick?: PickRef };

type ScopeResolution =
  | {
    ok: true;
    scope: ResolvedSelectionScope;
    /** The part a `select()` at this scope runs in; null at root. */
    part: Part | null;
    candidates: SceneObject[];
    instance?: { instanceId: string; pose: MeasurePose };
  }
  | { ok: false; code: 'unknown-scope' | 'ambiguous-scope' | 'invalid-boundary'; reason: string; candidates?: string[] };

/** One evaluated selection: a filter builder or a selection/lazy-accessor object. */
type EvaluatedItem =
  | { kind: 'filter'; filter: FilterBuilderBase<Shape> }
  | { kind: 'selection'; object: SceneObject };

/** The expression's value: one selection or a list of them (`[e.endEdges(), edge().circle(5)]`). */
type EvaluatedExpression = { items: EvaluatedItem[] };

type EntityOwner = { object: SceneObject; solid: Shape; index: number };
type SolidEntry = { object: SceneObject; solid: Shape };

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

  static evaluate(expression: string, objectsById: Record<string, SceneObject>, boundary?: number): EvaluatedExpression {
    const body = `"use strict";\nreturn (\n${expression}\n);`;
    const fn = new Function('face', 'edge', '$obj', ...SelectionExpression.SHADOWED_GLOBALS, body);
    const $obj = SelectionExpression.objectLookup(objectsById, boundary);
    const value = fn(face, edge, $obj, ...SelectionExpression.SHADOWED_GLOBALS.map(() => undefined));
    return SelectionExpression.classify(value);
  }

  /**
   * `$obj` names an unknown id with the reason instead of yielding
   * `undefined` — the TypeError that follows (`Cannot read properties of
   * undefined`) would not say whether the id is wrong or the object simply
   * does not exist yet before the boundary.
   */
  private static objectLookup(objectsById: Record<string, SceneObject>, boundary: number | undefined): Record<string, SceneObject> {
    return new Proxy(objectsById, {
      get(target, id) {
        if (typeof id !== 'string') {
          return undefined;
        }
        const found = target[id];
        if (found) {
          return found;
        }
        const where = boundary === undefined
          ? 'in the scene (ids come from get_scene_summary)'
          : `before statement index ${boundary} — it is either unknown or built at or after the boundary`;
        throw new Error(`$obj["${id}"]: no scene object "${id}" ${where}.`);
      },
    });
  }

  private static classify(value: unknown): EvaluatedExpression {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        throw new Error('The expression yields an empty array; list at least one face()/edge() filter or selection.');
      }
      return { items: value.map(item => SelectionExpression.classifyItem(item)) };
    }
    return { items: [SelectionExpression.classifyItem(value)] };
  }

  private static classifyItem(value: unknown): EvaluatedItem {
    if (value instanceof FilterBuilderBase) {
      return { kind: 'filter', filter: value };
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
    const described = value === null ? 'null' : Array.isArray(value) ? 'a nested array' : typeof value;
    throw new Error(
      `The expression must yield a face()/edge() filter or a selection, or an array of those; it yielded ${described}.`,
    );
  }
}

/**
 * Resolves filter expressions (or explicit picks) against the scene with
 * exactly the candidate set a `select(...)` statement sees at the requested
 * scope:
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
 * A statement boundary (`before`) truncates the world to the objects
 * strictly before that index — what the statement's arguments see at build
 * time, the same view `scopedSceneBefore` gives the edit dialogs — for the
 * candidates, `$obj`, and the solids the matches are addressed on.
 *
 * `.from(obj)` inside the expression bypasses the scope, as in source, because
 * the candidate assembly is `SelectSceneObject.evaluateFilters` itself.
 *
 * With synthesis options the matches are handed to the selector synthesizer,
 * which answers with the expression the language would write for them.
 */
export class SelectionResolver {

  static resolve(scene: Scene, request: ResolveSelectionRequest, synthesis?: SynthesizeOptions): ResolveSelectionResult {
    const hasExpression = typeof request.expression === 'string';
    const hasPicks = Array.isArray(request.picks);
    if (hasExpression === hasPicks) {
      return { ok: false, code: 'invalid-request', reason: 'Pass exactly one of `expression` (filter syntax) or `picks` (face/edge refs).' };
    }

    const view = SelectionResolver.viewBefore(scene, request.before);
    if (view.ok === false) {
      return { ok: false, code: view.code, reason: view.reason };
    }

    const scope = SelectionResolver.resolveScope(scene, view.objects, request.scope, request.before);
    if (scope.ok === false) {
      return { ok: false, code: scope.code, reason: scope.reason, ...(scope.candidates ? { candidates: scope.candidates } : {}) };
    }

    const solids = SelectionResolver.solidsOf(view.objects, view.removalScope);
    let matches: ResolvedSelectionMatch[];
    let warning: string | undefined;
    if (hasPicks) {
      const picked = SelectionResolver.resolvePicks(scene, request.picks!, solids, scope, request.before);
      if (picked.ok === false) {
        return picked;
      }
      matches = picked.matches;
    } else {
      const resolved = SelectionResolver.resolveExpression(scene, request.expression!, view, scope, solids);
      if (resolved.ok === false) {
        return resolved;
      }
      matches = resolved.matches;
      warning = resolved.warning;
    }

    const result: ResolveSelectionResult = {
      ok: true, matches, count: matches.length, scope: scope.scope,
      ...(request.before !== undefined ? { before: request.before } : {}),
      unit: scene.unit,
    };
    if (warning) {
      result.warning = warning;
    }
    if (synthesis && matches.length > 0) {
      result.synthesized = SelectionSynthesizer.synthesize(view.scene, matches, scope.part, request, synthesis);
    }
    return result;
  }

  /**
   * The objects the request sees: all of them, or those strictly before the
   * boundary. `before` counts statements the way `rollback_to` does; a value
   * of `n` shows what `rollback_to(n - 1)` renders.
   */
  private static viewBefore(
    scene: Scene,
    before: number | undefined,
  ): { ok: true; scene: SelectionScene; objects: SceneObject[]; removalScope?: Set<SceneObject> } | { ok: false; code: 'invalid-boundary'; reason: string } {
    const all = scene.getAllSceneObjects();
    if (before === undefined) {
      return { ok: true, scene, objects: all };
    }
    if (!Number.isInteger(before) || before < 1 || before > all.length) {
      return {
        ok: false,
        code: 'invalid-boundary',
        reason: `\`before\` must be a statement index from 1 to ${all.length} (the scene has ${all.length} objects); `
          + 'it names the statement the selection is written before, so every object strictly before it is visible.',
      };
    }
    // Removals by statements at or after the boundary have not happened in
    // this world: a solid the boundary statement itself consumes is still
    // there, exactly as the rollback render shows it.
    const scoped = scopedSceneBefore(scene, before);
    const objects = scoped.getAllSceneObjects();
    return { ok: true, scene: scoped, objects, removalScope: new Set(objects) };
  }

  private static resolveExpression(
    scene: Scene,
    expression: string,
    view: { objects: SceneObject[]; removalScope?: Set<SceneObject> },
    scope: Extract<ScopeResolution, { ok: true }>,
    solids: SolidEntry[],
  ): { ok: true; matches: ResolvedSelectionMatch[]; warning?: string } | Extract<ResolveSelectionResult, { ok: false }> {
    const before = view.removalScope ? view.objects.length : undefined;
    let evaluated: EvaluatedExpression;
    try {
      evaluated = SelectionExpression.evaluate(expression, SelectionResolver.objectsById(view.objects), before);
    } catch (e: any) {
      return { ok: false, code: 'evaluation-error', reason: e?.message ?? String(e) };
    }

    let shapes: Shape[];
    try {
      shapes = SelectionResolver.shapesOf(evaluated, scope.candidates, view.removalScope);
    } catch (e: any) {
      return { ok: false, code: 'not-a-selection', reason: e?.message ?? String(e) };
    }

    const owners = SelectionResolver.ownersOf(solids, shapes);
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
    return {
      ok: true,
      matches,
      ...(orphaned > 0 ? { warning: SelectionResolver.orphanWarning(orphaned, shapes.length, before) } : {}),
    };
  }

  /**
   * Explicit picks address a face/edge by solid id and index, the way
   * `hit_test` and `measure` do. Each must exist in the visible world and,
   * under a part scope, belong to that part — a `select()` there could never
   * name a face of another part.
   */
  private static resolvePicks(
    scene: Scene,
    picks: PickRef[],
    solids: SolidEntry[],
    scope: Extract<ScopeResolution, { ok: true }>,
    before: number | undefined,
  ): { ok: true; matches: ResolvedSelectionMatch[] } | Extract<ResolveSelectionResult, { ok: false }> {
    if (picks.length === 0) {
      return { ok: false, code: 'invalid-request', reason: '`picks` must list at least one face/edge ref.' };
    }
    const matches: ResolvedSelectionMatch[] = [];
    for (const pick of picks) {
      const entry = solids.find(s => s.solid.id === pick.shapeId);
      if (!entry) {
        const where = before === undefined
          ? 'the scene (ids come from list_shapes / get_scene_summary)'
          : `the world before statement index ${before} (ids come from the rolled-back scene, rollback_to(${before - 1}))`;
        return { ok: false, code: 'unresolved-pick', reason: `No solid "${pick.shapeId}" in ${where}.`, pick };
      }
      const subShapes = entry.solid.getSubShapes(pick.sub.type);
      const shape = subShapes[pick.sub.index];
      if (!shape) {
        return {
          ok: false,
          code: 'unresolved-pick',
          reason: `Solid "${pick.shapeId}" has ${subShapes.length} ${pick.sub.type}s; index ${pick.sub.index} does not exist.`,
          pick,
        };
      }
      if (scope.part && scene.findEnclosingPart(entry.object) !== scope.part) {
        const owner = scene.findEnclosingPart(entry.object);
        return {
          ok: false,
          code: 'out-of-scope',
          reason: `${pick.sub.type} ${pick.sub.index} of "${pick.shapeId}" belongs to ${owner ? `part "${owner.partName}"` : 'no part'}, `
            + `outside scope part "${scope.part.partName}" — a select() there cannot name it.`,
          pick,
        };
      }
      matches.push(SelectionResolver.toMatch(scene, shape, { object: entry.object, solid: entry.solid, index: pick.sub.index }, scope.instance));
    }
    return { ok: true, matches };
  }

  /**
   * A selection can name sub-shapes no solid in the final model carries — a
   * feature accessor whose members a later operation consumed, or a stale
   * select(). Dropping them silently reads as "matches nothing"; say what
   * happened instead.
   */
  private static orphanWarning(orphaned: number, total: number, before: number | undefined): string {
    const world = before === undefined ? 'the final model' : `the world before statement index ${before}`;
    return `${orphaned} of ${total} selected shape(s) belong to no solid in ${world} and were dropped — `
      + 'a later feature consumed or reshaped them. Re-select on the visible geometry (a face()/edge() filter), '
      + 'or consume the accessor in source right after the feature that owns it.';
  }

  private static objectsById(objects: SceneObject[]): Record<string, SceneObject> {
    const map: Record<string, SceneObject> = Object.create(null);
    for (const obj of objects) {
      map[obj.id] = obj;
    }
    return map;
  }

  private static resolveScope(
    scene: Scene,
    objects: SceneObject[],
    input: SelectionScopeInput | undefined,
    before: number | undefined,
  ): ScopeResolution {
    if (!input) {
      return { ok: true, scope: { kind: 'root' }, part: null, candidates: objects };
    }

    if ('instanceId' in input) {
      if (before !== undefined) {
        return {
          ok: false,
          code: 'invalid-boundary',
          reason: 'A statement boundary applies to this file\'s own statements; an instance scope evaluates the inserted part\'s build. '
            + 'Resolve with the boundary in the part file instead, or drop `before`.',
        };
      }
      return SelectionResolver.resolveInstanceScope(scene, input.instanceId);
    }

    const inView = (obj: SceneObject) => objects.includes(obj);
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
      if (!inView(part)) {
        return {
          ok: false,
          code: 'invalid-boundary',
          reason: `Part "${part.partName}" (index ${scene.getAllSceneObjects().indexOf(part)}) begins at or after the boundary ${before}; nothing of it is visible there.`,
        };
      }
      return {
        ok: true,
        scope: { kind: 'part', partId: part.id, part: part.partName },
        part,
        candidates: objects.filter(o => scene.findEnclosingPart(o) === part),
      };
    }

    const obj = scene.getSceneObjectById(input.sceneObjectId);
    if (!obj) {
      return { ok: false, code: 'unknown-scope', reason: `No scene object "${input.sceneObjectId}" in the scene (ids come from get_scene_summary).` };
    }
    const part = scene.findEnclosingPart(obj);
    if (part && !inView(part)) {
      return {
        ok: false,
        code: 'invalid-boundary',
        reason: `Scene object "${obj.id}" lives in part "${part.partName}", which begins at or after the boundary ${before}; nothing of it is visible there.`,
      };
    }
    return {
      ok: true,
      scope: { kind: 'sceneObject', sceneObjectId: obj.id, partId: part?.id ?? null, part: part?.partName ?? null },
      part,
      candidates: part ? objects.filter(o => scene.findEnclosingPart(o) === part) : objects,
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
      part,
      candidates: scene.getPartScopedAllObjects(part),
      instance: { instanceId, pose: { position: serialized.position, quaternion: serialized.quaternion } },
    };
  }

  private static shapesOf(evaluated: EvaluatedExpression, candidates: SceneObject[], removalScope?: Set<SceneObject>): Shape[] {
    const shapes: Shape[] = [];
    const filters = evaluated.items.filter((i): i is Extract<EvaluatedItem, { kind: 'filter' }> => i.kind === 'filter');
    if (filters.length > 0) {
      shapes.push(...SelectSceneObject.evaluateFilters(filters.map(f => f.filter), candidates, [], removalScope));
    }
    for (const item of evaluated.items) {
      if (item.kind !== 'selection') {
        continue;
      }
      const object = item.object;
      if (object.isLazy()) {
        // A lazy accessor built outside the render (`$obj[id].endFaces()`)
        // has not resolved yet; one already in the scene latches and no-ops.
        object.build();
      }
      shapes.push(...object.getAddedShapes().filter(s => s instanceof Face || s instanceof Edge));
    }
    return shapes;
  }

  /** Every solid the visible leaf objects carry, with its owner; `removalScope` bounds which removals count (a boundary world). */
  private static solidsOf(objects: SceneObject[], removalScope?: Set<SceneObject>): SolidEntry[] {
    const solids: SolidEntry[] = [];
    for (const object of objects) {
      if (object.isContainer()) {
        continue;
      }
      for (const solid of object.getShapes({}, 'solid', removalScope)) {
        solids.push({ object, solid });
      }
    }
    return solids;
  }

  /**
   * The solid each matched face/edge belongs to, its index in that solid's
   * face/edge list (the index `measure` and `hit_test` use), and the leaf
   * scene object that owns the solid. Sub-shape wrappers are cached per
   * solid, so identity matches first and `isSame` covers re-wrapped shapes.
   */
  private static ownersOf(solids: SolidEntry[], shapes: Shape[]): (EntityOwner | null)[] {
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
