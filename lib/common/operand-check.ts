import { SceneObject } from "./scene-object.js";
import { Shape, ShapeFilter } from "./shape.js";
import { BuildError } from "./build-error.js";
import { liveOperandShapes } from "../helpers/live-solids.js";

interface RequireShapesOpts {
  /** Require exactly this many shapes. */
  count?: number;
  /** Require every shape to be of this type. */
  type?: string;
  /** Shape filter — pass { excludeGuide: false } when the consumer's build also reads guide shapes. */
  filter?: ShapeFilter;
}

/**
 * Validate that an operand SceneObject still owns shapes the consumer can use,
 * and produce a uniform diagnostic when it doesn't.
 *
 * A solid an earlier op took from the operand counts as owned while that op
 * made something of it: `translate(amount, target)` moves the body onto the
 * translate object, a fillet rebuilds it, a boss fuses it — and a consumer
 * reading the operand gets the body as those features left it (see
 * `liveOperandShapes`). Only a body nothing stands for any more — cut away,
 * or taken by `remove()` — fails here. `getRemovedShapes()` records who took
 * each shape, so the error names that consumer.
 */
export function requireShapes(
  obj: SceneObject,
  operandLabel: string,
  consumerType: string,
  opts?: RequireShapesOpts,
): Shape[] {
  // Lazy operands (LazySelectionSceneObject, LazyVertex) only populate their
  // shapes during build. Their pre-build emptiness is expected, so skip —
  // the build itself still validates them.
  if (obj.isLazy()) {
    return [];
  }

  const shapes = liveOperandShapes(obj, opts?.filter).map(entry => entry.shape);

  if (shapes.length === 0) {
    const removed = obj.getRemovedShapes();
    const objLabel = `${operandLabel} (${obj.getType()})`;
    if (removed.length > 0) {
      const consumers = [...new Set(removed.map(r => r.removedBy.getType()))].join(", ");
      throw new BuildError(
        `${consumerType}: ${objLabel} has no shapes — its geometry was consumed by ${consumers}.`,
        `Reference the result of ${consumers} as the operand instead of ${obj.getType()}.`,
      );
    }
    throw new BuildError(
      `${consumerType}: ${objLabel} has no shapes.`,
      `Make sure the upstream operation produced geometry.`,
    );
  }

  if (opts?.count !== undefined && shapes.length !== opts.count) {
    throw new BuildError(
      `${consumerType}: ${operandLabel} has ${shapes.length} shapes, expected ${opts.count}.`,
    );
  }

  if (opts?.type) {
    const wrong = shapes.find(s => s.getType() !== opts.type);
    if (wrong) {
      throw new BuildError(
        `${consumerType}: ${operandLabel} has a shape of type '${wrong.getType()}', expected '${opts.type}'.`,
      );
    }
  }

  return shapes;
}
