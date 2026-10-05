// The handle Offset.edge(i) returns: still the lazy single-edge selection the
// uniform `edge(i)` accessor gives every sketch geometry (offset/fillet
// operands keep working), but ALSO a point source — .start()/.end() name the
// edge's endpoints along the offset walk and .center() an arc's center, as
// sketch point references modeled on the Copy2DInstance/Copy2DInstancePointRef
// pair. An offset edge has no solver identity, so these points serve consumers
// outside the sketch (loft connections, connectors), never constraints.

import { LazySelectionSceneObject } from "../lazy-scene-object.js";
import { SketchPointVertex } from "../sketch-point-ref.js";
import type { SceneObject } from "../../common/scene-object.js";
import type { Plane } from "../../math/plane.js";
import type { Offset } from "./offset.js";

export type OffsetEdgeRole = 'start' | 'end' | 'center';

export class OffsetEdge extends LazySelectionSceneObject {

  constructor(
    private readonly edgeName: string,
    readonly offsetOwner: Offset,
    readonly index: number,
  ) {
    super(edgeName, (parent) => (parent as Offset).edgeShapes(index), offsetOwner);
  }

  start(): OffsetEdgePointRef {
    return new OffsetEdgePointRef(this, 'start');
  }

  end(): OffsetEdgePointRef {
    return new OffsetEdgePointRef(this, 'end');
  }

  center(): OffsetEdgePointRef {
    return new OffsetEdgePointRef(this, 'center');
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const owner = (remap.get(this.offsetOwner) as Offset | undefined) ?? this.offsetOwner;
    return new OffsetEdge(this.edgeName, owner, this.index);
  }
}

/**
 * A named point of an offset edge (`o.edge(2).start()`). The edge is world
 * geometry on the offset's plane, so the point reads the built edge and maps
 * it into the plane for the shared sketch-point contract; identity is
 * (offset statement, edge index, role).
 */
export class OffsetEdgePointRef extends SketchPointVertex {
  constructor(
    readonly edge: OffsetEdge,
    readonly role: OffsetEdgeRole,
  ) {
    super(edge.offsetOwner, role, `offset-edge-${edge.index}-${role}`,
      () => edge.offsetOwner.getPlane().worldToLocal(edge.offsetOwner.edgePoint(edge.index, role)));
  }

  get edgeIndex(): number {
    return this.edge.index;
  }

  /** A face-target offset has no sketch: the plane is the offset's own. */
  override getPlane(): Plane | null {
    return this.edge.offsetOwner.getPlane();
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const edge = (remap.get(this.edge) ?? this.edge.createCopy(remap)) as OffsetEdge;
    return new OffsetEdgePointRef(edge, this.role);
  }

  override compareTo(other: SketchPointVertex): boolean {
    return other instanceof OffsetEdgePointRef
      && this.edgeIndex === other.edgeIndex
      && super.compareTo(other);
  }

  override serialize() {
    return { ...super.serialize(), edgeIndex: this.edgeIndex };
  }
}
