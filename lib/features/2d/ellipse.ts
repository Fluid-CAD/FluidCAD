import { Geometry } from "../../oc/geometry.js";
import { BuildError } from "../../common/build-error.js";
import { Vertex } from "../../common/vertex.js";
import { SceneObject } from "../../common/scene-object.js";
import { Point2D } from "../../math/point.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { ExtrudableGeometryBase } from "./extrudable-base.js";
import type { Sketch } from "./sketch.js";
import { StatementAnchors, AnchorPointRef } from "./solved/anchors.js";

export class Ellipse extends ExtrudableGeometryBase {

  private anchors = new StatementAnchors();

  constructor(
    public rx: number,
    public ry: number,
    targetPlane: PlaneObjectBase = null,
    private centerOverride: Point2D | null = null,
  ) {
    super(targetPlane);
  }

  /** Called by the command factory right after addSceneObject: the center
   * registers as a solver point entity, so constraints can target it and
   * the solve positions the ellipse. rx/ry stay literals (fixed shape). */
  register(sk: Sketch): void {
    this.anchors.register(sk, this, [this.centerOverride ?? new Point2D(0, 0)]);
  }

  /** The center — this ellipse's solver anchor point, targetable by
   * constraints, and a lazy vertex anywhere a point is accepted. */
  center(): AnchorPointRef {
    return this.anchors.ref(this, 0, this.generateUniqueName('ref-center'));
  }

  /** Solver identity when this ellipse is a derived-op source or a text
   * path (P8): the radii are literals, so the center vouches alone. */
  anchorSourceEntities(): { ids: number[]; allSolved: boolean } | undefined {
    return this.anchors.registered
      ? { ids: [this.anchors.entityId(0)], allSolved: true }
      : undefined;
  }

  getType() {
    return 'ellipse';
  }

  override validate(): void {
    super.validate();
    // The pen form draws at the sketch cursor — a legacy concept with no
    // meaning in a constraint sketch.
    if (this.enclosingSketch()?.isSolvedMode() && !this.centerOverride && !this.targetPlane) {
      throw new BuildError(
        "ellipse(rx, ry) draws at the sketch cursor, which does not exist in a constraint sketch.",
        "Pass an explicit center: ellipse([x, y], rx, ry).",
      );
    }
  }

  build() {
    if (this.rx <= 0 || this.ry <= 0) {
      throw new Error(`Ellipse radii must be positive (rx=${this.rx}, ry=${this.ry})`);
    }

    const plane = this.targetPlane?.getPlane() || this.sketch.getPlane();
    // The center is a solver point entity when the ellipse lives in a
    // sketch — read the solved position. The literal-center and targetPlane
    // fallbacks survive for ellipses built outside a sketch.
    const center = this.anchors.registered
      ? this.anchors.solvedValues(this)[0]
      : this.centerOverride
        ?? (this.targetPlane
          ? plane.worldToLocal(this.targetPlane.getPlaneCenter())
          : new Point2D(0, 0));

    // OCC requires majorRadius >= minorRadius. Pick which plane axis carries the major.
    const rxIsMajor = this.rx >= this.ry;
    const major = rxIsMajor ? this.rx : this.ry;
    const minor = rxIsMajor ? this.ry : this.rx;
    const majorAxisDir = rxIsMajor ? plane.xDirection : plane.yDirection;

    const edge = Geometry.makeEllipseEdge(
      plane.localToWorld(center),
      major,
      minor,
      plane.normal,
      majorAxisDir,
    );
    edge.setRole('perimeter');

    this.addShape(edge);
    const centerVertex = Vertex.fromPoint(plane.localToWorld(center));
    centerVertex.markAsMetaShape();
    this.addShape(centerVertex);
    // Pen state stays a legacy concept — never written in a solved sketch.
    if (this.sketch && !this.sketch.isSolvedMode()) {
      this.setCurrentPosition(center);
    }

    if (this.targetPlane) {
      this.targetPlane.removeShapes(this);
    }
  }

  override getDependencies(): SceneObject[] {
    return this.targetPlane ? [this.targetPlane] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const targetPlane = this.targetPlane ? (remap.get(this.targetPlane) as PlaneObjectBase || this.targetPlane) : null;
    const copy = new Ellipse(this.rx, this.ry, targetPlane, this.centerOverride);
    this.anchors.copyTo(copy.anchors);
    return copy;
  }

  compareTo(other: this): boolean {
    if (!(other instanceof Ellipse)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.targetPlane?.constructor !== other.targetPlane?.constructor) {
      return false;
    }

    if (this.targetPlane && other.targetPlane && !this.targetPlane.compareTo(other.targetPlane)) {
      return false;
    }

    if (this.rx !== other.rx || this.ry !== other.ry) {
      return false;
    }

    if (!this.anchors.sameAs(other.anchors)) {
      return false;
    }

    if (this.centerOverride && other.centerOverride) {
      return this.centerOverride.x === other.centerOverride.x
        && this.centerOverride.y === other.centerOverride.y;
    }
    return this.centerOverride === other.centerOverride;
  }

  serialize() {
    const solvedCenter = this.anchors.registered ? this.anchors.value(0) : null;
    const center = solvedCenter ?? this.centerOverride;
    return {
      rx: this.rx,
      ry: this.ry,
      ...(center ? { center: { x: center.x, y: center.y } } : {}),
      // Solver join fields (the UI's statement→entity map + the drag
      // write-back's drift guard), present only inside a sketch.
      ...(this.anchors.registered && this.centerOverride
        ? {
          entityId: this.anchors.entityId(0),
          guess: { center: { x: this.centerOverride.x, y: this.centerOverride.y } },
        }
        : {}),
    };
  }
}
