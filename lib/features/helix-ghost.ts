import { BuildError } from "../common/build-error.js";
import { Shape } from "../common/shape.js";
import { buildHelixEdge, HelixDimensions, HelixSourceKind } from "./helix-geometry.js";

/** The dialog values a ghost helix is built from, all resolved. */
export type HelixGhostOptions = HelixDimensions;

export type HelixGhostWires = {
  /**
   * The curve to mesh: exactly one helix, or none when the values don't
   * describe a curve yet.
   */
  wires: Shape[];
  /** Everything built on the way there; dispose it alongside `wires`. */
  scratch: Shape[];
};

/**
 * Build the ghost curve for a helix — the wire the statement would produce,
 * from a resolved source alone. Unlike the swept features there is no body
 * here at all: a helix IS a curve, so the ghost draws the coil itself, in the
 * blue standalone wires already render in. Nothing is added or removed, which
 * is why it carries no add/remove color.
 *
 * The curve comes straight from `buildHelixEdge`, the same call `Helix.build`
 * makes, so a ghost can't describe geometry the apply won't produce.
 *
 * The kernel's refusals become silence: a helix of zero axial height, a
 * non-positive turn count, an end radius an offset drove through zero — every
 * one is a state the dialog passes through while the user is still typing, so
 * they return no curve rather than an error the panel would flash. A source
 * that can't be read at all (a face that isn't cylindrical) still throws; that
 * is a wrong pick, not an unfinished one.
 *
 * The caller owns disposal: every returned shape must be `dispose()`d once
 * meshed. None of it is reachable from scene state, so `SceneDisposal` never
 * collects it and it would leak per keystroke.
 */
export function buildHelixGhostWires(
  source: HelixSourceKind,
  options: HelixGhostOptions,
): HelixGhostWires {
  try {
    return { wires: [buildHelixEdge(source, options)], scratch: [] };
  } catch (err) {
    if (err instanceof BuildError) {
      return { wires: [], scratch: [] };
    }
    throw err;
  }
}
