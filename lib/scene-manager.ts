import { Scene } from "./rendering/scene.js";
import { AssemblyScene, SerializedAssemblyConnector, SerializedInstance, SerializedMate, SerializedOccurrence, SerializedReplicate } from "./rendering/assembly-scene.js";
import { SceneRenderer } from "./rendering/render.js";
import { SceneCompare } from "./rendering/scene-compare.js";
import { AssemblyCompare } from "./rendering/assembly-compare.js";
import { SceneDisposal } from "./rendering/scene-disposal.js";
import { buildFeatureGhost } from "./rendering/feature-ghost.js";
import type { FeatureGhostRequest, FeatureGhostResult } from "./rendering/feature-ghost.js";
import { buildTextPathPreview } from "./rendering/text-path-preview.js";
import type { TextPathPreviewRequest } from "./rendering/text-path-preview.js";
import { MESH_PRESETS, DEFAULT_MESH_QUALITY } from "./oc/mesh.js";
import type { MeshQuality } from "./oc/mesh.js";
import type { FluidCADOptions } from "./index.js";
import { createUnitRegistry, getUnitRegistry } from "./units/registry.js";
import { MM_PER_UNIT } from "./units/units.js";
import type { LengthUnit } from "./units/units.js";
import { createProjectUnitLookup, resolveProjectUnit } from "./project-unit.js";
import { FileImport } from "./io/file-import.js";
import { FileExport } from "./io/file-export.js";
import type { ExportOptions } from "./io/file-export.js";
import type { StepFileUnits } from "./oc/step-units.js";

