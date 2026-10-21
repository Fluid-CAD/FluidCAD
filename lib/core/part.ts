import { captureSourceLocation } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { PartDefinition } from "../features/part-definition.js";

/**
 * Declares a reusable part: a named body of part-design statements with an
 * optional `param()` interface. Returns a LAZY definition — geometry builds
 * per variant when the definition is inserted (`insert(def, { Length: 380 })`)
 * or when the defining file renders standalone:
 *
 *     export const bushing = part('Bushing', () => {
 *       const bore = param('Bore', 10, 'number', { min: 4 });
 *       const s = sketch("xy", () => { circle([0, 0], 30); circle([0, 0], bore); });
 *       const e = extrude(20);
 *       connector('top', e.endFaces());
 *       expose('profile', s);
 *     });
 *
 * Equal override values share one template per scene (repeat inserts are
 * cheap); geometry published with `expose('name', source)` is read back as
 * `def.features.<name>` (the callback's return value is ignored).
 *
 * Every part is exported from the top level of its file, and its name is
 * unique within the file. A `part()` nothing exports (or exports only as
 * `default`), one written inside another part's or assembly's body, and a
 * second part of a name the file already used are build errors on that
 * `part()`: the part does not build, and its row says why.
 */
function part<T>(name: string, callback: () => T): PartDefinition<T> {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("part(): the first argument is the part's name, e.g. part('Bracket', () => { ... }).");
  }
  if (typeof callback !== "function") {
    throw new Error("part(): the second argument is the body callback building the part's geometry.");
  }
  const definition = new PartDefinition<T>(name, callback, captureSourceLocation());
  const scene = getCurrentScene();
  // Track on the scene (when one is current) so an entry render can
  // materialize definitions nothing exported or inserted — the open part
  // file stays WYSIWYG. Definitions created outside any scene (a library
  // module imported before init) are legal; only insert/export can build
  // those.
  scene?.trackPartDefinition(definition);
  // A part is exported from the top level of its file and named uniquely
  // in it (PartRules): a call inside another body or a second name is
  // refused here, an unexported part once the module's exports are known.
  definition.checkDeclaration(scene);
  return definition;
}

export default part;
