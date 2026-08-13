import { captureSourceLocation } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { PartDefinition } from "../features/part-definition.js";

/**
 * Declares a reusable part: a named body of part-design statements with an
 * optional `param()` interface. Returns a LAZY definition — geometry builds
 * per variant when the definition is inserted (`insert(def, { Length: 380 })`)
 * or when the defining file renders standalone:
 *
 *     export const extrusion = part('Extrusion', () => {
 *       const length = param('Length', 150, 'number', { min: 20 });
 *       sketch("front", () => { rect(80, 80).centered(); });
 *       const e = extrude(-length);
 *       connector('start', e.startFaces());
 *     });
 *
 * `def.with({ Length: 380 })` pre-binds values (a shared variant to insert
 * twice); the callback's return value is exposed as `def.features`.
 */
function part<T>(name: string, callback: () => T): PartDefinition<T> {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("part(): the first argument is the part's name, e.g. part('Bracket', () => { ... }).");
  }
  if (typeof callback !== "function") {
    throw new Error("part(): the second argument is the body callback building the part's geometry.");
  }
  const definition = new PartDefinition<T>(name, callback, captureSourceLocation());
  // Track on the scene (when one is current) so an entry render can
  // materialize definitions nothing exported or inserted — the open part
  // file stays WYSIWYG. Definitions created outside any scene (a library
  // module imported before init) are legal; only insert/export can build
  // those.
  getCurrentScene()?.trackPartDefinition(definition);
  return definition;
}

export default part;
