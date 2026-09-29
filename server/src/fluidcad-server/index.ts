// Public surface of the FluidCAD server: the FluidCadServer class and the scene, render,
// query and ghost-request contracts its routes exchange with it.

export type {
  InterfereUnavailable,
  MeasureEntitiesOutcome,
  MeasureRef,
  ResolveSelectionUnavailable,
  SelectionBoundary,
  SelectionSynthesisOptions,
  ValidateUnavailable,
} from './query-types.ts';
export type { SerializedAssembly } from './assembly-types.ts';
export type { ObjectBuildError, ObjectBuildWarning, RenderOptions, SceneRenderedData } from './render-types.ts';
export { PartPropertiesAggregator, type PartMaterialSummary, type PartProperties } from './part-properties.ts';
export type {
  Copy2DGhostRequest,
  CopyGhostRequest,
  ExtrudeGhostRequest,
  FeatureGhostOutcome,
  FeatureGhostRequest,
  Fillet2DGhostRequest,
  FilletGhostRequest,
  GhostAxisRef,
  GhostEntityRef,
  GhostFrame,
  GhostHelixSourceRef,
  GhostLoftCondition,
  GhostPathRef,
  GhostPlaneBaseRef,
  GhostPlaneRef,
  GhostRepeatDirection,
  GhostSectionRef,
  GhostSketchAxisRef,
  GhostSolid,
  HelixGhostRequest,
  LoftGhostRequest,
  Mirror2DGhostRequest,
  MirrorGhostRequest,
  OffsetGhostRequest,
  PlaneGhostRequest,
  RepeatGhostRequest,
  RevolveGhostRequest,
  RibGhostRequest,
  RotateGhostRequest,
  SketchRegionPreview,
  SketchRegionsOutcome,
  SketchRegionsRequest,
  SketchOffsetPlanChain,
  SketchOffsetPlanEdge,
  SketchOffsetPlanJoin,
  SketchOffsetPlanOutcome,
  SketchOffsetPlanRequest,
  SweepGhostRequest,
} from './ghost-requests.ts';
export {
  sceneStopFields,
  sceneUnitFields,
  type SceneSummary,
  type SceneSummaryObject,
  type ShapeList,
  type ShapeListEntry,
} from './scene-summary.ts';
export { FluidCadServer } from './server.ts';
