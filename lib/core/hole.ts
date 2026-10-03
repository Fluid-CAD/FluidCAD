import { registerBuilder, SceneParserContext } from "../index.js";
import { Hole, isHolePlacement, type HolePlacement } from "../features/hole/hole.js";
import { IConnector, IGeometry, IHole } from "./interfaces.js";
import { type NumberParam, isNumberParam, resolveParam } from "./param.js";
import type { LazyVertex } from "../features/lazy-vertex.js";

/**
 * Where a hole starts: a connector (the hole follows its Z), a sketch point
 * exported from a sketch (`s.geometries.c.center()`, `s.geometries.p` for a
 * `point()` entity) or an anchored vertex on a solid (`e.endFaces().center()`).
 */
export type HolePlacementLike = IConnector | LazyVertex | IGeometry;

interface HoleFunction {
  /**
   * Cuts a drilled hole of the given diameter at each placement, through all
   * the solids in scope. Chain `.depth(d[, tipAngle])` for a blind hole,
   * `.counterbore(diameter, depth)` or `.countersink(diameter, angle)` for the
   * entry, and `.scope(...)` to restrict which solids are cut.
   * @param diameter - The hole diameter
   * @param placements - One or more connectors, sketch points or anchored vertices
   */
  (diameter: NumberParam, ...placements: HolePlacementLike[]): IHole;

  /**
   * Cuts a fastener hole for the given size ('M6', 'M2.5', '1/4', '#10') at
   * each placement. The diameter comes from the standard tables: a clearance
   * hole (`.clearance('close' | 'normal' | 'loose')`, normal fit by default)
   * or a tap drill (`.tapped()` for the coarse pitch, `.tapped(0.75)` for a
   * fine one). `.counterbore()` and `.countersink()` without values read the
   * socket-head and flat-head tables for that size. `.fasten()` on a
   * clearance hole cuts the matching tapped hole into the next solid along
   * the hole axis, the one the fastener threads into. Threads are not modelled
   * yet; the size and pitch stay in the statement for a later thread feature.
   * @param size - A metric or inch fastener size label
   * @param placements - One or more connectors, sketch points or anchored vertices
   */
  (size: string, ...placements: HolePlacementLike[]): IHole;
}

function build(context: SceneParserContext): HoleFunction {
  return function hole(size: NumberParam | string, ...placements: HolePlacementLike[]): IHole {
    let resolvedSize: number | string;
    if (typeof size === 'string') {
      resolvedSize = size;
    } else if (isNumberParam(size)) {
      resolvedSize = resolveParam(size);
    } else {
      throw new Error("hole(): the first argument is the hole size — a diameter, or a fastener size like 'M6'");
    }
    if (placements.length === 0) {
      throw new Error("hole() needs at least one placement — a connector, a sketch point such as s.geometries.c.center(), or a face/edge anchor such as e.endFaces().center()");
    }
    for (const placement of placements) {
      if (!isHolePlacement(placement)) {
        throw new Error("hole(): placements must be connectors, sketch points (s.geometries.c.center()) or anchored vertices (e.endFaces().center())");
      }
      // A lazy point made for this call (an anchor over an inline selection,
      // a sketch point ref) is registered nowhere else — it and what it
      // resolves through must be in the scene to build before the hole.
      // addSceneObject is idempotent for connectors and point entities.
      if (placement.isLazy()) {
        for (const dep of placement.getDependencies()) {
          context.addSceneObject(dep);
        }
        context.addSceneObject(placement);
      }
    }
    const result = new Hole(resolvedSize, placements as HolePlacement[]);
    context.addSceneObject(result);
    return result;
  } as HoleFunction;
}

export default registerBuilder(build);
