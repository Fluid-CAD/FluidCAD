import { Scene } from "./rendering/scene.js";
import { SceneRenderer } from "./rendering/render.js";
import { SceneCompare } from "./rendering/scene-compare.js";
import { SceneDisposal } from "./rendering/scene-disposal.js";
import { DEFAULT_MESH_CONFIG } from "./oc/mesh.js";
import type { MeshConfig } from "./oc/mesh.js";
import type { FluidCADOptions } from "./index.js";
import { FileImport } from "./io/file-import.js";
import { FileExport } from "./io/file-export.js";
import type { ExportOptions } from "./io/file-export.js";
import { Solid } from "./common/solid.js";
import { ShapeProps } from "./oc/props.js";
import type { ShapeProperties } from "./oc/props.js";
import { FaceProps } from "./oc/face-props.js";
import type { FaceProperties } from "./oc/face-props.js";
import { EdgeProps } from "./oc/edge-props.js";
import type { EdgeProperties } from "./oc/edge-props.js";
import { Explorer } from "./oc/explorer.js";
import { OccHitTest } from "./oc/hit-test.js";
import type { HitTestResult } from "./oc/hit-test.js";
import { MeasureOps } from "./oc/measure/measure-ops.js";
import type { MeasureInput } from "./oc/measure/measure-ops.js";
import type { MeasureEntityRef, MeasureResult } from "./oc/measure/measure-types.js";
import { explainSelection, synthesizeApplyFeature } from "./selection/explain.js";
import { synthesizeSketchApplyFeature } from "./selection/sketch-apply.js";
import type { SketchApplyFeatureKind, SketchPickRef, SketchSynthesizeOptions } from "./selection/sketch-apply.js";
import { synthesizeTrimRegionTargets } from "./selection/trim-region.js";
import type { TrimRegionSynthesis } from "./selection/trim-region.js";
import { expandBucket, expandTangentChain, ExpandBucketResult, ExpandTangentsResult } from "./selection/expand.js";
import { listSelectionGroups, SelectionGroupsResult } from "./selection/selection-groups.js";
import { listSegmentConversions, SegmentConversionsResult } from "./selection/segment-conversion.js";
import { resolveFeatureSources, FeatureSourcesResult } from "./selection/feature-sources.js";
import { resolveScopedScene } from "./selection/types.js";
import type {
  ApplyFeatureKind, ApplyFeatureSynthesis, ExplainResult, PickChain, PickRef,
  SelectionBoundary, SelectionScene, SynthesizeOptions,
} from "./selection/types.js";

type BoundaryFailure = { ok: false; reason: string };

class SceneManager {
  currentScene: Scene = new Scene();
  currentFile: string = '';
  renderer: SceneRenderer;

  constructor(public rootPath: string, meshConfig: MeshConfig) {
    this.renderer = new SceneRenderer(meshConfig);
  }

  setCurrentFile(filePath: string) {
    this.currentFile = filePath;
  }

  startScene() {
    this.currentScene = new Scene();
    console.log("Starting new scene");
    return this.currentScene;
  }

  renderScene(scene: Scene) {
    return this.renderer.render(scene);
  }

  rollbackScene(scene: Scene, rollbackIndex: number) {
    return this.renderer.renderRollback(scene, rollbackIndex);
  }

  compare(previous: Scene, current: Scene) {
    return SceneCompare.compare(previous, current);
  }

  /**
   * Free a scene that is being dropped without a compare against a
   * successor (forced full rebuild, session teardown).
   */
  disposeScene(scene: Scene) {
    SceneDisposal.disposeScene(scene);
  }

  importFile(workspacePath: string, fileName: string, data: Uint8Array) {
    FileImport.importFile(workspacePath, fileName, data);
  }

  getShapeProperties(scene: Scene, shapeId: string): ShapeProperties | null {
    for (const obj of scene.getAllSceneObjects()) {
      for (const shape of obj.getAddedShapes()) {
        if (shape.id === shapeId) {
          return ShapeProps.getProperties(shape.getShape());
        }
      }
    }
    return null;
  }

  getFaceProperties(scene: Scene, shapeId: string, faceIndex: number): FaceProperties | null {
    for (const obj of scene.getAllSceneObjects()) {
      for (const shape of obj.getAddedShapes()) {
        if (shape.id === shapeId) {
          const faces = Explorer.findFacesWrapped(shape);
          if (faceIndex < 0 || faceIndex >= faces.length) {
            return null;
          }
          return FaceProps.getProperties(faces[faceIndex].getShape());
        }
      }
    }
    return null;
  }

  getEdgeProperties(scene: Scene, shapeId: string, edgeIndex: number): EdgeProperties | null {
    for (const obj of scene.getAllSceneObjects()) {
      for (const shape of obj.getAddedShapes()) {
        if (shape.id === shapeId) {
          const edges = Explorer.findEdgesWrapped(shape);
          if (edgeIndex < 0 || edgeIndex >= edges.length) {
            return null;
          }
          return EdgeProps.getProperties(edges[edgeIndex].getShape());
        }
      }
    }
    return null;
  }

  measure(scene: Scene, refs: MeasureEntityRef[]): MeasureResult | null {
    const inputs: MeasureInput[] = [];
    for (const ref of refs) {
      const shape = findShapeById(scene, ref.shapeId);
      if (!shape) {
        return null;
      }
      const subShapes = ref.kind === 'face' ? Explorer.findFacesWrapped(shape) : Explorer.findEdgesWrapped(shape);
      if (ref.index < 0 || ref.index >= subShapes.length) {
        return null;
      }
      inputs.push({ ref, shape: subShapes[ref.index].getShape() });
    }
    if (inputs.length === 0) {
      return null;
    }
    return MeasureOps.measure(inputs);
  }

