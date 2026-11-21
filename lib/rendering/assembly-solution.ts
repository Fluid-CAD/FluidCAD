import type { AssemblyScene } from "./assembly-scene.js";
import type { Part } from "../features/part.js";
import type { Pose } from "../math/pose.js";
import { describeError } from "../common/describe-error.js";
import { AssemblySolverModel, Solver, mateReadoutValue, unwrapAngleToLimits } from "../assembly-solver/index.js";
import type {
  BodyState,
  ConnectorFrame,
  ExposureContact,
  MateRecord,
  PartMateGeometry,
  SolverInput,
  SolverOutput,
  WorldAxis,
} from "../assembly-solver/index.js";

/** One instance's world pose. */
export type AssemblyInstancePose = Pose & { instanceId: string };

/**
 * How one mate came out of the solve.
 * - `satisfied`: it holds at the solved poses.
 * - `failed`: it does not — the assembly cannot close it. `gap`, `gapAxis`
 *   and `tiltDeg` measure by how much.
 * - `unenforced`: it never reached the solve — a side names a connector that
 *   did not build, or exposed geometry of a form a tangent mate cannot use.
 *   It constrains nothing.
 */
export type AssemblyMateStatus = 'satisfied' | 'failed' | 'unenforced';

export type AssemblyMateState = {
  mateId: string;
  status: AssemblyMateStatus;
  /**
   * Where the joint sits in the solved configuration: a revolute's angle in
   * degrees, a slider's travel in the document unit — the quantity, and the
   * sign, its `.limits()` clamp (an angle is on the turn its limits are on,
   * so a hinge limited to 190…300° reads 200, not -160). Absent for every
   * other mate type and for a mate that is not enforced.
   */
  value?: number;
  /**
   * Present (true) when the solve left the joint outside its `.limits()`:
   * the mate's geometry holds, its range does not. The solver moves a joint
   * into its range when it can — this is the case where it cannot, because
   * nothing is free to move (both parts fixed) or the limits of joints that
   * move together (a relation, a closed loop) cannot all hold at once.
   */
  outsideLimits?: true;
  /** Failed mates: the connector-origin misclosure along the mate's constrained directions, in the document unit. */
  gap?: number;
  /** Failed mates: the world axis the gap runs along, when it is essentially axis-aligned. */
  gapAxis?: WorldAxis;
  /** Failed mates: the orientation error in degrees. */
  tiltDeg?: number;
};

/**
 * How one relation came out of the solve.
 * - `satisfied`: its two mates moved in ratio.
 * - `failed`: they did not — a limit, a fastened part or a closed loop held
 *   one side back.
 * - `contradicted`: its ratio disagrees with the other relations around a
 *   cycle of them, so the solve dropped it — an authoring error.
 * - `unenforced`: it never reached the solve — a mate it couples is missing,
 *   unenforced, or has no motion of the kind the relation needs.
 */
export type AssemblyRelationStatus = 'satisfied' | 'failed' | 'contradicted' | 'unenforced';

export type AssemblyRelationState = {
  relationId: string;
  status: AssemblyRelationStatus;
};

/**
 * Where an assembly's mates put its parts.
 *
 * The solve starts every instance at its statement pose — the `insert()`
 * chain's `.translate()` / `.rotate()` — and runs the mate solver once: the
 * configuration a viewer shows when it opens the file, computed by the same
 * code with the same input. An assembly with free motion left (`dof` above
 * zero) has many valid configurations; this is the one that solve lands on,
 * not wherever a user has since dragged a part or the Animate bar has driven
 * a joint — that lives only in their viewer.
 */
