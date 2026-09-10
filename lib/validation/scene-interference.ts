import { Scene } from "../rendering/scene.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import { ShapeInterference } from "../oc/shape-interference.js";
import type { PosedShape } from "../oc/shape-interference.js";
import type { MeasurePose } from "../oc/measure/measure-types.js";
import { EntitySummaryBuilder } from "../oc/measure/entity-summary.js";
import { describeError } from "../common/describe-error.js";
import { MM_PER_UNIT } from "../units/units.js";
import type { LengthUnit } from "../units/units.js";
import { RenderedSolidPool } from "./rendered-pool.js";
import type { RenderedCandidate, RenderedPoolRefusalCode } from "./rendered-pool.js";

/** A live world pose for one instance, overriding its statement pose. */
export type InterferencePose = MeasurePose & { instanceId: string };

export type InterferenceRequest = {
  /**
   * Assembly files: restrict to these instances. One id tests that
   * instance against every other body; two or more test only the named
   * instances among themselves.
   */
  instanceIds?: string[];
  /** Only these rendered shapes (in an assembly: every instance showing them). Omitted: every solid the scene renders. */
  shapeIds?: string[];
  /**
   * Minimum common volume, in the document unit cubed, that counts as an
   * overlap. Default: the equivalent of 1 mm³ (touching faces yield slivers).
   */
  tolerance?: number;
  /** Assembly files: world poses to use instead of the statement poses, per instance. */
  poses?: InterferencePose[];
};

/** One body, addressed the way `validate` and `measure` address geometry. */
export type InterferenceBody = {
  shapeId: string;
  sceneObjectId: string;
  sceneObjectName: string;
  /** The owning part's name (null at root outside any part). */
  part: string | null;
  /** Assembly files: the instance this body belongs to. */
  instanceId?: string;
};

export type InterferencePair = {
  a: InterferenceBody;
  b: InterferenceBody;
  /** The shared volume in the document unit cubed. */
  volume: number;
};

export type InterferenceFailure = {
  a: InterferenceBody;
  b: InterferenceBody;
  /** The kernel's message; the pair is neither cleared nor a clash. */
  message: string;
};

export type SceneInterferenceReport = {
  /**
   * True only when at least two bodies from at least two parts were
   * compared, no pair clashed and no pair failed. An inconclusive check
   * is never a pass.
   */
  ok: boolean;
  /** Why the check could not decide, when it could not. */
  inconclusive?: string;
  /** Candidate bodies (in an assembly: one per instance showing a solid). */
  bodies: number;
  /** Parts (assembly: instances) the bodies belong to — the unit of the verdict. */
  units: number;
  /** Pairs whose bounds overlapped and whose boolean ran — the cost of the check. */
  checked: number;
  /** Pairs skipped because their world bounds do not meet. */
  rejectedByBounds: number;
  /** Bodies of two different parts (assembly: instances) sharing more than `tolerance`. */
  clashes: InterferencePair[];
  /** Bodies of one part (assembly: one instance) sharing space; reported, never a failure. */
  intraPart: InterferencePair[];
  /** Pairs whose boolean threw; listed with the message and otherwise skipped. */
  failed: InterferenceFailure[];
  /** The volume threshold applied, in the document unit cubed. */
  tolerance: number;
  unit: LengthUnit;
};

export type SceneInterferenceRefusalCode = RenderedPoolRefusalCode;

export type SceneInterferenceOutcome =
  | { kind: 'report'; report: SceneInterferenceReport }
  | { kind: 'refused'; code: SceneInterferenceRefusalCode; reason: string };

/** A candidate solid placed once in the world, with the unit it counts under. */
type Body = {
  address: InterferenceBody;
  /** Bodies with the same key are one part (assembly: one instance). */
  unitKey: string;
  candidate: RenderedCandidate;
  pose?: MeasurePose;
};

type Refusal = Extract<SceneInterferenceOutcome, { kind: 'refused' }>;

/**
 * Do any two bodies of a scene occupy the same space?
 *
 * The bodies are the solids the scene renders ({@link RenderedSolidPool}).
 * In an assembly every instance of a part is its own body set, placed at
 * its statement pose (or the pose the caller supplies), so two instances of
 * one part can clash with each other. The unit of the verdict is the part:
 * a pair from two instances (or, in a part file, two `part()` blocks) is a
 * clash; a pair inside one instance (a multi-solid part) is `intraPart` and
 * never fails; in a file without parts every solid is its own unit.
 *
 * Every pair is bounds-rejected before a boolean runs, and a boolean that
 * throws is recorded under `failed` without aborting the rest.
 */