  exportShapes(scene: Scene, shapeIds: string[], options: ExportOptions): { data: string | Uint8Array; fileName: string } {
    const solids: Solid[] = [];
    for (const obj of scene.getAllSceneObjects()) {
      for (const shape of obj.getAddedShapes()) {
        if (shapeIds.includes(shape.id) && shape.isSolid()) {
          solids.push(shape as Solid);
        }
      }
    }

    if (solids.length === 0) {
      throw new Error('No matching solids found for export');
    }

    return FileExport.exportShapes(solids, options);
  }

  explainSelection(scene: Scene, refs: PickRef[], before?: SelectionBoundary): ExplainResult | BoundaryFailure {
    return withBoundary(scene, before, scoped => explainSelection(scoped, refs));
  }

  synthesizeApplyFeature(
    scene: Scene,
    refs: PickRef[],
    feature: ApplyFeatureKind,
    value?: number | string,
    chains: PickChain[] = [],
    options: SynthesizeOptions = {},
    before?: SelectionBoundary,
  ): ApplyFeatureSynthesis {
    return withBoundary(
      scene, before, scoped => synthesizeApplyFeature(scoped, refs, feature, value, chains, options),
    );
  }

  /** 2D branch: synthesize a sketch-body statement for picked sketch edges. */
  synthesizeSketchApplyFeature(
    scene: Scene,
    refs: SketchPickRef[],
    feature: SketchApplyFeatureKind,
    value?: number | string,
    options: SketchSynthesizeOptions = {},
  ): ApplyFeatureSynthesis {
    return synthesizeSketchApplyFeature(scene, refs, feature, value, options);
  }

  /** By-region trim: synthesize filter args for a clicked region's boundary segments. */
  synthesizeTrimRegionTargets(
    scene: Scene,
    sourceLocation: { line: number; column?: number },
    edgeIds: string[],
  ): TrimRegionSynthesis {
    return synthesizeTrimRegionTargets(scene, sourceLocation, edgeIds);
  }

  expandTangentChain(scene: Scene, ref: PickRef, before?: SelectionBoundary): ExpandTangentsResult {
    return withBoundary(scene, before, scoped => expandTangentChain(scoped, ref));
  }

  expandBucket(scene: Scene, ref: PickRef, before?: SelectionBoundary): ExpandBucketResult {
    return withBoundary(scene, before, scoped => expandBucket(scoped, ref));
  }

  listSelectionGroups(scene: Scene, ref: PickRef, before?: SelectionBoundary): SelectionGroupsResult {
    return withBoundary(scene, before, scoped => listSelectionGroups(scoped, ref));
  }

  /** Legal constrained/free conversions for a picked chained sketch segment. */
  listSegmentConversions(scene: Scene, ref: { shapeId: string }): SegmentConversionsResult {
    return listSegmentConversions(scene, ref);
  }

  resolveFeatureSources(scene: Scene, boundary: SelectionBoundary): FeatureSourcesResult {
    return resolveFeatureSources(scene, boundary);
  }

  hitTest(
    scene: Scene,
    shapeId: string,
    rayOrigin: [number, number, number],
    rayDir: [number, number, number],
    edgeThreshold: number,
  ): HitTestResult {
    for (const obj of scene.getAllSceneObjects()) {
      for (const shape of obj.getAddedShapes()) {
        if (shape.id === shapeId) {
          return OccHitTest.hitTest(shape.getShape(), rayOrigin, rayDir, edgeThreshold);
        }
      }
    }
    return null;
  }
}

/**
 * Run a selection query against the scene, truncated to the boundary when one
 * is given (edit-mode source re-picking). A boundary that no longer matches
 * the scene refuses — never a silent fall back to the full scene, which would
 * verify selectors against a world the edited statement can't see.
 */
function withBoundary<T>(
  scene: Scene,
  before: SelectionBoundary | undefined,
  run: (scene: SelectionScene) => T,
): T | BoundaryFailure {
  if (!before) {
    return run(scene);
  }
  const scoped = resolveScopedScene(scene, before);
  if (scoped.ok === false) {
    return scoped;
  }
  return run(scoped.scene);
}

function findShapeById(scene: Scene, shapeId: string) {
  for (const obj of scene.getAllSceneObjects()) {
    for (const shape of obj.getAddedShapes()) {
      if (shape.id === shapeId) {
        return shape;
      }
    }
  }
  return null;
}

let currentManager: SceneManager | null = null;

function resolveMeshConfig(options?: FluidCADOptions): MeshConfig {
  return {
    linDefl: options?.mesh?.lineDeflection ?? DEFAULT_MESH_CONFIG.linDefl,
    angDefl: options?.mesh?.angularDeflection ?? DEFAULT_MESH_CONFIG.angDefl,
  };
}

export function createManager(rootPath: string, options?: FluidCADOptions) {
  console.log(`Creating SceneManager with root path: ${rootPath}`);
  currentManager = new SceneManager(rootPath, resolveMeshConfig(options));
  return currentManager;
}

export function getCurrentScene() {
  return currentManager?.currentScene;
}

export function getCurrentFile(): string {
  return currentManager?.currentFile || '';
}

export function setCurrentFile(filePath: string) {
  if (currentManager) {
    currentManager.setCurrentFile(filePath);
  }
}

export function getSceneManager() {
  return currentManager;
}
