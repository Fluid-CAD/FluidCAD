import { Scene } from "../rendering/scene.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { ShapeValidator } from "../oc/shape-validator.js";
import type { ShapeFindingKind } from "../oc/shape-validator.js";
import { EntitySummaryBuilder } from "../oc/measure/entity-summary.js";
import { describeError } from "../common/describe-error.js";
import type { LengthUnit } from "../units/units.js";

export type ValidateSceneRequest = {
  /** Only these rendered shapes. Omitted: every solid the scene renders. */
  shapeIds?: string[];
  /** Assembly files: only the shapes of this instance's part prototype. */
  instanceId?: string;
};

/** One defect, addressed the way `measure` and `resolve_selection` address geometry. */
export type SceneValidationFinding = {
  kind: ShapeFindingKind;
  shapeId: string;
  sceneObjectId: string;
  /** The owning part's name (null at root outside any part). */
  part: string | null;
  /** Assembly files: every instance that shows this shape. */
  instanceIds?: string[];
  message: string;
};

/** What was examined per shape, whether or not it had findings. */
export type ValidatedShape = {
  shapeId: string;
  sceneObjectId: string;
  sceneObjectName: string;
  part: string | null;
  instanceIds?: string[];
  faces: number;
  edges: number;
  solids: number;
  /** Signed volume in the document unit cubed; absent for a shape without a solid. */
  volume?: number;
  /** Present when the shape holds several solids — the sign check ran on each. */
  solidVolumes?: number[];
  findings: ShapeFindingKind[];
};

export type SkippedShape = {
  shapeId: string;
  sceneObjectId: string;
  reason: string;
};

export type SceneValidationReport = {
  /** True only when there are no findings (skips do not count as findings, but are listed). */
  ok: boolean;
  /** Shapes examined. */
  checked: number;
  findings: SceneValidationFinding[];
  shapes: ValidatedShape[];
  /** Shapes that could not be examined, with why. */
  skipped: SkippedShape[];
  /** The checks that ran, so a clean report says what "clean" covered. */
  checks: ShapeFindingKind[];
  /** Checks a caller might expect that this kernel build cannot run. */
  notChecked: Record<string, string>;
  unit: LengthUnit;
};

export type SceneValidationRefusalCode = 'unknown-shape' | 'unknown-instance' | 'not-an-assembly';

export type SceneValidationOutcome =
  | { kind: 'report'; report: SceneValidationReport }
  | { kind: 'refused'; code: SceneValidationRefusalCode; reason: string };

/** A shape the scene currently renders, with the leaf object that owns it. */
type RenderedCandidate = { object: SceneObject; shape: Shape };

/**
 * Runs {@link ShapeValidator} over the shapes a scene renders and addresses
 * every result the way the other inspection paths do (shape id, owning scene
 * object and part, instance ids in an assembly).
 *
 * "What the scene renders" is read from the scene's rendered objects: a
 * visible leaf object's `sceneShapes`, so a solid a later cut consumed, a
 * feature hidden by a rollback, or an exposure's soft-removed source is not
 * examined — the agent asked about the geometry it can see.
 *
 * In an assembly the instances of one part share the part's prototype
 * shapes, so each unique shape is validated once and every instance that
 * shows it is listed; `instanceId` narrows the pool to one instance's
 * prototype (the listed instance ids still name every instance of it).
 */
export class SceneValidator {

  static validate(scene: Scene, request: ValidateSceneRequest = {}): SceneValidationOutcome {
    const instances = SceneValidator.instancesByPartId(scene);
    let candidates = SceneValidator.renderedCandidates(scene);

    if (request.instanceId !== undefined) {
      const scoped = SceneValidator.scopeToInstance(scene, candidates, request.instanceId);
      if (scoped.kind === 'refused') {
        return scoped;
      }
      candidates = scoped.candidates;
    }

    if (request.shapeIds) {
      const picked = SceneValidator.pickShapes(candidates, request.shapeIds);
      if (picked.kind === 'refused') {
        return picked;
      }
      candidates = picked.candidates;
    } else {
      candidates = candidates.filter(c => SceneValidator.isRenderedSolid(scene, c, instances));
    }

    const decimals = EntitySummaryBuilder.decimalsFor(scene.unit);
    const shapes: ValidatedShape[] = [];
    const findings: SceneValidationFinding[] = [];
    const skipped: SkippedShape[] = [];

    for (const candidate of candidates) {
      const part = scene.findEnclosingPart(candidate.object);
      const address = {
        shapeId: candidate.shape.id,
        sceneObjectId: candidate.object.id,
        part: part?.partName ?? null,
        ...(instances ? { instanceIds: instances.get(part?.id ?? '') ?? [] } : {}),
      };
      let validation;
      try {
        validation = ShapeValidator.validate(candidate.shape.getShape());
      } catch (error) {
        skipped.push({ shapeId: address.shapeId, sceneObjectId: address.sceneObjectId, reason: describeError(error) });
        continue;
      }
      const volumes = validation.solidVolumes.map(v => EntitySummaryBuilder.round(v, decimals));
      shapes.push({
        ...address,
        sceneObjectName: candidate.object.getName(),
        faces: validation.faces,
        edges: validation.edges,
        solids: validation.solids,
        ...(volumes.length > 0 ? { volume: EntitySummaryBuilder.round(volumes.reduce((a, b) => a + b, 0), decimals) } : {}),
        ...(volumes.length > 1 ? { solidVolumes: volumes } : {}),
        findings: validation.findings.map(f => f.kind),
      });
      for (const finding of validation.findings) {
        findings.push({ kind: finding.kind, ...address, message: finding.message });
      }
    }

    return {
      kind: 'report',
      report: {
        ok: findings.length === 0,
        checked: shapes.length,
        findings,
        shapes,
        skipped,
        checks: [...ShapeValidator.CHECKS],
        notChecked: { ...ShapeValidator.UNAVAILABLE },
        unit: scene.unit,
      },
    };
  }