export class SceneInterference {

  /** The default overlap threshold: 1 mm³ expressed in `unit` cubed. */
  static defaultTolerance(unit: LengthUnit): number {
    const perUnit = MM_PER_UNIT[unit];
    return 1 / (perUnit * perUnit * perUnit);
  }

  static check(scene: Scene, request: InterferenceRequest = {}): SceneInterferenceOutcome {
    const instances = RenderedSolidPool.instancesByPartId(scene);

    const candidates = SceneInterference.candidates(scene, request, instances);
    if (candidates.kind === 'refused') {
      return candidates;
    }

    const named = SceneInterference.namedInstances(scene, request.instanceIds);
    if (named.kind === 'refused') {
      return named;
    }

    const poses = SceneInterference.poseOverrides(scene, request.poses);
    if (poses.kind === 'refused') {
      return poses;
    }

    let bodies = SceneInterference.bodies(scene, candidates.candidates, instances, poses.byInstance);
    if (named.ids && named.ids.size >= 2) {
      bodies = bodies.filter(b => named.ids!.has(b.address.instanceId ?? ''));
    }

    const unit = scene.unit;
    const tolerance = request.tolerance ?? SceneInterference.defaultTolerance(unit);
    const decimals = SceneInterference.volumeDecimalsFor(unit);
    const unitKeys = new Set(bodies.map(b => b.unitKey));
    const report: SceneInterferenceReport = {
      ok: false,
      bodies: bodies.length,
      units: unitKeys.size,
      checked: 0,
      rejectedByBounds: 0,
      clashes: [],
      intraPart: [],
      failed: [],
      tolerance: EntitySummaryBuilder.round(tolerance, decimals),
      unit,
    };

    // A verdict needs two parts; the pairs still run below so a single
    // multi-body part gets its intraPart overlaps listed with the reason.
    const inconclusive = SceneInterference.inconclusiveReason(bodies.length, unitKeys.size, instances !== null);
    if (inconclusive) {
      report.inconclusive = inconclusive;
    }
    if (bodies.length < 2) {
      return { kind: 'report', report };
    }

    const gap = Math.cbrt(tolerance);
    const posed: PosedShape[] = [];
    try {
      for (const body of bodies) {
        posed.push(ShapeInterference.pose(body.candidate.shape.getShape(), body.pose));
      }
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          if (!SceneInterference.pairEligible(bodies[i], bodies[j], named.ids)) {
            continue;
          }
          if (!ShapeInterference.boundsOverlap(posed[i].bounds, posed[j].bounds, gap)) {
            report.rejectedByBounds++;
            continue;
          }
          report.checked++;
          let volume: number;
          try {
            volume = ShapeInterference.commonVolume(posed[i].shape, posed[j].shape);
          } catch (error) {
            report.failed.push({ a: bodies[i].address, b: bodies[j].address, message: describeError(error) });
            continue;
          }
          if (volume <= tolerance) {
            continue;
          }
          const pair = { a: bodies[i].address, b: bodies[j].address, volume: EntitySummaryBuilder.round(volume, decimals) };
          if (bodies[i].unitKey === bodies[j].unitKey) {
            report.intraPart.push(pair);
          } else {
            report.clashes.push(pair);
          }
        }
      }
    } finally {
      for (const p of posed) {
        p.dispose();
      }
    }

    report.ok = !inconclusive && report.clashes.length === 0 && report.failed.length === 0;
    return { kind: 'report', report };
  }

  /** Volumes carry three more decimals than lengths, so a 1 mm³ overlap in a metre document does not round to 0. */
  private static volumeDecimalsFor(unit: LengthUnit): number {
    return EntitySummaryBuilder.decimalsFor(unit) + 3;
  }

  /** The candidate solids: the default pool, or the named shapes when every one is a rendered solid. */
  private static candidates(
    scene: Scene,
    request: InterferenceRequest,
    instances: Map<string, string[]> | null,
  ): { kind: 'ok'; candidates: RenderedCandidate[] } | Refusal {
    const rendered = RenderedSolidPool.renderedCandidates(scene);
    if (!request.shapeIds) {
      return { kind: 'ok', candidates: rendered.filter(c => RenderedSolidPool.isRenderedSolid(scene, c, instances)) };
    }
    const picked = RenderedSolidPool.pickShapes(rendered, request.shapeIds);
    if (picked.kind === 'refused') {
      return picked;
    }
    const notSolid = picked.candidates.filter(c => c.shape.getType() !== 'solid');
    if (notSolid.length > 0) {
      return {
        kind: 'refused',
        code: 'unknown-shape',
        reason: `Shape ${notSolid.map(c => `"${c.shape.id}"`).join(', ')} is not a solid (sketch geometry or a helper shape has no volume to share); name solids only.`,
      };
    }
    return picked;
  }

  /** The instances the caller named, validated; null when the request names none. */
  private static namedInstances(scene: Scene, instanceIds: string[] | undefined): { kind: 'ok'; ids: Set<string> | null } | Refusal {
    if (!instanceIds || instanceIds.length === 0) {
      return { kind: 'ok', ids: null };
    }
    if (!(scene instanceof AssemblyScene)) {
      return { kind: 'refused', code: 'not-an-assembly', reason: `instanceIds need an assembly file; this scene is a part.` };
    }
    for (const id of instanceIds) {
      if (!scene.getInstance(id)) {
        return { kind: 'refused', code: 'unknown-instance', reason: RenderedSolidPool.unknownInstanceReason(id) };
      }
    }
    return { kind: 'ok', ids: new Set(instanceIds) };
  }

  private static poseOverrides(scene: Scene, poses: InterferencePose[] | undefined): { kind: 'ok'; byInstance: Map<string, MeasurePose> } | Refusal {
    const byInstance = new Map<string, MeasurePose>();
    if (!poses || poses.length === 0) {
      return { kind: 'ok', byInstance };
    }
    if (!(scene instanceof AssemblyScene)) {
      return { kind: 'refused', code: 'not-an-assembly', reason: `poses need an assembly file; this scene is a part.` };
    }
    for (const pose of poses) {
      if (!scene.getInstance(pose.instanceId)) {
        return { kind: 'refused', code: 'unknown-instance', reason: RenderedSolidPool.unknownInstanceReason(pose.instanceId) };
      }
      byInstance.set(pose.instanceId, { position: pose.position, quaternion: pose.quaternion });
    }
    return { kind: 'ok', byInstance };
  }

  /**
   * One body per rendered solid in a part file; in an assembly one per
   * instance showing the solid, placed at its world statement pose unless
   * the caller supplied one.
   */
  private static bodies(
    scene: Scene,
    candidates: RenderedCandidate[],
    instances: Map<string, string[]> | null,
    poseOverrides: Map<string, MeasurePose>,
  ): Body[] {
    const out: Body[] = [];
    const statementPoses = scene instanceof AssemblyScene
      ? new Map(scene.getSerializedInstances().map(i => [i.instanceId, { position: i.position, quaternion: i.quaternion }]))
      : new Map<string, MeasurePose>();
    for (const candidate of candidates) {
      const part = scene.findEnclosingPart(candidate.object);
      const address: InterferenceBody = {
        shapeId: candidate.shape.id,
        sceneObjectId: candidate.object.id,
        sceneObjectName: candidate.object.getName(),
        part: part?.partName ?? null,
      };
      if (!instances) {
        out.push({ address, unitKey: part ? `part:${part.id}` : `shape:${candidate.shape.id}`, candidate });
        continue;
      }
      for (const instanceId of instances.get(part?.id ?? '') ?? []) {
        out.push({
          address: { ...address, instanceId },
          unitKey: `instance:${instanceId}`,
          candidate,
          pose: poseOverrides.get(instanceId) ?? statementPoses.get(instanceId),
        });
      }
    }
    return out;
  }

  /** With one named instance only pairs touching it run; with several, the bodies were already narrowed. */
  private static pairEligible(a: Body, b: Body, named: Set<string> | null): boolean {
    if (!named || named.size !== 1) {
      return true;
    }
    return named.has(a.address.instanceId ?? '') || named.has(b.address.instanceId ?? '');
  }

  private static inconclusiveReason(bodies: number, units: number, assembly: boolean): string | null {
    const unitWord = assembly ? 'instance' : 'part';
    if (bodies < 2) {
      return bodies === 0
        ? 'no rendered solid to compare'
        : 'only one rendered solid; interference needs at least two bodies';
    }
    if (units < 2) {
      return `all ${bodies} bodies belong to one ${unitWord}; overlaps inside a ${unitWord} are reported under intraPart and never fail`;
    }
    return null;
  }
}
