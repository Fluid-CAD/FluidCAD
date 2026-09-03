import { Quaternion, Vector3 } from 'three';

/** Frame attached to a body, expressed in the body's local coordinates. */
export type ConnectorState = {
  connectorId: string;
  localOrigin: Vector3;
  localXDirection: Vector3;
  localNormal: Vector3;
};

/**
 * Canonical-parametrization extents of a contact entity (computed lib-side
 * at classification time — see lib/oc/contact-classify.ts for the exact
 * frame conventions per form). Angular intervals spanning ≥ 2π mean the
 * full revolution.
 */
export type ContactBounds = { uMin: number; uMax: number; vMin?: number; vMax?: number };

export type ContactForm = 'plane' | 'cylinder' | 'sphere' | 'cone' | 'line' | 'circle';

/**
 * Plain-JS canonical contact geometry in BODY-LOCAL frame — everything a
 * tangent residual needs, no OCCT. World placement comes from the body
 * pose at evaluation time, same as connector frames.
 */
export type ContactEntity = {
  form: ContactForm;
  /** Plane point / axis point / sphere-circle center / cone APEX. */
  point: [number, number, number];
  /** Plane outward normal / axis direction / circle-plane normal (unit). */
  dir: [number, number, number];
  /** Reference direction the bounds are measured from (unit, ⊥ dir). */
  xDir?: [number, number, number];
  radius?: number;
  halfAngleDeg?: number;
  /** Material side: shaft/boss = true, bore/pocket = false (planes/edges: true). */
  convex: boolean;
  bounds?: ContactBounds;
};

/**
 * One exposure published by the body's part (`expose('name', …)`), with its
 * classified contact geometry. `seed: null` marks an unsupported surface
 * form — a tangent mate referencing it is unenforceable and reported failed.
 */
export type ContactState = {
  exposeName: string;
  seed: ContactEntity | null;
  /** Tangent-propagation set, seed first; [] when the seed is unsupported. */
  chain: ContactEntity[];
};

/** One rigid body in the solver. Pose is in world space. */
export type BodyState = {
  instanceId: string;
  position: Vector3;
  quaternion: Quaternion;
  grounded: boolean;
  connectors: ConnectorState[];
  /** Classified exposures, present when the part publishes geometry (tangent mates resolve through these). */
  contacts?: ContactState[];
  /**
   * Set by the warm-start when the body's orientation is fully determined
   * by its driver (a follower whose quaternion the warm-start has already
   * computed). It is not counted as a free DOF, and the post-solve fixup
   * re-derives it from the solved driver pose.
   */
  lockOrientation?: boolean;
  /**
   * Set by the warm-start when the body's origin is also fully determined
   * by its driver (a follower whose full pose — origin + orientation — the
   * warm-start has computed). The body isn't moved by the solve, and a
   * post-solve fixup writes its pose from the solved driver pose.
   */
  lockPosition?: boolean;
};

/**
 * One mate between two bodies. Every type except 'tangent' is authored on
 * connectors (connectorA/B set); 'tangent' is authored on exposed geometry
 * (geometryA/B set) and resolves each side's contact chain through
 * `BodyState.contacts` by exposure name.
 */
/**
 * A tangent mate side. `seed`/`chain` are normally resolved through the
 * body's published `contacts` by exposure name; the mate dialog's
 * PROVISIONAL record instead carries them INLINE (`seed` set) — the picked
 * geometry's exposure may not exist in the source yet (17-mate-tangent
 * §7.3).
 */
export type MateGeometrySide = {
  instanceId: string;
  exposeName: string;
  seed?: ContactEntity | null;
  chain?: ContactEntity[];
};

