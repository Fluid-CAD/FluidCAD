import { Assembly } from "../features/assembly.js";

/**
 * Declares a sub-assembly: a named body of `insert()` / `mate()` /
 * `connector()` statements that can itself be inserted into another
 * assembly. Returns a LAZY definition — nothing runs until `insert(def)`
 * executes the callback under a fresh occurrence scope:
 *
 *     export const gantry = (width = 700) => assembly('gantry', () => {
 *       const beam = insert(beamPart).grounded();   // anchor of THIS frame
 *       ...
 *       connector('mount', beam.face(f => f.parallelTo('xy')));
 *       return { beam };                            // exposed as occurrence.parts
 *     });
 *
 *     // parent file
 *     const g = insert(gantry(700)).translate(0, 50).grounded();
 *     mate('fastened', g.connectors.mount, base.connectors.top);
 *
 * `.grounded()` inside the body means "fixed in this assembly's frame" —
 * standalone editing grounds it for real, while a parent only grounds it by
 * grounding the occurrence. Parameterization is plain JS: export a factory
 * returning the definition.
 *
 * @param name - The assembly's display name.
 * @param callback - The body; its return value is exposed per-occurrence as
 *   `occurrence.parts`.
 */
function assembly<T>(name: string, callback: () => T): Assembly<T> {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("assembly(): the first argument is the assembly's name, e.g. assembly('gantry', () => { ... }).");
  }
  if (typeof callback !== "function") {
    throw new Error("assembly(): the second argument is the body callback inserting and mating the assembly's instances.");
  }
  return new Assembly<T>(name, callback);
}

export default assembly;
