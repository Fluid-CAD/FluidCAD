// Public surface of the apply-feature-edit service. Routes, hosts and
// tests import from here; the modules behind it are grouped by concern.

export { isExpressionText } from '../code-editor.ts';
export { validCountValue, validValueExpr, type RegionKey, type ValueExpr } from './value-expr.ts';
export type {
  ApplyFeatureEditResult,
  ApplyFeatureEditSpec,
  EditPathSource,
  EditSketchSource,
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
export { renderSweepStatement, type SweepEditOptions } from './features/sweep.ts';
export { renderWrapStatement, type WrapEditOptions } from './features/wrap.ts';
export { PROJECTION_OPS, type ProjectEditOptions, type ProjectionOp } from './features/projection.ts';
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
export { renderCopyCenterExpr, renderCopyStatement, type CopyEditOptions } from './features/copy.ts';
export {
  renderMirrorAxisExpr,
  renderMirrorStatement,
  type MirrorAxisSpec,
  type MirrorEditOptions,
} from './features/mirror.ts';
export { renderRotateStatement, type RotateEditAxis, type RotateEditOptions } from './features/rotate.ts';
export { renderBooleanStatement, type BooleanEditOptions, type BooleanKind } from './features/boolean.ts';
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
  makeProducerBindable,
  makeProducerBoundProbe,
  makeProducerNamer,
  resolveSketchNames,
} from './producers/naming.ts';
export { enclosingSketchLine } from './ast/nodes.ts';
export { extractNumericParams, resolveParamValues, type ExtractedParam } from './params.ts';
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
export { applyFeatureEdit } from './apply/feature-edit.ts';
export { SketchExports } from './sketch-exports.ts';
export { LoftConnections } from './loft-connections.ts';
