import { Point2D } from "../../math/point.js";
import { SceneObject } from "../../common/scene-object.js";
import { GeometrySceneObject } from "./geometry.js";
import { LazyVertex } from "../lazy-vertex.js";

export class Move extends GeometrySceneObject {
  /**
   * Offset from the cursor's current position, for the relative form. Null on
   * an absolute move, where `targetPosition` carries the destination instead.
   */
  readonly delta: Point2D | null;

  constructor(public targetPosition: LazyVertex, delta: Point2D | null = null) {
    super();
    this.delta = delta;
  }

  /**
   * A cursor move by an offset from the current position, mirroring the
   * relative semantics of hMove/vMove/pMove.
   */
  static relative(dx: number, dy: number): Move {
    return new Move(null, new Point2D(dx, dy));
  }

  getType() {
    return 'move';
  }

  override getUniqueType() {
    return this.delta ? 'move-relative' : 'move';
  }

  build() {
    if (this.delta) {
      const pos = this.getCurrentPosition();
      this.setCurrentPosition(new Point2D(pos.x + this.delta.x, pos.y + this.delta.y));
      return;
    }

    this.setCurrentPosition(this.targetPosition.asPoint2D());
  }

  override getDependencies(): SceneObject[] {
    return [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    return new Move(this.targetPosition, this.delta);
  }

  compareTo(other: this): boolean {
    if (!(other instanceof Move)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    // The relative flag is part of the identity: the same numbers land the
    // cursor somewhere different in each mode, so a mode change has to force
    // a rebuild rather than compare equal.
    if ((this.delta === null) !== (other.delta === null)) {
      return false;
    }

    if (this.delta && other.delta) {
      return this.delta.x === other.delta.x && this.delta.y === other.delta.y;
    }

    return this.targetPosition.compareTo(other.targetPosition);
  }

  serialize() {
    if (this.delta) {
      // A relative move has no authored point, so report where the cursor
      // actually landed — the payload always describes a resolved position.
      return {
        position: this.getState('current-position') ?? null,
        relative: { dx: this.delta.x, dy: this.delta.y },
      };
    }

    return {
      position: this.targetPosition
    }
  }

}
