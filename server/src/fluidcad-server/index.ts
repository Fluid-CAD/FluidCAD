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
export type { ObjectBuildError, RenderOptions, SceneRenderedData } from './render-types.ts';
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
  SweepGhostRequest,
} from './ghost-requests.ts';
export {
  sceneUnitFields,
  type SceneSummary,
  type SceneSummaryObject,
  type ShapeList,
  type ShapeListEntry,
} from './scene-summary.ts';
export { FluidCadServer } from './server.ts';
