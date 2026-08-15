import { Assembly } from "../features/assembly.js";
import { getCurrentScene } from "../scene-manager.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";

/**
 * Declares a sub-assembly: a named body of `insert()` / `mate()` statements
 * that can itself be inserted into another assembly. Returns a LAZY
 * definition — nothing runs until `insert(def)` executes the callback under
 * a fresh occurrence scope (or the entry render runs an exported one):
 *
 *     export const gantry = (width = 700) => assembly('gantry', () => {
 *       const beam = insert(beamPart).grounded();   // anchor of THIS frame
 *       ...
 *       return { beam };                            // exposed as occurrence.parts
 *     });
 *
 *     // parent file
 *     const g = insert(gantry(700)).translate(0, 50).grounded();
 *     mate('fastened', g.parts.beam.connectors.mount, base.connectors.top);
 *
 * `.grounded()` inside the body means "fixed in this assembly's frame" —
 * standalone editing grounds it for real, while a parent only grounds it by
 * grounding the occurrence. Parameterize with `param()` inside the body:
 * `insert(def, { Width: 900 })` resolves them per occurrence, and the
 * defining file's entry render shows them in the params panel.
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
  const definition = new Assembly<T>(name, callback);
  // Track the definition so an entry render whose scene stays EMPTY can
  // name the never-run definitions instead of rendering silently blank
  // (the classic mistake: a bare `assembly('x', () => {...});` statement
  // that nothing exports or inserts).
  const scene = getCurrentScene();
  if (scene instanceof AssemblyScene) {
    scene.trackDefinition(definition);
  }
  return definition;
}

export default assembly;
