/**
 * `fluidcad/sdk` — what a custom feature is written with: the {@link Feature}
 * base class, `registerBuilder` to turn a builder into the function a model
 * calls, and `parseCall` to read that call's arguments.
 *
 * ```js
 * import { Feature, parseCall, registerBuilder } from 'fluidcad/sdk';
 *
 * class Standoff extends Feature {
 *   static id = 'acme.standoff';
 *   buildTool() { … }
 * }
 *
 * const meta = {
 *   class: Standoff, label: 'Standoff', group: 'create', kind: 'tool',
 *   params: {
 *     face: { picker: 'face', surface: 'planar' },
 *     height: { type: 'length', default: 10, min: 0 },
 *   },
 *   call: ['face', { height: 'height' }],
 * };
 *
 * export const standoff = registerBuilder(
 *   context => (...args) => new Standoff(parseCall(meta, args)).addTo(context),
 *   { feature: meta },
 * );
 * ```
 *
 * The metadata gives the feature its toolbar button and dialog; the editor
 * finds it by scanning the module's exports.
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
export { parseCall } from "./meta.js";
export type {
  FeatureMeta, FeatureChange, FeatureGroup, FeatureKind, FeatureContext, ParamSpec, ScalarParamSpec, ScalarParamType,
  NumberParamSpec, BooleanParamSpec, SelectParamSpec, TextParamSpec, PickerParamSpec, PickerKind, VisibleWhen,
  SketchPickerSpec, FacePickerSpec, EdgePickerSpec, AxisPickerSpec, PlanePickerSpec, SolidPickerSpec, FeaturePickerSpec,
  ConnectorPickerSpec, PointPickerSpec, AnchorPickerSpec,
} from "./meta.js";
export type { CallShape, CallShapeSlot, FeatureOperation } from "./call-shape.js";
export type { SelectOption } from "../param-registry.js";
export type { ISceneObject, ISelection } from "../core/interfaces.js";