export type AssemblySolution = {
  /**
   * `okay`: every enforced mate and relation holds. `inconsistent`: at
   * least one does not — the poses are the solver's least-bad configuration.
   * `unsolved`: the solve could not run (`error` says why); the poses are
   * the statement poses.
   */
  status: 'okay' | 'inconsistent' | 'unsolved';
  /** What `poses` holds: the solve's result, or — when it could not run — the statement poses. */
  posesSource: 'solved' | 'statement';
  /** One world pose per instance, in the scene's instance order. */
  poses: AssemblyInstancePose[];
  /** The degrees of freedom the mates leave the assembly; null when the solve could not run. */
  dof: number | null;
  /** Every mate, in statement order; empty when the solve could not run. */
  mates: AssemblyMateState[];
  /** Every relation, in statement order; empty when the solve could not run. */
  relations: AssemblyRelationState[];
  /** `unsolved` only: what stopped the solve. */
  error?: string;
};

/**
 * Solves an assembly scene's mates the way a viewer does.
 *
 * The solver's input is built by {@link AssemblySolverModel} from the same
 * records a render hands the viewer — instances at their world statement
 * poses, mates, relations, the assembly's connectors and each part's
 * connector frames and classified exposures — so the two cannot disagree
 * about what is solved. Ask a scene for its solution through
 * {@link AssemblyScene.getSolution}, which keeps it for the render's life.
 */
export class AssemblySolutionBuilder {
  static build(scene: AssemblyScene): AssemblySolution {
    const instances = scene.getSerializedInstances();
    const mates = scene.getSerializedMates();
    const relations = scene.getSerializedRelations();
    const statementPoses: AssemblyInstancePose[] = instances.map(inst => ({
      instanceId: inst.instanceId,
      position: inst.position,
      quaternion: inst.quaternion,
    }));

    let input: SolverInput;
    let output: SolverOutput;
    try {
      const parts = new Map<string, Part>();
      for (const instance of scene.getInstances()) {
        parts.set(instance.part.id, instance.part);
      }
      const model = new AssemblySolverModel({
        instances,
        mates,
        relations,
        connectors: scene.getSerializedAssemblyConnectors(),
        partGeometry: (partId) => {
          const part = parts.get(partId);
          return part ? AssemblySolutionBuilder.partGeometry(part) : null;
        },
      });
      input = model.input();
      output = new Solver().solve(input);
    } catch (error) {
      return AssemblySolutionBuilder.unsolved(statementPoses, describeError(error));
    }
    // The poses of any other result are not a configuration to stand on —
    // a viewer keeps the poses it had rather than apply them.
    if (output.result !== 'okay' && output.result !== 'inconsistent') {
      return AssemblySolutionBuilder.unsolved(statementPoses, `the mate solver stopped with "${output.result}"`);
    }

    const solved = new Map(output.bodies.map(body => [body.instanceId, body]));
    const poses = statementPoses.map((statement) => {
      const body = solved.get(statement.instanceId);
      if (!body) {
        return statement;
      }
      return {
        instanceId: statement.instanceId,
        position: { x: body.position.x, y: body.position.y, z: body.position.z },
        quaternion: { x: body.quaternion.x, y: body.quaternion.y, z: body.quaternion.z, w: body.quaternion.w },
      };
    });

    return {
      status: output.result,
      posesSource: 'solved',
      poses,
      dof: output.dof,
      mates: AssemblySolutionBuilder.mateStates(input, output),
      relations: AssemblySolutionBuilder.relationStates(relations.map(r => r.relationId), output),
    };
  }

  /**
   * What a part gives every instance of it: the frame of each connector it
   * carries (its own and their copies) and its exposures. A connector whose
   * build failed has no frame and is left out, so a mate naming it comes
   * back `unenforced`.
   */
  private static partGeometry(part: Part): PartMateGeometry {
    const connectors: ConnectorFrame[] = [];
    for (const connector of part.getConnectors()) {
      const data = connector.serialize();
      if (!('origin' in data) || !data.origin || !data.xDirection || !data.normal) {
        continue;
      }
      connectors.push({
        connectorId: connector.id,
        origin: data.origin,
        xDirection: data.xDirection,
        normal: data.normal,
      });
    }
    const exposures: ExposureContact[] = part.getExposed().map(exposed => exposed.serialize());
    return { connectors, exposures };
  }

