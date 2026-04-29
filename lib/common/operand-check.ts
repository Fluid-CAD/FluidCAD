import { SceneObject } from "./scene-object.js";
import { Shape } from "./shape.js";
import { BuildError } from "./build-error.js";

interface RequireShapesOpts {
  /** Require exactly this many shapes. */
  count?: number;
  /** Require every shape to be of this type. */
  type?: string;
}

/**
 * Validate that an operand SceneObject still owns shapes the consumer can use,
 * and produce a uniform diagnostic when it doesn't.
 *
 * The most common failure mode is a SceneObject whose geometry was consumed by
 * an earlier op (e.g. `translate(amount, target)` moves the shape from
 * `target` onto the translate object). `getRemovedShapes()` records who took
 * each shape, so we can name the consumer in the error.
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

  const shapes = obj.getShapes();

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
