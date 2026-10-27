// Public surface of the apply-feature-edit service. Routes, hosts and
// tests import from here; the modules behind it are grouped by concern.

export { isExpressionText } from '../code-editor/index.ts';
export {
  refShaped,
  validCountValue,
  validRef,
  validValueExpr,
  type RefValue,
  type RegionItemRefSpec,
  type RegionName,
  type RegionPickSpec,
  type ValueExpr,
} from './value-expr.ts';
export { refArgValue } from './ast/args.ts';
export type {
  ApplyFeatureEditResult,
  ApplyFeatureEditSpec,
  EditPathSource,
  EditSketchSource,
  FeatureEditApply,
  FeatureStatementEditTarget,
  SketchClosedEditSpec,
} from './spec.ts';
export {
  renderConnectorAnchorSuffix,
  renderConnectorChain,
  validConnectorAnchor,
  validConnectorRotate,
  type ConnectorAnchorSpec,
  type ConnectorEditOptions,
  type ConnectorRotateAxis,
} from './features/connector.ts';
export type { ExposeEditOptions, ForeignExposureRef } from './features/expose.ts';
export {
  renderExtrudeStatement,
  renderFaceTargetExpr,
  type ExtrudeEditOptions,
  type ExtrudeFaceTarget,
  type ExtrudeTargetKind,
} from './features/extrude.ts';
export { renderRibStatement, type RibEditOptions } from './features/rib.ts';
export {
  HOLE_FITS,
  HoleRefSlots,
  renderHolePlacementExprs,
  renderHoleStatement,
  validHoleFasten,
  validHoleOptions,
  validHolePlacementSlot,
  type HoleEditOptions,
  type HoleFastenSpec,
  type HoleFastenerSpec,
  type HoleFit,
  type HolePlacementSpec,
  type HoleSizeSpec,
  type HoleStyleSpec,
  type HoleValueOptions,
  type ParsedHole,
} from './features/hole.ts';
export { HolePlacements } from './hole-placements.ts';
export { CustomFeaturePoints } from './custom-feature-points.ts';
export { SplitSeeds } from './split-seeds.ts';
export {
  renderSplitOptionsArg,
  renderSplitPlaneExpr,
  renderSplitStatement,
  validSplitKeep,
  validSplitOptions,
  validSplitPlane,
  SPLIT_KEEPS,
  type SplitEditOptions,
  type SplitEditPlane,
  type SplitKeep,
  type SplitPlaneSpec,
} from './features/split.ts';
export { renderSweepStatement, type SweepEditOptions } from './features/sweep.ts';
export { renderWrapStatement, type WrapEditOptions } from './features/wrap.ts';
export { PROJECTION_OPS, type ProjectEditOptions, type ProjectionOp } from './features/projection.ts';
export { ConnectorAxisSpecs, type ConnectorAxisSpec } from './features/connector-axis.ts';
export {
  renderRevolveAxisExpr,
  renderRevolveStatement,
  type RevolveAxisSpec,
  type RevolveEditOptions,
} from './features/revolve.ts';
export {
  renderHelixSourceExpr,
  renderHelixStatement,
  type HelixEditOptions,
  type HelixSourceSpec,
} from './features/helix.ts';
export {
  renderRepeatAxisExpr,
  renderRepeatPlaneExpr,
  renderRepeatStatement,
  type RepeatAxisSpec,
  type RepeatEditAxis,
  type RepeatEditOptions,
  type RepeatEditPlane,
  type RepeatEditTargetSource,
  type RepeatPlaneSpec,
} from './features/repeat.ts';
export {
  isFollowCopyForm,
  renderCopyAxisExpr,
  renderCopyCenterExpr,
  renderCopyStatement,
  type CopyAxisSpec,
  type CopyEditAxis,
  type CopyEditOptions,
  type CopyEditPattern,
} from './features/copy.ts';
export {
  renderMirrorAxisExpr,
  renderMirrorStatement,
  type MirrorAxisSpec,
  type MirrorEditOptions,
} from './features/mirror.ts';
export { renderRotateStatement, type RotateEditAxis, type RotateEditOptions } from './features/rotate.ts';
export {
  renderTranslateStatement,
  validTranslation,
  type TranslateEditOptions,
  type TranslationSpec,
} from './features/translate.ts';
export {
  renderSectionOptionsArg,
  renderSectionPlaneExpr,
  renderSectionStatement,
  validSectionOptions,
  type SectionEditOptions,
} from './features/section.ts';
export { renderBooleanStatement, type BooleanEditOptions, type BooleanKind } from './features/boolean.ts';
export { ColorValues, renderColorStatement, type ColorEditOptions } from './features/color.ts';
export { renderShellJoinChain, type ShellEditOptions, type ShellJoinKind } from './features/shell.ts';
export { renderChamferValueArgs, type ChamferEditOptions } from './features/chamfer.ts';
export {
  parseOffsetTargetDescriptors,
  renderOffsetStatement,
  type OffsetEditOptions,
  type SketchTargetDescriptor,
} from './features/offset.ts';
export {
  renderLoftConnections,
  renderLoftStatement,
  type EditLoftGuide,
  type EditLoftProfile,
  type LoftConditionSpec,
  type LoftConnectionSpec,
  type LoftEditOptions,
  type LoftPointSpec,
} from './features/loft.ts';
export {
  renderPlaneBaseExpr,
  renderPlaneBaseExprs,
  renderPlaneStatement,
  validPlaneRotationAxes,
  type ParsedPlaneBase,
  type PlaneBaseSpec,
  type PlaneEditBase,
  type PlaneEditOptions,
  type PlaneRotationAxes,
  type PlaneValueOptions,
} from './features/plane.ts';
export { renderTextStatement, type TextStatementOptions } from './features/text.ts';
export {
  CustomFeatureImport,
  CustomFeatureStatement,
  type CustomFeatureOptions,
  type CustomFeatureShape,
  type CustomParamKind,
  type CustomPickSource,
  type CustomPickText,
  type CustomValueSource,
  type ParsedCustomFeature,
} from './features/custom.ts';
export { TypedInKinds, type TypedInKind, type TypedInRef, type TypedInSource, type TypedInSpec, type TypedInValue } from './features/typed-in-kinds.ts';
export {
  makeProducerBindable,
  makeProducerBoundProbe,
  makeProducerNamer,
  resolveSketchNames,
} from './producers/naming.ts';
export { enclosingSketchLine } from './ast/nodes.ts';
export {
  extractNumericParams,
  ParamSites,
  resolveParamValues,
  type ExtractedParam,
  type ParamSiteDefinition,
} from './params.ts';
export { resolvePartBindingIdent } from './part-binding.ts';
export { renderRegionChain } from './render/chains.ts';
export { renderSelectorPartExpr } from './render/selectors.ts';
export { renderEditedStatement } from './render/edited-statement.ts';
export type {
  EditableFeatureKind,
  ParsedFeatureStatement,
  ParsedRegionChain,
  ParsedScopeChain,
} from './parse/parsed-statement.ts';
export { parseFeatureStatement, resolveEditedStatementLine } from './parse/feature-statement.ts';
export { resolvePartBodyInsertion, type Insertion } from './insertion.ts';
export { applyFeatureEdit, type ApplyFeatureEditOptions } from './apply/feature-edit.ts';
export {
  FeatureCallees,
  type CustomFeatureCallee,
  type FeatureCalleeSource,
} from './producers/callees.ts';
export { GlobalImports } from './global-imports.ts';
export { SketchExports } from './sketch-exports.ts';
export { LoftConnections } from './loft-connections.ts';