  private static mateStates(input: SolverInput, output: SolverOutput): AssemblyMateState[] {
    const failures = new Map(output.failures.map(failure => [failure.mateId, failure]));
    const unenforced = new Set(output.unenforced);
    const solved = new Map(output.bodies.map(body => [body.instanceId, body]));
    const atOutput = new Map<string, BodyState>();
    for (const body of input.bodies) {
      const pose = solved.get(body.instanceId);
      if (pose) {
        atOutput.set(body.instanceId, { ...body, position: pose.position, quaternion: pose.quaternion });
      }
    }
    return input.mates.map((mate) => {
      if (unenforced.has(mate.mateId)) {
        return { mateId: mate.mateId, status: 'unenforced' };
      }
      const value = AssemblySolutionBuilder.jointValue(mate, atOutput);
      const joint = {
        ...(value !== null ? { value } : {}),
        ...(value !== null && AssemblySolutionBuilder.outsideLimits(value, mate.options?.limits)
          ? { outsideLimits: true as const }
          : {}),
      };
      const failure = failures.get(mate.mateId);
      if (!failure) {
        return { mateId: mate.mateId, status: 'satisfied', ...joint };
      }
      return {
        mateId: mate.mateId,
        status: 'failed',
        ...joint,
        gap: failure.gap,
        ...(failure.gapAxis ? { gapAxis: failure.gapAxis } : {}),
        tiltDeg: failure.tiltDeg,
      };
    });
  }

  /**
   * How far past a bound a joint's value may read and still count as on it:
   * the solver clamps a joint exactly onto its limit, and measuring it back
   * off the poses leaves float noise far below this.
   */
  private static readonly LIMIT_TOLERANCE = 1e-6;

  private static outsideLimits(value: number, limits: [number, number] | undefined): boolean {
    if (!limits) {
      return false;
    }
    const tolerance = AssemblySolutionBuilder.LIMIT_TOLERANCE;
    return value < limits[0] - tolerance || value > limits[1] + tolerance;
  }

  /**
   * A revolute's angle or a slider's travel at the solved poses, measured
   * from the mate's first side — the authored space its limits are in. A
   * limited angle is reported on the turn its limits are on, the branch the
   * solver clamps it on.
   */
  private static jointValue(mate: MateRecord, bodies: Map<string, BodyState>): number | null {
    if (!mate.connectorA || !mate.connectorB) {
      return null;
    }
    const a = bodies.get(mate.connectorA.instanceId);
    const b = bodies.get(mate.connectorB.instanceId);
    const aConnector = a?.connectors.find(c => c.connectorId === mate.connectorA.connectorId);
    const bConnector = b?.connectors.find(c => c.connectorId === mate.connectorB.connectorId);
    if (!a || !b || !aConnector || !bConnector) {
      return null;
    }
    const readout = mateReadoutValue(mate, a, aConnector, b, bConnector);
    if (!readout) {
      return null;
    }
    const limits = mate.options?.limits;
    return readout.kind === 'angle' && limits ? unwrapAngleToLimits(readout.value, limits) : readout.value;
  }

  private static relationStates(relationIds: string[], output: SolverOutput): AssemblyRelationState[] {
    const contradicted = new Set(output.contradictedRelations);
    const failed = new Set(output.failedRelations);
    const unenforced = new Set(output.unenforcedRelations);
    return relationIds.map((relationId) => {
      if (unenforced.has(relationId)) {
        return { relationId, status: 'unenforced' };
      }
      if (contradicted.has(relationId)) {
        return { relationId, status: 'contradicted' };
      }
      return { relationId, status: failed.has(relationId) ? 'failed' : 'satisfied' };
    });
  }

  /** The solution of a solve that could not run: the statement poses, nothing known about the joints. */
  private static unsolved(statementPoses: AssemblyInstancePose[], error: string): AssemblySolution {
    return {
      status: 'unsolved',
      posesSource: 'statement',
      poses: statementPoses,
      dof: null,
      mates: [],
      relations: [],
      error,
    };
  }
}
