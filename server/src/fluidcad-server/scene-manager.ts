// The engine-facing scene manager contract the server drives.

import type {
  AssemblyExportOutcome,
  AssemblyExportPose,
  InterferenceRequest,
  RenderChangeTracker,
  ResolveSelectionRequest,
  ResolveSelectionResult,
  SceneInterferenceOutcome,
  SceneValidationOutcome,
  ValidateSceneRequest,
} from '../../../lib/dist/index.js';
import type { SerializedAssembly } from './assembly-types.ts';
import type { FeatureGhostRequest, SketchRegionsRequest } from './ghost-requests.ts';
import type { MeasureRef, SelectionBoundary, SelectionSynthesisOptions } from './query-types.ts';

export type SceneManager = {
  startScene(): any;
  startAssemblyScene(): any;
  renderScene(scene: any): any;
  getAssemblyData(scene: any): SerializedAssembly | null;
  rollbackScene(scene: any, rollbackIndex: number, opts?: { partScoped?: boolean }): any;
  compare(previousScene: any, currentScene: any, changes?: RenderChangeTracker): any;
  // Optional: the manager comes from the workspace's fluidcad install, which
  // may predate scene disposal.
  disposeScene?(scene: any): void;
  // Optional: may predate render change summaries. Only a render flagged
  // `changes` (the MCP's writes) asks for one — see `RenderOptions`.
  trackRenderChanges?(): RenderChangeTracker;
  setCurrentFile(filePath: string): void;
  importFile(workspacePath: string, fileName: string, data: Uint8Array): any;
  getShapeProperties(scene: any, shapeId: string): any;
  getFaceProperties(scene: any, shapeId: string, faceIndex: number): any;
  getEdgeProperties(scene: any, shapeId: string, edgeIndex: number): any;
  measure(scene: any, refs: MeasureRef[]): any;
  // Optional: the manager comes from the workspace's fluidcad install, which
  // may predate filter-expression resolution.
  resolveSelection?(scene: any, request: ResolveSelectionRequest, synthesis?: SelectionSynthesisOptions): ResolveSelectionResult;
  // Optional: may predate geometry validation.
  validate?(scene: any, request: ValidateSceneRequest): SceneValidationOutcome;
  // Optional: may predate interference checking.
  interfere?(scene: any, request: InterferenceRequest): SceneInterferenceOutcome;
  explainSelection(
    scene: any,
    refs: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } }[],
    before?: SelectionBoundary,
  ): any;
  synthesizeApplyFeature(
    scene: any,
    refs: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } }[],
    feature: 'fillet' | 'chamfer' | 'shell' | 'sketch' | 'extrude' | 'sweep' | 'loft' | 'plane' | 'revolve' | 'wrap' | 'helix' | 'project' | 'offset' | 'connector' | 'expose',
    value: number | string | undefined,
    chains?: {
      seed: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } };
      members: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } }[];
    }[],
    options?: {
      namer?: (producers: { line: number; nameHint: string }[]) => (string | null)[];
      bindable?: (producer: { line: number; featureType?: string }) => boolean;
      params?: { name: string; value: number }[];
    },
    before?: SelectionBoundary,
  ): any;
  // Optional: the manager comes from the workspace's fluidcad install, which
  // may predate consumer-side exposure resolution.
  resolvePickExposure?(
    scene: any,
    ref: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } },
  ): any;
  // Optional: may predate the projection tool's cross-part references.
  resolveStatementPart?(
    scene: any,
    loc: { filePath: string; line: number; column?: number },
  ): any;
  // Optional: may predate the tangent mate's contact classification.
  resolveContactPick?(
    scene: any,
    ref: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } },
  ): any;
  // Optional: the manager comes from the workspace's fluidcad install, which
  // may predate connector anchor suggestions.
  suggestConnectorAnchors?(
    scene: any,
    ref: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } },
    options?: {
      namer?: (producers: { line: number; nameHint: string }[]) => (string | null)[];
      bindable?: (producer: { line: number; featureType?: string }) => boolean;
      params?: { name: string; value: number }[];
    },
  ): any;
  // Optional: the manager comes from the workspace's fluidcad install, which
  // may predate the 2D target resolver (offset edit seeding). The options
  // arg (text-path seeding needs guides) is ignored by kernels predating it.
  resolveSketchStatementTargets?(scene: any, descriptors: unknown[]): any;
  // Optional: predates the text dialogs' path-layout glyph preview. The
  // path-only options (offset/startAt/flip) are ignored by kernels
  // predating them.
  buildTextPathPreview?(scene: any, request: {
    shapeId: string;
    text: string;
    font?: string;
    weight: number;
    italic: boolean;
    size: number;
    align: string;
    lineSpacing: number;
    letterSpacing: number;
    offset?: number;
    startAt?: number;
    flip?: boolean;
  }): { polylines: number[][] } | { reason: string };
  // Optional: the manager comes from the workspace's fluidcad install, which
  // may predate sketch-scoped selection synthesis.
  synthesizeSketchApplyFeature?(
    scene: any,
    refs: { shapeId: string }[],
    feature: 'fillet' | 'offset' | 'text' | 'copy' | 'mirror',
    value: number | string | undefined,
    options?: {
      namer?: (producers: { line: number; nameHint: string }[]) => (string | null)[];
      bindable?: (producer: { line: number; featureType?: string }) => boolean;
      params?: { name: string; value: number }[];
      /** Copy: one pick per edge-picked direction, in direction order. Mirror: the single line pick. */
      axisRefs?: { shapeId: string }[];
      /**
       * Offset only: the dialog's `.close()` chain. A workspace kernel
       * predating it ignores the field — the route re-attaches the payload
       * to the returned spec, so the statement the transform writes carries
       * the toggle either way.
       */
      offset?: { close: boolean };
      /** Slot only: the dialog's Remove-original toggle (`deleteSource`). */
      slot?: { removeOriginal: boolean };
    },
  ): any;
  expandTangentChain(
    scene: any,
    ref: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } },
    before?: SelectionBoundary,
  ): any;
  expandBucket(
    scene: any,
    ref: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } },
    before?: SelectionBoundary,
  ): any;
  listSelectionGroups(
    scene: any,
    ref: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } },
    before?: SelectionBoundary,
  ): any;
  resolveFeatureSources(scene: any, boundary: SelectionBoundary): any;
  // Optional: predates the live dialog geometry preview ("ghost").
  buildFeatureGhost?(scene: any, request: FeatureGhostRequest): any;
  // Optional: predates the dialog region picker.
  buildSketchRegions?(scene: any, request: SketchRegionsRequest): any;
  hitTest(
    scene: any,
    shapeId: string,
    rayOrigin: [number, number, number],
    rayDir: [number, number, number],
    edgeThreshold: number,
  ): any;
  exportShapes(
    scene: any,
    shapeIds: string[],
    options: {
      format: 'step' | 'stl';
      includeColors?: boolean;
      resolution?: string;
      customLinearDeflection?: number;
      customAngularDeflectionDeg?: number;
    },
  ): { data: string | Uint8Array; fileName: string };
  exportAssembly(
    scene: any,
    options: {
      format: 'step' | 'stl';
      name: string;
      livePoses?: AssemblyExportPose[];
      includeColors?: boolean;
      resolution?: string;
      customLinearDeflection?: number;
      customAngularDeflectionDeg?: number;
      scaleTo?: 'mm' | 'document';
    },
  ): AssemblyExportOutcome;
};
