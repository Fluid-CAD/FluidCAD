import { Geometry } from "../../oc/geometry.js";
import { Vertex } from "../../common/vertex.js";
import { SceneObject } from "../../common/scene-object.js";
import { Point2D } from "../../math/point.js";
import { ExtrudableGeometryBase } from "./extrudable-base.js";
import type { Sketch } from "./sketch.js";
import { StatementAnchors, AnchorPointRef } from "./solved/anchors.js";

export class Ellipse extends ExtrudableGeometryBase {

  private anchors = new StatementAnchors();

  constructor(
    public rx: number,
    public ry: number,
    private centerOverride: Point2D | null = null,
  ) {
    super();
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

  build() {
    if (this.rx <= 0 || this.ry <= 0) {
      throw new Error(`Ellipse radii must be positive (rx=${this.rx}, ry=${this.ry})`);
    }

    const plane = this.sketch.getPlane();
    // The center is a solver point entity when the ellipse lives in a
    // sketch — read the solved position. The literal-center fallback
    // survives for ellipses built outside a sketch; with neither, the
    // ellipse sits at the plane origin.
    const center = this.anchors.registered
      ? this.anchors.solvedValues(this)[0]
      : this.centerOverride ?? new Point2D(0, 0);

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
  }

  override getDependencies(): SceneObject[] {
    return [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = new Ellipse(this.rx, this.ry, this.centerOverride);
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
