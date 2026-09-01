/**
 * The assembly-origin mate frame: `origin()` at the top level of an
 * *.assembly.js file names the assembly's own coordinate frame as a mate
 * side, so a base part can keep degrees of freedom relative to the world
 * instead of being fully pinned by `.grounded()`:
 *
 *     const crank = insert(crankPart);
 *     mate('revolute', origin(), crank.connectors.shaft);   // spins about world Z
 *     mate('revolute', origin('x'), wheel.connectors.axle); // spins about world X
 *
 * The optional axis re-aims the frame's Z along a world axis (mate options
 * can translate and spin about Z but never tilt it, so the axis choice is
 * the one thing that must live on the frame itself). Position comes from
 * the mate's `.offset()` — expressed in this frame's basis, i.e. world
 * coordinates, since the origin side is always the grounded driver.
 */

export type OriginAxis = "x" | "y" | "z";

export const ORIGIN_AXES: ReadonlyArray<OriginAxis> = ["x", "y", "z"];

type Vec3Tuple = [number, number, number];

/**
 * The frame per axis: Z along the named world axis, X per
 * `Plane.uprightXDirection` (the shared stable-frame rule) — restated as
 * literals so the UI solver can mirror them without importing lib math.
 *
 *   z → Z=(0,0,1), X=(1,0,0)
 *   x → Z=(1,0,0), X=(0,1,0)
 *   y → Z=(0,1,0), X=(-1,0,0)
 */
export const ORIGIN_AXIS_FRAMES: Record<OriginAxis, { z: Vec3Tuple; x: Vec3Tuple }> = {
  z: { z: [0, 0, 1], x: [1, 0, 0] },
  x: { z: [1, 0, 0], x: [0, 1, 0] },
  y: { z: [0, 1, 0], x: [-1, 0, 0] },
};

/** What `origin(axis?)` returns in an assembly scene — a mate() side. */
export class AssemblyOriginFrame {
  constructor(public readonly axis: OriginAxis) {}
}

/** Validate the `origin(...)` argument in its assembly meaning. */
export function makeAssemblyOriginFrame(axis: unknown): AssemblyOriginFrame {
  if (axis === undefined) {
    return new AssemblyOriginFrame("z");
  }
  if (typeof axis === "string" && (ORIGIN_AXES as string[]).includes(axis)) {
    return new AssemblyOriginFrame(axis as OriginAxis);
  }
  if (typeof axis === "object" && axis !== null) {
    throw new Error(
      "origin(): custom frame objects are not supported yet — pass a world axis ('x', 'y', or 'z', default 'z') and place the joint with the mate's .offset()/.rotate().",
    );
  }
  throw new Error(
    `origin(): expected a world axis 'x', 'y', or 'z' (default 'z') — got ${JSON.stringify(axis)}.`,
  );
}
