import { Scene } from "../rendering/scene.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import { ShapeInterference } from "../oc/shape-interference.js";
import type { WorldBounds } from "../oc/shape-interference.js";
import { EntitySummaryBuilder } from "../oc/measure/entity-summary.js";
import { RenderedSolidPool } from "./rendered-pool.js";

/**
 * The overall bounds of what a scene renders: the union of the exact
 * (`Bnd_Box`, not triangulation) bounds of every solid of the default pool
 * ({@link RenderedSolidPool}) — so a solid a later cut consumed or a
 * rollback hid is not counted. In an assembly each solid is bounded once
 * per instance showing it, where the mates put that instance
 * (`AssemblyScene.getPlacedPoses`), the way `interfere` places its bodies.
 */
export class SceneBounds {

  /** The bounds in the scene's unit, rounded to its meaningful precision; null when the scene renders no solid. */
  static of(scene: Scene): WorldBounds | null {
    const instances = RenderedSolidPool.instancesByPartId(scene);
    const poses = scene instanceof AssemblyScene ? scene.getPlacedPoses() : null;
    let union: WorldBounds | null = null;
    const add = (bounds: WorldBounds) => {
      if (!bounds.min.every(Number.isFinite) || !bounds.max.every(Number.isFinite)) {
        return;
      }
      if (!union) {
        union = { min: [...bounds.min], max: [...bounds.max] };
        return;
      }
      for (let axis = 0; axis < 3; axis++) {
        union.min[axis] = Math.min(union.min[axis], bounds.min[axis]);
        union.max[axis] = Math.max(union.max[axis], bounds.max[axis]);
      }
    };
    for (const candidate of RenderedSolidPool.renderedSolids(scene)) {
      const shape = candidate.shape.getShape();
      if (!instances) {
        add(ShapeInterference.bounds(shape));
        continue;
      }
      const part = scene.findEnclosingPart(candidate.object);
      for (const instanceId of instances.get(part?.id ?? '') ?? []) {
        const posed = ShapeInterference.pose(shape, poses?.get(instanceId));
        try {
          add(posed.bounds);
        } finally {
          posed.dispose();
        }
      }
    }
    if (!union) {
      return null;
    }
    const decimals = EntitySummaryBuilder.decimalsFor(scene.unit);
    const round = (corner: [number, number, number]): [number, number, number] => [
      EntitySummaryBuilder.round(corner[0], decimals),
      EntitySummaryBuilder.round(corner[1], decimals),
      EntitySummaryBuilder.round(corner[2], decimals),
    ];
    const { min, max } = union as WorldBounds;
    return { min: round(min), max: round(max) };
  }
}