export type MateRecord = {
  mateId: string;
  type: 'fastened' | 'revolute' | 'slider' | 'cylindrical' | 'planar' | 'parallel' | 'pin-slot' | 'tangent';
  connectorA?: { instanceId: string; connectorId: string };
  connectorB?: { instanceId: string; connectorId: string };
  geometryA?: MateGeometrySide;
  geometryB?: MateGeometrySide;
  options?: {
    rotate?: number;
    flip?: boolean;
    offset?: [number, number, number];
    limits?: [number, number];
    /** Tangent only: false restricts contact to the picked seed (`.noPropagate()`). Absent = on. */
    propagate?: boolean;
  };
};

/** The two body-side references of a mate, connector- or geometry-authored. */
export function mateSideIds(mate: MateRecord): { aId: string; bId: string } | null {
  if (mate.connectorA && mate.connectorB) {
    return { aId: mate.connectorA.instanceId, bId: mate.connectorB.instanceId };
  }
  if (mate.geometryA && mate.geometryB) {
    return { aId: mate.geometryA.instanceId, bId: mate.geometryB.instanceId };
  }
  return null;
}

export type SolverInput = {
  bodies: BodyState[];
  mates: MateRecord[];
  /** When set, the solver translates this body so its origin tracks `draggedTargetOrigin`. */
  draggedInstanceId?: string;
  /**
   * World-space target for the dragged body's origin. Caller is responsible
   * for converting "cursor world point" to "body origin" using a grab offset
   * captured at drag-start (`origin_start - grab_start`); the solver does
   * not re-derive it. This avoids the offset drifting as the body moves
   * across successive solves.
   *
   * Used to translate a dragged free body (one with no mates). Mate-aware
   * drag handlers use `draggedCursorWorld` + `draggedGrabLocal` instead —
   * see those fields for why.
   */
  draggedTargetOrigin?: Vector3;
  /**
   * Raw cursor world position on the drag plane. JS-side mate handlers
   * (warm-start) read this together with `draggedGrabLocal` so the
   * rotation they apply makes the *grab point* track the cursor.
   *
   * Why not just `draggedTargetOrigin`? Because deriving rotation from
   * body-origin motion produces the wrong sign whenever the grab is on
   * the opposite side of the pivot from the body origin. Using the
   * grab point's world position as the "from" of the rotation arc is
   * the only formulation that's sign-correct everywhere.
   */
  draggedCursorWorld?: Vector3;
  /**
   * The grabbed point in the dragged body's *local* frame, captured at
   * drag-start. Combined with the body's live pose this gives the
   * grab point's current world position, which mate-aware drag handlers
   * use as the "from" of the rotation arc.
   */
  draggedGrabLocal?: Vector3;
  /**
   * A kinematic driver: hold this slider/revolute mate's free parameter
   * at `value` (authored-space degrees / mm — the readout's number) for
   * this solve. The warm-start poses the follower there and the loop
   * relaxation drops the parameter from its variables, so closures and
   * contacts are solved AROUND the driven joint instead of moving it.
   * Ignored when the mate is a closure edge (nothing to hold).
   */
  drivenJoint?: DrivenJoint;
};

export type DrivenJoint = { mateId: string; value: number };

export type SolverResult = 'okay' | 'inconsistent' | 'didnt-converge' | 'too-many-unknowns';

export type SolvedBody = {
  instanceId: string;
  position: Vector3;
  quaternion: Quaternion;
};

export type WorldAxis = 'x' | 'y' | 'z';

/**
 * One failing mate, measured at the solver's OUTPUT poses (see
 * mate-gap.ts). `gap` is the connector-origin misclosure along the mate's
 * constrained directions in the document length unit; `gapAxis` names the
 * world axis it runs along when it is essentially axis-aligned; `tiltDeg`
 * is the orientation error in degrees.
 */
export type MateFailure = {
  mateId: string;
  gap: number;
  gapAxis: WorldAxis | null;
  tiltDeg: number;
};

export type SolverOutput = {
  bodies: SolvedBody[];
  result: SolverResult;
  dof: number;
  /** Ids of every mate whose residual exceeds the consistency threshold. */
  failed: string[];
  /** The same mates with their measured misclosure, same order as `failed`. */
  failures: MateFailure[];
};