  /**
   * Every shape a visible leaf object currently renders, in scene order.
   * The rendered record carries shape ids (its `object` is the serialized
   * form); the live wrappers come from the scene object itself.
   */
  private static renderedCandidates(scene: Scene): RenderedCandidate[] {
    const out: RenderedCandidate[] = [];
    for (const object of scene.getAllSceneObjects()) {
      if (object.isContainer()) {
        continue;
      }
      const rendered = scene.getRenderedObject(object);
      if (!rendered || !rendered.visible || rendered.sceneShapes.length === 0) {
        continue;
      }
      const renderedIds = new Set(rendered.sceneShapes.map(s => s.shapeId));
      for (const shape of object.getOwnShapes({ excludeMeta: false, excludeGuide: false })) {
        if (renderedIds.has(shape.id)) {
          out.push({ object, shape });
        }
      }
    }
    return out;
  }

  /** Part id → instance ids, or null when the scene is not an assembly. */
  private static instancesByPartId(scene: Scene): Map<string, string[]> | null {
    if (!(scene instanceof AssemblyScene)) {
      return null;
    }
    const map = new Map<string, string[]>();
    for (const instance of scene.getSerializedInstances()) {
      const list = map.get(instance.partId) ?? [];
      list.push(instance.instanceId);
      map.set(instance.partId, list);
    }
    return map;
  }

  /**
   * The default pool: solids only (sketch geometry and helper shapes are
   * never solids and would report `noSolid` on every line), no meta or guide
   * shape, and in an assembly only prototypes at least one instance shows.
   */
  private static isRenderedSolid(scene: Scene, candidate: RenderedCandidate, instances: Map<string, string[]> | null): boolean {
    const shape = candidate.shape;
    if (shape.getType() !== 'solid' || shape.isMetaShape() || shape.isGuideShape()) {
      return false;
    }
    if (!instances) {
      return true;
    }
    const part = scene.findEnclosingPart(candidate.object);
    return part !== null && (instances.get(part.id)?.length ?? 0) > 0;
  }

  private static scopeToInstance(
    scene: Scene,
    candidates: RenderedCandidate[],
    instanceId: string,
  ): { kind: 'ok'; candidates: RenderedCandidate[] } | Extract<SceneValidationOutcome, { kind: 'refused' }> {
    if (!(scene instanceof AssemblyScene)) {
      return { kind: 'refused', code: 'not-an-assembly', reason: `instanceId "${instanceId}" needs an assembly file; this scene is a part.` };
    }
    const instance = scene.getInstance(instanceId);
    if (!instance) {
      return { kind: 'refused', code: 'unknown-instance', reason: `No instance "${instanceId}" in the assembly (instance ids come from get_scene_summary).` };
    }
    const members = new Set(scene.getPartScopedAllObjects(instance.part));
    return { kind: 'ok', candidates: candidates.filter(c => members.has(c.object)) };
  }

  private static pickShapes(
    candidates: RenderedCandidate[],
    shapeIds: string[],
  ): { kind: 'ok'; candidates: RenderedCandidate[] } | Extract<SceneValidationOutcome, { kind: 'refused' }> {
    const byId = new Map(candidates.map(c => [c.shape.id, c]));
    const missing = shapeIds.filter(id => !byId.has(id));
    if (missing.length > 0) {
      return {
        kind: 'refused',
        code: 'unknown-shape',
        reason: `No rendered shape ${missing.map(id => `"${id}"`).join(', ')} in the scene (shape ids come from list_shapes or get_scene_summary).`,
      };
    }
    const unique = [...new Set(shapeIds)];
    return { kind: 'ok', candidates: unique.map(id => byId.get(id)!) };
  }
}
