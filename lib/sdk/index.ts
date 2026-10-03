/**
 * `fluidcad/sdk` — what a custom feature is written with: the {@link Feature}
 * base class, and `registerBuilder` to turn a builder into the function a
 * model calls.
 *
 * ```js
 * import { Feature, registerBuilder } from 'fluidcad/sdk';
 *
 * class Standoff extends Feature {
 *   static id = 'acme.standoff';
 *   buildTool() { … }
 * }
 *
 * export const standoff = registerBuilder(context =>
 *   (face, { height = 10 } = {}) => new Standoff({ face, height }).addTo(context));
 * ```
 *
 * The geometry a tool is built from lives in `fluidcad/sdk/kernel`.
 */
// The engine's root entry first: it evaluates the kernel's modules in the
// one order their import cycles allow. Reaching scene-object.js through
// feature.js first would extend SceneObject before it exists.
export { registerBuilder } from "../index.js";
export type { RegisterBuilderOptions, SceneParserContext } from "../index.js";
export { Feature } from "./feature.js";
export type { FeatureBuckets, FeatureBuildContext, FeatureClass } from "./feature.js";
export type { FeatureValue, FeatureValues, FeatureScalar, FeatureReferenceSummary } from "./feature-inputs.js";
export type { ISceneObject, ISelection } from "../core/interfaces.js";
