/**
 * `fluidcad/sdk` — what a custom feature is written with: the {@link Feature}
 * base class, whose `Feature.with()` declares the feature's values and its
 * named buckets, and `defineFeature` to turn the class into the builder a
 * model calls.
 *
 * ```js
 * import { Feature, defineFeature } from 'fluidcad/sdk';
 *
 * class Standoff extends Feature.with({
 *   face: { picker: 'face', surface: 'planar' },
 *   height: { type: 'length', default: 10, min: 0 },
 * }) {
 *   static id = 'standoff';
 *   buildTool() {
 *     const { height } = this.values;   // a number
 *     …
 *   }
 * }
 *
 * export const standoff = defineFeature(Standoff, {
 *   label: 'Standoff', group: 'create', operations: ['add', 'new'],
 *   call: ['face', { height: 'height' }],
 * });
 * ```
 *
 * Plain JavaScript is typed by inference alone: `this.values`, the call
 * shape's names and the builder's arguments. The metadata gives the feature
 * its toolbar button and dialog; the editor finds it by scanning the
 * module's exports.
 *
 * `registerBuilder` with the whole metadata (`{ feature: { class, kind,
 * params, call, … } }`) and `parseCall` to read the arguments by it build
 * the same feature from a plain `Feature` subclass.
 *
 * The geometry a tool is built from lives in `fluidcad/sdk/kernel`.
 */
// The engine's root entry first: it evaluates the kernel's modules in the
// one order their import cycles allow. Reaching scene-object.js through
// feature.js first would extend SceneObject before it exists.
export { registerBuilder } from "../index.js";
export type { RegisterBuilderOptions, SceneParserContext } from "../index.js";
export { Feature } from "./feature.js";
export type { FeatureBuckets, FeatureBuildContext, FeatureClass, FeatureWith, FeatureWithOptions } from "./feature.js";
export type {
  FeatureBucketSpec, FeatureBucketSpecs, BucketAccessors, NamedBuckets, FeatureBucketBrand, BucketSpecsOf,
} from "./feature-buckets.js";
export { defineFeature } from "./define-feature.js";
export type { DefinableFeatureClass, DefineFeatureMeta } from "./define-feature.js";
export type { FeatureParams, ValuesOf, ValueOf, FeatureCallShape, FeatureArgs } from "./feature-params.js";
export type { FeatureValue, FeatureValues, FeatureScalar, FeatureReferenceSummary } from "./feature-inputs.js";
export { parseCall } from "./meta.js";
export { SDK_VERSION } from "./version.js";
export type {
  FeatureLayout, FeatureLayoutItem, FeatureLayoutRow, FeatureLayoutSection, FeatureLayoutTabs, FeatureLayoutTab,
  FeatureLayoutNote, FeatureLayoutImage, FeatureLayoutDivider, FeatureStaticItem, FeatureDialogWidth,
} from "./layout.js";
export type {
  FeatureMeta, FeatureGroup, FeatureKind, FeatureContext, FeatureGhostMode, ParamSpec, ScalarParamSpec, ScalarParamType,
  NumberParamSpec, BooleanParamSpec, SelectParamSpec, RadioParamSpec, ChoiceOption, TextParamSpec, PickerParamSpec, PickerKind, VisibleWhen,
  OptionWhen, OptionCase, PickCondition, PickedSurface,
  SketchPickerSpec, FacePickerSpec, EdgePickerSpec, AxisPickerSpec, PlanePickerSpec, SolidPickerSpec, FeaturePickerSpec,
  ConnectorPickerSpec, PointPickerSpec, AnchorPickerSpec, UnionPickerSpec,
} from "./meta.js";
export type { CallShape, CallShapeSlot, FeatureOperation } from "./call-shape.js";
export type { SelectOption } from "../param-registry.js";
export type { ISceneObject, ISelection } from "../core/interfaces.js";