/** What an import produced, for the "N solids, file unit INCH" report. */
export type ImportReport = {
  solidCount: number;
  /** The unit the cached geometry is in (always mm). */
  unit: LengthUnit;
  /** The unit names the source file declared. */
  sourceUnits: StepFileUnits;
};
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
import { getOC } from "./oc/init.js";
import { Convert } from "./oc/convert.js";
import type { MeasureInput } from "./oc/measure/measure-ops.js";
import type { MeasureEntityRef, MeasurePose, MeasureResult } from "./oc/measure/measure-types.js";
import { explainSelection, synthesizeApplyFeature } from "./selection/explain.js";
import { ConnectorAnchorSuggestions, suggestConnectorAnchors } from "./selection/connector-anchors.js";
import { PickExposureResolution, resolvePickExposure } from "./selection/expose-lookup.js";
import { ContactPickResolution, resolveContactPick } from "./selection/contact-pick.js";
import { synthesizeSketchApplyFeature, resolveSketchStatementTargets, SketchTargetDescriptor } from "./selection/sketch-apply.js";
import type { SketchApplyFeatureKind, SketchPickRef, SketchSynthesizeOptions } from "./selection/sketch-apply.js";
import { expandBucket, expandTangentChain, ExpandBucketResult, ExpandTangentsResult } from "./selection/expand.js";
import { listSelectionGroups, SelectionGroupsResult } from "./selection/selection-groups.js";
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
  /**
   * The unit files without unit() run in (init options → fluidcad.json →
   * mm). Mutable: a host that re-reads fluidcad.json per render re-seeds it
   * here; the next startScene() picks it up.
   */
  projectUnit: LengthUnit;

  constructor(public rootPath: string, public readonly meshQuality: MeshQuality, projectUnit: LengthUnit) {
    this.renderer = new SceneRenderer(meshQuality);
    this.projectUnit = projectUnit;
  }

  setCurrentFile(filePath: string) {
    this.currentFile = filePath;
    // Hosts call startScene() before setCurrentFile(): re-point the registry.
    getUnitRegistry().rootFile = filePath;
  }

  /** A fresh unit registry per render — every scene start, so per-test starts reset it too. */
  startUnitRegistry(): void {
    createUnitRegistry({
      projectUnit: this.projectUnit,
      rootFile: this.currentFile,
      projectUnitForFile: createProjectUnitLookup(this.rootPath),
    });
  }

  startScene() {
    this.startUnitRegistry();
    this.currentScene = new Scene();
    console.log("Starting new scene");
    return this.currentScene;
  }

  startAssemblyScene(): AssemblyScene {
    this.startUnitRegistry();
    const scene = new AssemblyScene();
    this.currentScene = scene;
    console.log("Starting new assembly scene");
    return scene;
  }

  renderScene(scene: Scene) {
    return this.renderer.render(scene);
  }

  getAssemblyData(scene: Scene): {
    instances: SerializedInstance[];
    mates: SerializedMate[];
    occurrences: SerializedOccurrence[];
    connectors: SerializedAssemblyConnector[];
    replicates: SerializedReplicate[];
  } | null {
    if (!(scene instanceof AssemblyScene)) {
      return null;
    }
    return {
      instances: scene.getSerializedInstances(),
      mates: scene.getSerializedMates(),
      occurrences: scene.getSerializedOccurrences(),
      connectors: scene.getSerializedAssemblyConnectors(),
      replicates: scene.getSerializedReplicates(),
    };
  }

  /**
   * Re-emit the scene rolled back to `rollbackIndex` (view-only — nothing
   * rebuilds). With `partScoped`, the rollback isolates the target object's
   * enclosing part: everything outside that part stays fully rendered and
   * only the part's own features after the index are hidden. Falls back to
   * the classic global prefix when the index lands outside any part.
   *
   * Returns the stop hosts should echo as `rollbackStop` — the raw index
   * for global rollbacks (preserving the historical echo, which may exceed
   * the last index), the clamped target index for scoped ones — plus the
   * scoped part's id. The stop stays on the clicked row even when the scope
   * hides nothing (the part's last feature): the current marker belongs on
   * that row, and whether the view is actually truncated is derivable from
   * stop + part id (see the UI's isRollbackViewTruncated).
   */
  rollbackScene(
    scene: Scene,
    rollbackIndex: number,
    opts?: { partScoped?: boolean },
  ): { stop: number; scopePartId: string | null } {
    const allObjects = scene.getAllSceneObjects();
    const lastIndex = allObjects.length - 1;
    const clamped = Math.min(rollbackIndex, lastIndex);
    const target = clamped >= 0 ? allObjects[clamped] : undefined;
    const part = opts?.partScoped && target ? scene.findEnclosingPart(target) : null;
    if (!part) {
      this.renderer.renderRollback(scene, clamped);
      return { stop: rollbackIndex, scopePartId: null };
    }

    // Membership scope, not an index range: lazily materialized donor parts
    // can interleave with another part's children in the flat list, so "the
    // rest of the scene" must be selected by findEnclosingPart, never by
    // position relative to the clicked part.
    const scope = new Set(
      allObjects.filter((obj, i) => i <= clamped || scene.findEnclosingPart(obj) !== part),
    );
    this.renderer.renderRollback(scene, clamped, scope);
    return { stop: clamped, scopePartId: part.id };
  }

  compare(previous: Scene, current: Scene) {
    if (previous instanceof AssemblyScene && current instanceof AssemblyScene) {
      return AssemblyCompare.compare(previous, current);
    }
    return SceneCompare.compare(previous, current);
  }

  /**
   * Free a scene that is being dropped without a compare against a
   * successor (forced full rebuild, session teardown).
   */
  disposeScene(scene: Scene) {
    SceneDisposal.disposeScene(scene);
  }

  importFile(workspacePath: string, fileName: string, data: Uint8Array): ImportReport {
    const { solids, unit, sourceUnits } = FileImport.importFile(workspacePath, fileName, data);
    return { solidCount: solids.length, unit, sourceUnits };
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
    const disposers: (() => void)[] = [];
    try {
      for (const ref of refs) {
        const shape = findShapeById(scene, ref.shapeId);
        if (!shape) {
          return null;
        }
        const subShapes = ref.kind === 'face' ? Explorer.findFacesWrapped(shape) : Explorer.findEdgesWrapped(shape);
        if (ref.index < 0 || ref.index >= subShapes.length) {
          return null;
        }
        let subShape = subShapes[ref.index].getShape();
        // Assembly entities are measured where their instance sits. Part
        // shapes live once per template in the part's own frame, so the
        // sub-shape is moved (location only — no geometry copy; every
        // downstream kernel call reads through TopLoc_Location) by the
        // instance pose: the caller's live pose, else the statement pose.
        if (ref.instanceId !== undefined) {
          const pose = ref.pose ?? serializedInstancePose(scene, ref.instanceId);
          if (!pose) {
            return null;
          }
          const [trsf, disposeTrsf] = Convert.toGpTrsfPose(pose.position, pose.quaternion);
          const location = new (getOC().TopLoc_Location)(trsf);
          subShape = subShape.Moved(location, false);
          disposers.push(() => {
            location.delete();
            disposeTrsf();
          });
        }
        inputs.push({ ref, shape: subShape });
      }
      if (inputs.length === 0) {
        return null;
      }
      // Measure runs outside any build scope: sample at the scene's own density.
      return MeasureOps.measure(inputs, { quality: this.meshQuality, unit: scene.unit });
    } finally {
      for (const dispose of disposers) {
        dispose();
      }
    }
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

    // The shapes' numbers are in the scene's unit unless the caller asserts otherwise.
    return FileExport.exportShapes(solids, { ...options, unit: options.unit ?? scene.unit });
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

  /** Hover-time connector anchor suggestions for a picked face/edge. */
  suggestConnectorAnchors(
    scene: Scene,
    ref: PickRef,
    options: SynthesizeOptions = {},
  ): ConnectorAnchorSuggestions {
    return suggestConnectorAnchors(scene, ref, options);
  }

  /**
   * Consumer-side pick resolution: the picked geometry's enclosing part and
   * that part's matching exposure. Cross-part references are authoring-frame
   * (parts designed in place), so assembly scenes refuse with a pointed
   * message instead of inventing pose-aware in-context semantics — EXCEPT
   * for mate picks (`context: 'mate'`): a tangent mate names geometry, not
   * coordinates, so the pose-dependence rationale doesn't apply and the
   * lookup runs over the assembly's part templates.
   */
  resolvePickExposure(
    scene: Scene,
    ref: PickRef,
    options: { context?: 'sketch' | 'mate' } = {},
  ): PickExposureResolution {
    if (scene instanceof AssemblyScene && options.context !== 'mate') {
      return {
        ok: false,
        reason: "cross-part geometry references are authored in the part file — open the part's own file to reference another part's geometry",
      };
    }
    return resolvePickExposure(scene, ref);
  }

  /**
   * Tangent-mate pick resolution: the exposure find-or-create data plus the
   * picked face/edge's canonical contact classification (seed + G1 chain +
   * bounds). Allowed over assembly scenes — a tangent pick names geometry,
   * not authoring-frame coordinates.
   */
  resolveContactPick(scene: Scene, ref: PickRef): ContactPickResolution {
    return resolveContactPick(scene, ref);
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

  /** Glyph outlines laid along a picked path geometry — the text dialogs' preview. */
  buildTextPathPreview(
    scene: Scene,
    request: TextPathPreviewRequest,
  ): { polylines: number[][] } | { reason: string } {
    return buildTextPathPreview(scene, request);
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

  resolveFeatureSources(scene: Scene, boundary: SelectionBoundary): FeatureSourcesResult {
    return resolveFeatureSources(scene, boundary);
  }

  /**
   * Mesh the geometry an open feature dialog would produce ("ghost"). Reads
   * the scene, writes nothing to it: the shapes are built from the named
   * profile alone and freed before returning.
   */
  buildFeatureGhost(scene: Scene, request: FeatureGhostRequest): FeatureGhostResult {
    return buildFeatureGhost(scene, request, this.meshQuality);
  }

  /** Resolve a 2D statement's target arguments onto the active sketch's edges. */
  resolveSketchStatementTargets(
    scene: Scene,
    descriptors: SketchTargetDescriptor[],
    options: { includeGuides?: boolean } = {},
  ): { ok: true; shapeIds: string[] } | { ok: false; reason: string } {
    return resolveSketchStatementTargets(scene, descriptors, options);
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

/** The world pose the scene serialized for an instance (occurrence chain composed), or null when unknown. */
function serializedInstancePose(scene: Scene, instanceId: string): MeasurePose | null {
  if (!(scene instanceof AssemblyScene)) {
    return null;
  }
  const inst = scene.getSerializedInstances().find(i => i.instanceId === instanceId);
  if (!inst) {
    return null;
  }
  return { position: inst.position, quaternion: inst.quaternion };
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

/**
 * `init({ mesh })` → quality. `quality` picks a preset; an explicit
 * `lineDeflection` (in document units — the project unit at init) or
 * `angularDeflection` pins that value and marks the result `custom`. A pinned
 * linear deflection is stored in mm with floor = ceiling so it resolves to
 * the same physical density in every document.
 */
export function resolveMeshQuality(options: FluidCADOptions | undefined, projectUnit: LengthUnit): MeshQuality {
  const mesh = options?.mesh;
  const base = mesh?.quality ? MESH_PRESETS[mesh.quality] : DEFAULT_MESH_QUALITY;
  if (!base) {
    throw new Error(`init(): unknown mesh quality '${String(mesh?.quality)}'. Use one of: draft, standard, fine.`);
  }
  if (mesh?.lineDeflection === undefined && mesh?.angularDeflection === undefined) {
    return base;
  }
  const quality: MeshQuality = { ...base, preset: 'custom' };
  if (mesh.lineDeflection !== undefined) {
    const linDeflMm = mesh.lineDeflection * MM_PER_UNIT[projectUnit];
    quality.relative = 0;
    quality.minMm = linDeflMm;
    quality.maxMm = linDeflMm;
  }
  if (mesh.angularDeflection !== undefined) {
    quality.angularRad = mesh.angularDeflection;
  }
  return quality;
}

export function createManager(rootPath: string, options?: FluidCADOptions) {
  console.log(`Creating SceneManager with root path: ${rootPath}`);
  const projectUnit = resolveProjectUnit(rootPath, options);
  currentManager = new SceneManager(rootPath, resolveMeshQuality(options, projectUnit), projectUnit);
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
