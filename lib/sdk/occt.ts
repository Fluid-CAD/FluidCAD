/**
 * `fluidcad/sdk/occt` — raw OpenCascade, for a custom feature the curated
 * kernel (`fluidcad/sdk/kernel`) can't build: the engine's own OpenCascade
 * instance, typed, and the scope raw code runs in.
 *
 * ```js
 * import { Feature, defineFeature } from 'fluidcad/sdk';
 * import { ShapeFactory } from 'fluidcad/sdk/kernel';
 *
 * class Twist extends Feature.with({ … }) {
 *   static id = 'twist';
 *   buildTool() {
 *     return this.occ(({ oc, track }) => {
 *       const loft = new oc.BRepOffsetAPI_ThruSections(true, false, 1e-6);   // freed when the scope ends
 *       …
 *       return [ShapeFactory.fromShape(track(loft.Shape()))];                 // kept: the scope returns it
 *     });
 *   }
 * }
 * ```
 *
 * **Unstable, and unsafe by nature.** This is the engine's binding of
 * OpenCascade (`ocjs-fluidcad`) as it is: its classes, names and signatures
 * change with the binding, without notice, and a model using them builds
 * only on an engine with the same binding. Nothing checks raw code: an
 * object freed twice, or a shape the model holds freed from under it,
 * corrupts the kernel's memory for the whole engine session, not only for
 * the feature. When that ends in a crash ("memory access out of bounds"),
 * the feature's row fails and the editor offers to restart the engine. The
 * editor marks every feature whose module imports this entry.
 *
 * **Free what you make.** The binding's objects live on the kernel's heap
 * until freed, and a feature builds on every render. Run raw code inside
 * `this.occ(scope => …)`, whose scope frees every object constructed
 * through `scope.oc` when it ends (see {@link OccScope}). The binding's
 * `delete()` skips the C++ destructor, so even the scope can't free every
 * internal allocation of an algorithm without a `Clear()`; a long session
 * still grows a little. An ocjs build whose `delete()` runs
 * destructors frees all of it.
 *
 * Raw shapes come back into the kernel's wrappers through
 * `ShapeFactory.fromShape(raw)` (`fluidcad/sdk/kernel`), and a wrapper's raw
 * handle is `shape.getShape()`.
 */
export { getOC } from "../oc/init.js";
export { OccScope } from "../oc/occ-scope.js";
export type { OccScopeOptions } from "../oc/occ-scope.js";
export type * from "ocjs-fluidcad";
