import { Geometry } from "../../oc/geometry.js";
import { Vertex } from "../../common/vertex.js";
import { SceneObject } from "../../common/scene-object.js";
import { Edge } from "../../common/edge.js";
import { Wire } from "../../common/wire.js";
import { Plane } from "../../math/plane.js";
import { Point2D } from "../../math/point.js";
import { Extrudable } from "../../helpers/types.js";
import { IEllipse } from "../../core/interfaces.js";
import { GeometrySceneObject } from "./geometry.js";
import { SketchSolverContext } from "./solved/solver-context.js";
import { SolvedGeometryBase, SolvedPointRole } from "./solved/solved-base.js";
import { SolvedPointRef } from "./solved/refs.js";
import type { EntityKind } from "../../sketch-solver/index.js";

const DEG = Math.PI / 180;

/**
 * A solved ellipse: a solver entity [cx, cy, rx, ry, θ] the constraints
 * drive — the semi-radii like a circle's diameter (guesses until a
 * `radius(el, v, 'x' | 'y')` dimensions them), θ the rotation of the RX
 * axis from the sketch x direction (the statement's `rotation` in degrees
 * is its guess, like the center literal is the position's).
 */
export class Ellipse extends SolvedGeometryBase implements Extrudable, IEllipse {

  constructor(
    private centerGuess: Point2D,
    /** Semi-radius guesses along the ellipse's RX / RY axes. */
    private rxGuess: number,
    private ryGuess: number,
    /** Rotation guess in degrees; null when the statement gave none (0). */
    private rotationGuess: number | null = null,
  ) {
    super();
  }

  get solverKind(): EntityKind {
    return 'ellipse';
  }

  protected registerInto(ctx: SketchSolverContext): number {
    return ctx.addEllipse(
      this,
      this.centerGuess.x, this.centerGuess.y,
      this.rxGuess, this.ryGuess,
      (this.rotationGuess ?? 0) * DEG,
    );
  }

  pointValue(role: SolvedPointRole): Point2D {
    if (role !== 'center') {
      throw new Error(`ellipse has no '${role}' point`);
    }
    const [cx, cy] = this.requireContext().entityParams(this.entityId);
    return new Point2D(cx, cy);
  }

  /** The center — targetable by constraints, and a lazy vertex anywhere a
   * point is accepted. */
  center(): SolvedPointRef {
    return this.pointRef('center');
  }

  getType() {
    return 'ellipse';
  }

  getUniqueType(): string {
    return 'solved-ellipse';
  }

  build() {
    if (this.rxGuess <= 0 || this.ryGuess <= 0) {
      throw new Error(`Ellipse radii must be positive (rx=${this.rxGuess}, ry=${this.ryGuess})`);
    }

    const [cx, cy, rx, ry, theta] = this.solvedParams();
    if (rx <= 0 || ry <= 0) {
      throw new Error(`Ellipse radii solved to a non-positive size (rx=${rx}, ry=${ry}) — check the dimensions on it`);
    }
    const plane = this.sketch.getPlane();
    const center = new Point2D(cx, cy);
    const worldCenter = plane.localToWorld(center);

    // The ellipse's own axes in world space: u carries RX, v carries RY.
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const u = plane.xDirection.multiply(c).add(plane.yDirection.multiply(s));
    const v = plane.xDirection.multiply(-s).add(plane.yDirection.multiply(c));

    // OCC requires majorRadius >= minorRadius: pick which axis carries the major.
    const rxIsMajor = rx >= ry;
    const edge = Geometry.makeEllipseEdge(
      worldCenter,
      rxIsMajor ? rx : ry,
      rxIsMajor ? ry : rx,
      plane.normal,
      rxIsMajor ? u : v,
    );
    edge.setRole('perimeter');
    this.addShape(edge);

    const centerVertex = Vertex.fromPoint(worldCenter);
    centerVertex.markAsMetaShape();
    this.addShape(centerVertex);

    this.setState('solved', { center: { x: cx, y: cy }, rx, ry, rotation: theta / DEG });
  }

  isExtrudable(): boolean {
    return true;
  }

  getGeometries(): Edge[] {
    return this.getShapes() as Edge[];
  }

  getGeometriesWithOwner(): Map<Wire | Edge, GeometrySceneObject> {
    const geometries = new Map<Wire | Edge, GeometrySceneObject>();
    for (const shape of this.getShapes()) {
      if (shape instanceof Edge) {
        geometries.set(shape, this);
      }
    }
    return geometries;
  }

  getPlane(): Plane {
    return this.sketch.getPlane();
  }

  override getDependencies(): SceneObject[] {
    return [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = new Ellipse(this.centerGuess, this.rxGuess, this.ryGuess, this.rotationGuess);
    this.copySolvedStateTo(copy);
    return copy;
  }

  compareTo(other: this): boolean {
    if (!(other instanceof Ellipse)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    return this.rxGuess === other.rxGuess
      && this.ryGuess === other.ryGuess
      && this.rotationGuess === other.rotationGuess
      && this.centerGuess.x === other.centerGuess.x
      && this.centerGuess.y === other.centerGuess.y
      && this.compareSolvedTo(other);
  }

  serialize() {
    const solved = this.getState('solved') as
      { center: { x: number; y: number }; rx: number; ry: number; rotation: number } | undefined;
    return {
      entityId: this.entityId,
      /** Solved semi-radii along the RX / RY axes. */
      rx: solved?.rx ?? this.rxGuess,
      ry: solved?.ry ?? this.ryGuess,
      center: solved?.center ?? { x: this.centerGuess.x, y: this.centerGuess.y },
      /** Solved rotation of the RX axis from the sketch x direction, degrees. */
      rotation: solved?.rotation ?? this.rotationGuess ?? 0,
      // Statement-time argument values: the drag write-back drift-guards its
      // literal splices against these (P4). `rotation` is present only when
      // the statement carries the 4th argument — its absence tells the
      // write-back to append one.
      guess: {
        center: { x: this.centerGuess.x, y: this.centerGuess.y },
        rx: this.rxGuess,
        ry: this.ryGuess,
        ...(this.rotationGuess !== null ? { rotation: this.rotationGuess } : {}),
      },
    };
  }
}
