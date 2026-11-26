import type { SceneObject } from "../common/scene-object.js";
import type { Shape } from "../common/shape.js";
import { operandKindError } from "../common/operand-check.js";
import { heldBodiesOf, liveOperandShapes, type HeldShape } from "./live-solids.js";

/**
 * What a move — `translate`, `rotate`, `mirror` — acts on, decided once so
 * the three agree:
 *
 * - no targets (`null`): every body `scope` holds now, solids and surfaces, each
 *   once. Curves stay put: a sketch or a helix is construction the model
 *   is built against, not part of what is being moved.
 * - named targets: each target's bodies wherever the features since left
 *   them (`liveOperandShapes`), and the curves it shows — naming a helix or
 *   a sketch moves it. A curve a feature has used and hidden (a part's
 *   sketch after its extrude) stays: it no longer stands in the model.
 *
 * Meta and guide shapes (a plane's quad, a guide sketch) never move. A named
 * target that holds something else — a face selection, a point — is
 * refused rather than skipped: a move of nothing is never what was meant.
 */
export function transformTargets(
  consumerType: string,
  targets: readonly SceneObject[] | null,
  scope: readonly SceneObject[],
  sceneObjects: readonly SceneObject[],
): HeldShape[] {
  if (targets === null) {
    return heldBodiesOf([...scope])
      .filter(({ body }) => !body.isMetaShape() && !body.isGuideShape())
      .map(({ holder, body }) => ({ holder, shape: body }));
  }

  const shown = new Set(sceneObjects);
  const out: HeldShape[] = [];
  const seen = new Set<Shape>();
  targets.forEach((target, i) => {
    const held = liveOperandShapes(target);
    const visibleCurves = new Set(target.getShapes({}, undefined, shown).filter(isCurve));
    const movable = held.filter(({ shape }) => shape.isBody() || visibleCurves.has(shape));
    if (held.length > 0 && movable.length === 0) {
      const given = target.isSelection() || target.isLazy()
        ? `${held[0].shape.getType()} selection`
        : held[0].shape.getType();
      throw operandKindError(consumerType, `target ${i + 1}`, given, ['solid', 'surface', 'curve']);
    }
    for (const entry of movable) {
      if (!seen.has(entry.shape)) {
        seen.add(entry.shape);
        out.push(entry);
      }
    }
  });
  return out;
}

function isCurve(shape: Shape): boolean {
  return shape.isEdge() || shape.isWire();
}
