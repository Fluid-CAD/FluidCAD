import { Face } from "../common/face.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { ShellJoinType } from "../core/interfaces.js";
import { ColorTransfer } from "../oc/color-transfer.js";
import { ShellOps } from "../oc/shell-ops.js";
import { ShellInterior } from "./shell-interior.js";

/** The dialog values a ghost shell is built from, all resolved. */
export type ShellGhostOptions = {
  /** Wall thickness: negative hollows inward, positive builds the wall outside the solid. */
  thickness: number;
  /** How the offset walls meet at a corner — `shell().join()`. */
  joinType: ShellJoinType;
};

export type ShellGhostWalls = {
  /** The wall faces the hollowing would create, one entry per generated face. */
  walls: Face[];
  /**
   * Which way the walls move material. An inward shell leaves a cavity where
   * solid material was, so its walls bound material leaving; an outward one
   * wraps the solid in new material, and its walls bound material arriving.
   */
  kind: 'add' | 'remove';
  /** Everything built on the way there; dispose it alongside the walls. */
  scratch: Shape[];
};

/**
 * Build the ghost walls for a shell: the faces the statement would create by
 * offsetting the solid's skin, with the picked faces left open.
 *
 * Like a fillet, a shell has no standalone body to show — it reworks a solid
 * that already exists — so the offset runs on the real target, through the
 * same `ShellOps.makeThickSolid` the applied feature calls. The result is not
 * differenced against the original to recover the cavity (a boolean that
 * grows with the model's face count); the maker's output already holds the
 * answer, and `ShellInterior` reads the new walls straight out of it, the
 * classification `Shell.build` records as the feature's internal faces. What
 * the ghost draws is therefore exactly the surface the apply will add to the
 * model, for the price of the build alone.
 *
 * A refusal is silence, not an error: a wall thicker than the solid allows
 * leaves OCCT unable to offset (or handing the solid back unchanged), which
 * `makeThickSolid` reports by throwing — an ordinary state to pass through
 * while a value is typed. Callers get no walls and show no ghost.
 *
 * The caller owns disposal: every returned face and every `scratch` shape
 * must be `dispose()`d once meshed. None of it is reachable from scene state,
 * so `SceneDisposal` never collects it and it leaks compound per keystroke.
 */
export function buildShellGhostWalls(
  target: Solid,
  openings: Face[],
  options: ShellGhostOptions,
): ShellGhostWalls {
  const kind: ShellGhostWalls['kind'] = options.thickness > 0 ? 'add' : 'remove';
  const walls: Face[] = [];
  const scratch: Shape[] = [];
  if (openings.length === 0 || !options.thickness) {
    return { walls, kind, scratch };
  }

  const shelled = offsetWalls(target, openings, options);
  if (!shelled) {
    return { walls, kind, scratch };
  }
  scratch.push(shelled);

  try {
    walls.push(...new ShellInterior([target], openings).faces(shelled));
    return { walls, kind, scratch };
  } catch (err) {
    // A throw strands everything built so far out of the caller's reach —
    // free it here so a failed ghost costs nothing.
    for (const wall of walls) {
      wall.dispose();
    }
    for (const shape of scratch) {
      shape.dispose();
    }
    throw err;
  }
}

/**
 * The hollowed solid, or null where OCCT could not offset the wall. The op's
 * signature carries face colours for the applied feature's sake; the ghost
 * hands it none and frees the (empty) records it gets back.
 */
function offsetWalls(target: Solid, openings: Face[], options: ShellGhostOptions): Shape | null {
  const source = ColorTransfer.plain(target);
  try {
    const made = ShellOps.makeThickSolid(source, openings, options.thickness, options.joinType);
    ColorTransfer.disposeCarried(made.colors);
    return made.shape;
  } catch {
    return null;
  } finally {
    source.colors.delete();
  }
}
