import { Box3, BufferAttribute, BufferGeometry, Color, LineSegments, Mesh, MeshPhongMaterial, Object3D, Vector3 } from 'three';
import { FIT_PADDING, SceneContext } from './scene/scene-context';
import { SceneModeManager } from './scene/scene-mode';
import { buildSceneMesh } from './meshes/mesh-factory';
import { PlaneData, SceneObjectPart, SceneObjectRender, SerializedAssembly, SerializedAssemblyMate, SubSelection } from './types';
import { AssemblyController, InstanceDragReleaseHandler, SolverUpdateHandler } from './scene/assembly-controller';
import { SettingsPanel } from './ui/settings-panel';
import { CentroidIndicator } from './scene/centroid-indicator';
import { viewerSettings } from './scene/viewer-settings';
import { themeColors } from './scene/theme-colors';

/** Recursively expand `box` to include `object`, skipping meta-shape subtrees. */
function expandBoxExcludingMeta(box: Box3, object: Object3D): void {
  if (object.userData.isMetaShape) return;
  const o = object as any;
  if ((o.isMesh || o.isLine || o.isPoints) && o.geometry) {
    o.geometry.computeBoundingBox();
    if (o.geometry.boundingBox) {
      box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
    }
  }
  for (const child of object.children) {
    expandBoxExcludingMeta(box, child);
  }
}

/**
 * Keep only parts referenced by some `inst.partId` and the entire subtree
 * under each kept part. An assembly file declares every part it might use
 * (typically via factory functions like `getExtrusion(...)`), but only the
 * ones passed to `insert(...)` should appear in the viewport. Filtering
 * here means a `rebuildSceneMesh()` triggered by theme/region-pick can't
 * materialize an un-inserted part at world origin.
 */
function filterToReferencedParts(
  sceneObjects: SceneObjectRender[],
  instances: SerializedAssembly['instances'],
): SceneObjectRender[] {
  const referencedPartIds = new Set(instances.map(i => i.partId));
  const childrenByParent = new Map<string, SceneObjectRender[]>();
  for (const obj of sceneObjects) {
    if (!obj.parentId) continue;
    const list = childrenByParent.get(obj.parentId);
    if (list) list.push(obj);
    else childrenByParent.set(obj.parentId, [obj]);
  }
  const keep = new Set<string>();
  const stack: SceneObjectRender[] = [];
  for (const obj of sceneObjects) {
    if (obj.type === 'part' && obj.id && referencedPartIds.has(obj.id)) {
      stack.push(obj);
    }
  }
  while (stack.length > 0) {
    const obj = stack.pop()!;
    if (!obj.id || keep.has(obj.id)) continue;
    keep.add(obj.id);
    const children = childrenByParent.get(obj.id);
    if (children) stack.push(...children);
  }
  return sceneObjects.filter(obj => obj.id && keep.has(obj.id));
}

const HIGHLIGHT_EDGE_LINE_WIDTH = 2;
const HOVER_EDGE_LINE_WIDTH = 2;

// How much to blend non-sketch object colors toward the scene background while
// sketch mode is active. Higher = more faded. Opaque tint avoids the three.js
// transparency sort/overdraw cost on complex scenes.
const SKETCH_GHOST_TINT_FACTOR = 0.75;


/**
 *  - SceneContext      — scene, camera, renderer, controls
 *  - SceneModeManager  — default / sketch mode transitions
 *  - buildSceneMesh    — object-type → mesh factory
 */
export class Viewer {
  private ctx: SceneContext;
  private modeManager: SceneModeManager;
  private settingsPanel: SettingsPanel;
  private sceneObjects: SceneObjectRender[] = [];
  private highlightedShapeId: string | null = null;
  private faceHighlightMeshes: Mesh[] = [];
  private hasRendered = false;
  private lastFitBox: Box3 | null = null;
  isTrimming = false;
  isRegionPicking = false;
  isDrawing = false;

  private selectionHandler: ((shapeId: string | null, sub: SubSelection, instanceId: string | null) => void) | null = null;
  private centroidIndicator = new CentroidIndicator();
  private hoverState: { shapeId: string; sub: SubSelection; instanceId: string | null } | null = null;
  private hoverFaceOverlayMeshes: Mesh[] = [];
  /**
   * Identifies the assembly instance whose geometry was last selected. Stored
   * as an id (not a Group reference) so it stays valid across diff updates
   * that may replace the underlying Three.js objects. Null in part-design
   * scenes and when nothing is selected.
   */
  private highlightedInstanceId: string | null = null;
  private hoverRafId: number | null = null;
  private isMouseDown = false;
  /**
   * After a drag-release inside the assembly controller, the cursor sits
   * on the just-dropped part. We don't want hover to instantly re-paint
   * its face. Track the dropped instance id and suppress hover that lands
   * on it; clear the suppression as soon as the cursor moves to a
   * different instance or to empty space (i.e. the user "let go" of the
   * part with their cursor too).
   */
  private hoverSuppressForInstance: string | null = null;
  private highlightedSub: SubSelection = null;
  private activeSketchId: string | null = null;
  private hiddenShapeIds = new Set<string>();
  private shapeOpacities = new Map<string, number>();
  private assemblyController: AssemblyController | null = null;
  private pendingDragReleaseHandler: InstanceDragReleaseHandler | null = null;
  private pendingSolverUpdateHandler: SolverUpdateHandler | null = null;

  constructor(containerId: string) {
    const container = document.getElementById(containerId)!;
    this.ctx = new SceneContext(container);
    this.modeManager = new SceneModeManager(this.ctx);
    this.settingsPanel = new SettingsPanel(container, (mode) => this.ctx.switchCamera(mode));
    this.settingsPanel.setFitHandler(() => this.fitViewToScene());
    if (viewerSettings.current.cameraMode === 'perspective') {
      this.ctx.switchCamera('perspective');
    }
    this.settingsPanel.setSectionViewToggleHandler((enabled) => {
      if (enabled) {
        this.applySectionView();
      } else {
        this.clearSectionView();
      }
    });

    this.initClickDetection();
    this.initHoverDetection();
  }

  get sceneContext(): SceneContext {
    return this.ctx;
  }

  get currentSceneObjects(): SceneObjectRender[] {
    return this.sceneObjects;
  }

  setSelectionHandler(fn: (shapeId: string | null, sub: SubSelection, instanceId: string | null) => void): void {
    this.selectionHandler = fn;
  }

  get settingsPanelHost(): HTMLElement {
    return this.settingsPanel.panelHost;
  }

  setParamsToggleHandler(fn: () => void): void {
    this.settingsPanel.setParamsToggleHandler(fn);
  }

  setParamsButtonVisible(visible: boolean): void {
    this.settingsPanel.setParamsButtonVisible(visible);
  }

  setParamsButtonActive(active: boolean): void {
    this.settingsPanel.setParamsButtonActive(active);
  }

  lookAlongSketchNormal(plane: PlaneData): void {
    this.modeManager.enforceSketchNormal(plane);
  }


  private initClickDetection(): void {
    const canvas = this.ctx.renderer.domElement;
    let downX = 0;
    let downY = 0;

    canvas.addEventListener('mousedown', (e) => {
      downX = e.clientX;
      downY = e.clientY;
    });

    canvas.addEventListener('mouseup', (e) => {
      if (!this.selectionHandler || this.isTrimming || this.isRegionPicking || this.modeManager.isSketchMode) {
        return;
      }
      // A click on a draggable part (whether the cursor moved or not)
      // shouldn't double as a face-selection click — otherwise a drop
      // leaves a stray face/edge highlight on the part. Clear any
      // pre-existing highlight too in case it was set by an earlier click.
      const droppedInstanceId = this.assemblyController?.consumeRecentDrag();
      if (droppedInstanceId) {
        this.clearHighlight();
        this.clearHover();
        // The parts panel may have called assemblyController.highlightInstance
        // earlier (whole-instance tint via assemblyOriginalColor); viewer's
        // clearHighlight only handles selection/hover overlays, so clear the
        // controller's own tint too.
        this.assemblyController?.clearHighlight();
        // Suppress hover on the part the user just dropped — they're still
        // over it, and re-painting its face on the next mousemove would
        // look like the highlight didn't clear. Cleared in updateHover as
        // soon as the cursor moves to a different instance or empty space.
        this.hoverSuppressForInstance = droppedInstanceId;
        if (this.selectionHandler) {
          this.selectionHandler(null, null, null);
        }
        return;
      }
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      if (dx * dx + dy * dy > 64) {
        return; // was a drag (> 8px)
      }

      this.clearHover();
      const result = this.pickAt(e.clientX, e.clientY);
      if (result) {
        this.selectionHandler(result.shapeId, result.sub, result.instanceId);
      } else {
        this.selectionHandler(null, null, null);
      }
    });
  }

  /** Walk up parents looking for an `instanceId` user-data marker. */
  private findInstanceIdForObject(obj: Object3D): string | null {
    let cur: Object3D | null = obj;
    while (cur) {
      const id = cur.userData?.instanceId;
      if (typeof id === 'string') {
        return id;
      }
      cur = cur.parent;
    }
    return null;
  }

  /**
   * Resolves an instance scope to a traversal root. Returns the live
   * controller-owned Group when the id is known, the whole scene when no id
   * is given, and null when the id was given but no longer exists (caller
   * should treat as "nothing to highlight").
   */
  private resolveScope(instanceId: string | null | undefined): Object3D | null {
    if (!instanceId) {
      return this.ctx.scene;
    }
    return this.assemblyController?.getInstanceGroup(instanceId) ?? null;
  }

  /**
   * Client-side raycaster picking across all shapes.  Returns the closest
   * front-facing face or edge hit together with its shapeId, plus the
   * assembly instance id if the hit was inside one (so callers can scope
   * highlight traversals to that single instance).
   */
  private pickAt(clientX: number, clientY: number): { shapeId: string; sub: SubSelection; instanceId: string | null } | null {
    const camera = this.ctx.camera;
    const rect = this.ctx.renderer.domElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = this.ctx.createPickingRaycaster(ndcX, ndcY);
    raycaster.params.Line = { threshold: this.computeEdgePickThreshold() };
    raycaster.params.Line2 = { threshold: 8 };

    const faceCandidates: Mesh[] = [];
    const edgeCandidates: LineSegments[] = [];

    this.ctx.scene.traverse((obj) => {
      if (obj.userData.isMetaShape) {
        return;
      }
      if ((obj as Mesh).isMesh && obj.userData.faceMapping) {
        faceCandidates.push(obj as Mesh);
      } else if (((obj as LineSegments).isLine || obj.userData.isEdgeLine) && obj.userData.edgeIndex !== undefined) {
        edgeCandidates.push(obj as LineSegments);
      }
    });

    const faceHits = faceCandidates.length > 0 ? raycaster.intersectObjects(faceCandidates, false) : [];
    const edgeHits = edgeCandidates.length > 0 ? raycaster.intersectObjects(edgeCandidates, false) : [];

    if (faceHits.length === 0 && edgeHits.length === 0) {
      return null;
    }

    // Pick the closest face hit whose triangle normal faces the camera.
    const viewDir = new Vector3();
    camera.getWorldDirection(viewDir);
    let bestFace: (typeof faceHits)[number] | undefined;
    for (const hit of faceHits) {
      if (!hit.face) {
        bestFace = hit;
        break;
      }
      const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      if (worldNormal.dot(viewDir) < 0) {
        bestFace = hit;
        break;
      }
    }

    // Edge depth test: project actual closest point on the edge segment onto
    // the pick ray and compare with the face depth.
    const faceDist = bestFace != null ? bestFace.distance : Infinity;
    const rayOrigin = raycaster.ray.origin;
    const rayDir = raycaster.ray.direction;
    const segPt = new Vector3();
    const toSeg = new Vector3();
    for (const edgeHit of edgeHits) {
      // LineSegments2 hits expose `pointOnLine` (closest point on the segment
      // in world space); the old BufferGeometry index path doesn't apply.
      const pointOnLine = (edgeHit as { pointOnLine?: Vector3 }).pointOnLine;
      if (pointOnLine) {
        segPt.copy(pointOnLine);
      } else {
        segPt.copy(edgeHit.point);
      }
      const edgeDist = rayDir.dot(toSeg.copy(segPt).sub(rayOrigin));
      if (edgeDist <= faceDist + 1e-3) {
        const edgeIndex = edgeHit.object.userData.edgeIndex as number;
        const shapeId = this.findShapeIdForObject(edgeHit.object);
        if (shapeId) {
          return {
            shapeId,
            sub: { type: 'edge', index: edgeIndex },
            instanceId: this.findInstanceIdForObject(edgeHit.object),
          };
        }
      }
    }

    if (bestFace) {
      const mapping: number[] | undefined = bestFace.object.userData.faceMapping;
      if (!mapping || bestFace.faceIndex == null) {
        return null;
      }
      const faceIndex = mapping[bestFace.faceIndex];
      if (faceIndex == null) {
        return null;
      }
      const shapeId = this.findShapeIdForObject(bestFace.object);
      if (shapeId) {
        return {
          shapeId,
          sub: { type: 'face', index: faceIndex },
          instanceId: this.findInstanceIdForObject(bestFace.object),
        };
      }
    }

    return null;
  }

  private findShapeIdForObject(obj: Object3D): string | null {
    let cur: Object3D | null = obj;
    while (cur) {
      if (cur.userData.shapeId && !cur.userData.isMetaShape) {
        return cur.userData.shapeId as string;
      }
      cur = cur.parent;
    }
    return null;
  }

  toggleSketchMode(enable: boolean): void {
    this.modeManager.sketchEnabled = enable;
  }

  setFileName(_absPath: string): void {
    // File name is now shown in the timeline panel header
  }

  updateView(sceneObjects: SceneObjectRender[], isRollback = false, rollbackStop?: number): void {
    this.sceneObjects = sceneObjects;
    this.highlightedShapeId = null;
    this.highlightedSub = null;
    this.hoverState = null;
    this.hoverFaceOverlayMeshes = [];
    this.ctx.renderer.domElement.style.cursor = '';

    this.removeCompiledMesh();
    // Detach the assembly controller's group from the scene but keep its
    // instance state so a part → assembly → part round-trip preserves the
    // poses the user dragged. The controller's clear() is reserved for
    // genuine assembly teardown (handled inside updateAssemblyView when the
    // file changes — see clearAssemblyState).
    if (this.assemblyController) {
      const container = this.assemblyController.getContainer();
      if (container.parent) {
        container.parent.remove(container);
      }
      // Drop any per-instance hover-revealed connectors so they don't
      // resurface when the user re-enters assembly mode.
      this.assemblyController.setHoveredInstance(null);
    }

    if (!isRollback) {
      const activeObject = this.findActiveObject(sceneObjects);

      if (activeObject?.type === 'sketch' && activeObject.object?.plane) {
        if (!this.modeManager.isSketchMode) {
          this.modeManager.enterSketchMode(activeObject.object.plane);
        } else {
          this.modeManager.enforceSketchNormal(activeObject.object.plane);
        }
        this.activeSketchId = activeObject.id;
        this.settingsPanel.setProjectionLocked(true);
        this.settingsPanel.setFitButtonVisible(false);
      } else {
        this.activeSketchId = null;
        this.modeManager.enterDefaultMode();
        this.settingsPanel.setProjectionLocked(false);
        this.settingsPanel.setFitButtonVisible(true);
        this.lastFitBox = null;
      }
    } else {
      this.activeSketchId = this.findRollbackActiveSketchId(sceneObjects, rollbackStop);
    }

    const mesh = buildSceneMesh(sceneObjects, this.activeSketchId, this.ctx.camera, this.isRegionPicking);
    this.ctx.scene.add(mesh);
    this.applyShapeOverridesAndPrune(sceneObjects);

    if (this.activeSketchId) {
      this.applySketchModeGhosting();
    }

    // Section view: apply clipping when in sketch mode
    this.settingsPanel.setSectionViewVisible(this.modeManager.isSketchMode);
    if (this.modeManager.isSketchMode) {
      this.settingsPanel.setSectionViewActive(viewerSettings.current.sectionView);
      if (viewerSettings.current.sectionView) {
        this.applySectionView();
      }
    }

    // Auto-fit on first render or in sketch mode (skip if viewport barely changed or trimming).
    // Skip when in sketch mode on first render — positionCameraForSketch already centered on origin.
    if ((!this.hasRendered && !this.modeManager.isSketchMode) || (this.modeManager.isSketchMode && !isRollback && !this.isTrimming && !this.isRegionPicking && !this.isDrawing)) {
      const box = new Box3();
      expandBoxExcludingMeta(box, mesh);
      if (!box.isEmpty() && !this.isBoxContained(box)) {
        this.ctx.fitToBox(box, true);
        this.lastFitBox = box.clone();
        this.hasRendered = true;
      }
    }
    if (!this.hasRendered && this.modeManager.isSketchMode) {
      this.hasRendered = true;
    }

    this.ctx.requestRender();
  }

  highlightInstance(instanceId: string): void {
    this.assemblyController?.highlightInstance(instanceId, themeColors.highlightColor.getHex());
  }

  highlightMate(mate: SerializedAssemblyMate): void {
    this.assemblyController?.highlightMate(mate, themeColors.highlightColor.getHex());
  }

  clearInstanceHighlight(): void {
    this.assemblyController?.clearHighlight();
  }

  setInstanceVisibility(instanceId: string, visible: boolean): void {
    this.assemblyController?.setInstanceVisible(instanceId, visible);
  }

  isInstanceVisible(instanceId: string): boolean {
    return this.assemblyController?.isInstanceVisible(instanceId) ?? true;
  }

  setInstanceDragReleaseHandler(handler: InstanceDragReleaseHandler | null): void {
    this.pendingDragReleaseHandler = handler;
    this.assemblyController?.setDragReleaseHandler(handler);
  }

  setSolverUpdateHandler(handler: SolverUpdateHandler | null): void {
    this.pendingSolverUpdateHandler = handler;
    this.assemblyController?.setSolverUpdateHandler(handler);
  }

  updateAssemblyView(sceneObjects: SceneObjectRender[], assembly: SerializedAssembly): void {
    // The render result contains every Part declared in the file, including
    // ones never passed to `insert(...)` (calling `getExtrusion('80x160', …)`
    // for its side-effect of registering the Part in the scene puts it in
    // the result). Drop those subtrees so a stray `rebuildSceneMesh()` (theme
    // change, region pick) can't materialize an un-inserted part at world
    // origin, and so the controller's part-template map / connector lookup
    // doesn't waste time on them.
    sceneObjects = filterToReferencedParts(sceneObjects, assembly.instances);
    this.sceneObjects = sceneObjects;
    this.highlightedShapeId = null;
    this.highlightedSub = null;
    this.hoverState = null;
    this.hoverFaceOverlayMeshes = [];

    this.removeCompiledMesh();
    this.activeSketchId = null;
    this.modeManager.enterDefaultMode();
    this.settingsPanel.setProjectionLocked(false);
    this.settingsPanel.setFitButtonVisible(true);

    if (!this.assemblyController) {
      this.assemblyController = new AssemblyController(
        this.ctx.renderer,
        this.ctx.camera,
        () => this.ctx.requestRender(),
        (ndcX, ndcY) => this.ctx.createPickingRaycaster(ndcX, ndcY),
      );
      this.assemblyController.setDragReleaseHandler(this.pendingDragReleaseHandler);
      this.assemblyController.setSolverUpdateHandler(this.pendingSolverUpdateHandler);
      // When the controller claims a drag, eagerly clear any face/edge/instance
      // highlight that was set earlier (e.g. by a prior click or parts-panel
      // row). Otherwise it would visually "stick" through the drag and the
      // user would see the just-dropped part still highlighted.
      this.assemblyController.setDragClaimHandler(() => {
        // Cancel any hover RAF that was scheduled by a mousemove fired
        // before the drag began — otherwise its callback runs mid-drag and
        // paints a face overlay on the part we're currently dragging.
        if (this.hoverRafId !== null) {
          cancelAnimationFrame(this.hoverRafId);
          this.hoverRafId = null;
        }
        this.clearHighlight();
        this.clearHover();
        this.assemblyController?.clearHighlight();
        if (this.selectionHandler) {
          this.selectionHandler(null, null, null);
        }
      });
    }
    const container = this.assemblyController.getContainer();
    if (!container.parent) {
      this.ctx.scene.add(container);
    }

    this.assemblyController.update(sceneObjects, assembly);

    if (!this.hasRendered) {
      const box = new Box3();
      expandBoxExcludingMeta(box, this.assemblyController.getContainer());
      if (!box.isEmpty() && !this.isBoxContained(box)) {
        this.ctx.fitToBox(box, true);
        this.lastFitBox = box.clone();
        this.hasRendered = true;
      }
    }

    this.ctx.requestRender();
  }

  highlightShape(shapeId: string, instanceId: string | null = null): void {
    this.clearHighlight();

    const part = this.findShapeById(shapeId);
    if (!part) return;

    const scope = this.resolveScope(instanceId);
    if (!scope) return;
    const group = this.findMeshByShapeId(shapeId, scope);
    if (!group) return;
    this.highlightedInstanceId = instanceId;

    const isFaceHighlight = part.shapeType === 'solid' || part.shapeType === 'face';

    group.traverse((child) => {
      if (!(child as any).material) return;

      const isEdge = (child as LineSegments).isLine || child.userData.isEdgeLine;

      if (isFaceHighlight && child instanceof Mesh && !isEdge) {
        const mat = (child as any).material;
        child.userData.originalColor = mat.color.getHex();
        mat.color.set(themeColors.highlightColor);
        if (mat.opacity < 1 || mat.transparent) {
          child.userData.originalOpacity = mat.opacity;
          child.userData.originalTransparent = mat.transparent;
          mat.opacity = 1;
          mat.transparent = false;
        }
      } else if (!isFaceHighlight && isEdge) {
        child.userData.originalColor = (child as any).material.color.getHex();
        (child as any).material.color.set(themeColors.highlightColor);
        child.userData.originalLineWidth = (child as any).material.linewidth;
        (child as any).material.linewidth = HIGHLIGHT_EDGE_LINE_WIDTH;
        if ((child as any).material.opacity < 1) {
          child.userData.originalOpacity = (child as any).material.opacity;
          (child as any).material.opacity = 1;
        }
      }
    });

    this.highlightedShapeId = shapeId;
    this.highlightedSub = null;
    this.ctx.render();
  }

  clearHighlight(): void {
    if (!this.highlightedShapeId && this.faceHighlightMeshes.length === 0) {
      return;
    }

    this.ctx.scene.traverse((child) => {
      if (child.userData.originalColor !== undefined) {
        (child as any).material.color.setHex(child.userData.originalColor);
        delete child.userData.originalColor;
      }
      if (child.userData.originalOpacity !== undefined) {
        (child as any).material.opacity = child.userData.originalOpacity;
        delete child.userData.originalOpacity;
      }
      if (child.userData.originalTransparent !== undefined) {
        (child as any).material.transparent = child.userData.originalTransparent;
        delete child.userData.originalTransparent;
      }
      if (child.userData.originalLineWidth !== undefined) {
        (child as any).material.linewidth = child.userData.originalLineWidth;
        delete child.userData.originalLineWidth;
      }
    });

    for (const m of this.faceHighlightMeshes) {
      m.parent?.remove(m);
      m.geometry.dispose();
      (m.material as MeshPhongMaterial).dispose();
    }
    this.faceHighlightMeshes = [];

    this.highlightedShapeId = null;
    this.highlightedSub = null;
    this.highlightedInstanceId = null;
    this.ctx.render();
  }

  highlightFace(shapeId: string, faceIndex: number, instanceId: string | null = null): void {
    this.clearHighlight();

    const scope = this.resolveScope(instanceId);
    if (!scope) return;
    this.highlightedInstanceId = instanceId;
    scope.traverse((obj) => {
      if (!(obj as Mesh).isMesh) {
        return;
      }
      const mapping: number[] | undefined = obj.userData.faceMapping;
      if (!mapping) {
        return;
      }

      let belongsToShape = false;
      let cur: Object3D | null = obj;
      while (cur) {
        if (cur.userData.shapeId === shapeId && !cur.userData.isMetaShape) {
          belongsToShape = true;
          break;
        }
        cur = cur.parent;
      }
      if (!belongsToShape) {
        return;
      }

      const mesh = obj as Mesh;
      const geo = mesh.geometry as BufferGeometry;
      const indexAttr = geo.index;
      if (!indexAttr) {
        return;
      }

      const indices = indexAttr.array;
      const positions = (geo.getAttribute('position').array) as Float32Array;
      const newPositions: number[] = [];

      for (let tri = 0; tri < mapping.length; tri++) {
        if (mapping[tri] === faceIndex) {
          const i0 = (indices[tri * 3] as number) * 3;
          const i1 = (indices[tri * 3 + 1] as number) * 3;
          const i2 = (indices[tri * 3 + 2] as number) * 3;
          newPositions.push(positions[i0], positions[i0 + 1], positions[i0 + 2]);
          newPositions.push(positions[i1], positions[i1 + 1], positions[i1 + 2]);
          newPositions.push(positions[i2], positions[i2 + 1], positions[i2 + 2]);
        }
      }

      if (newPositions.length === 0) {
        return;
      }

      const overlayGeo = new BufferGeometry();
      overlayGeo.setAttribute('position', new BufferAttribute(new Float32Array(newPositions), 3));

      const overlayMat = new MeshPhongMaterial({
        color: themeColors.highlightColor,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -1,
      });

      const overlayMesh = new Mesh(overlayGeo, overlayMat);
      (mesh.parent ?? this.ctx.scene).add(overlayMesh);
      this.faceHighlightMeshes.push(overlayMesh);
    });

    this.highlightedShapeId = shapeId;
    this.highlightedSub = { type: 'face', index: faceIndex };
    this.ctx.render();
  }

  highlightEdge(shapeId: string, edgeIndex: number, instanceId: string | null = null): void {
    this.clearHighlight();

    const scope = this.resolveScope(instanceId);
    if (!scope) return;
    this.highlightedInstanceId = instanceId;
    scope.traverse((obj) => {
      if (!(obj as LineSegments).isLine && !obj.userData.isEdgeLine) {
        return;
      }
      if (obj.userData.edgeIndex !== edgeIndex) {
        return;
      }

      let belongsToShape = false;
      let cur: Object3D | null = obj;
      while (cur) {
        if (cur.userData.shapeId === shapeId && !cur.userData.isMetaShape) {
          belongsToShape = true;
          break;
        }
        cur = cur.parent;
      }
      if (!belongsToShape) {
        return;
      }

      obj.userData.originalColor = (obj as any).material.color.getHex();
      (obj as any).material.color.set(themeColors.highlightColor);
      obj.userData.originalLineWidth = (obj as any).material.linewidth;
      (obj as any).material.linewidth = HIGHLIGHT_EDGE_LINE_WIDTH;
    });

    this.highlightedShapeId = shapeId;
    this.highlightedSub = { type: 'edge', index: edgeIndex };
    this.ctx.render();
  }

  // ---------------------------------------------------------------------------
  // Hover highlighting
  // ---------------------------------------------------------------------------

  private initHoverDetection(): void {
    const canvas = this.ctx.renderer.domElement;

    canvas.addEventListener('mousedown', () => {
      this.isMouseDown = true;
      // A new gesture: the user explicitly clicked on something, so any
      // post-drop hover suppression no longer applies.
      this.hoverSuppressForInstance = null;
      this.clearHover();
    });

    canvas.addEventListener('mouseup', () => {
      this.isMouseDown = false;
    });

    canvas.addEventListener('mousemove', (e) => {
      if (this.isMouseDown || this.isTrimming || this.isRegionPicking || this.modeManager.isSketchMode) {
        return;
      }
      // Authoritative drag-active gate. `isMouseDown` above is mouse-event
      // derived; the browser sometimes suppresses compatibility mouse events
      // (touch/pen, palm rejection, fast input). The pointer-event-driven
      // controller state is reliable, so we always consult it.
      if (this.assemblyController?.isDragGestureActive()) {
        return;
      }
      if (this.hoverRafId !== null) {
        return;
      }
      this.hoverRafId = requestAnimationFrame(() => {
        this.hoverRafId = null;
        this.updateHover(e.clientX, e.clientY);
      });
    });

    canvas.addEventListener('mouseleave', () => {
      this.clearHover();
      // Hide assembly connectors when the cursor leaves the canvas. They're
      // revealed per-instance by updateHover; without this, a connector left
      // visible by the last hit would linger until the cursor re-enters.
      this.assemblyController?.setHoveredInstance(null);
    });
  }

  private updateHover(clientX: number, clientY: number): void {
    if (!this.selectionHandler) {
      return;
    }
    // A hover RAF can be scheduled by a mousemove that fired *before* a
    // drag began; the callback then runs mid-drag. Re-check authoritative
    // state here so a stale RAF can't paint a face overlay onto the part
    // we're currently dragging.
    if (this.isMouseDown || this.assemblyController?.isDragGestureActive()) {
      return;
    }

    const result = this.pickAt(clientX, clientY);

    // Reveal connectors for whichever instance the cursor is on, hide them
    // otherwise. Done unconditionally — independent of the face/edge hover
    // dedup paths below — so connectors stay visible while the user moves
    // around within the same part (including over the currently-selected
    // face, which short-circuits the rest of this method).
    this.assemblyController?.setHoveredInstance(result?.instanceId ?? null);

    // Per-instance post-drop suppression: if the user just released the
    // drag and their cursor is still on the dropped instance, don't paint
    // hover on it. As soon as they move to a different instance or off
    // any instance entirely, the suppression lifts.
    if (this.hoverSuppressForInstance) {
      if (result && result.instanceId === this.hoverSuppressForInstance) {
        if (this.hoverState) this.clearHover();
        return;
      }
      this.hoverSuppressForInstance = null;
    }

    // Same as current hover — skip. Include instance id so two instances of
    // the same part don't dedupe against each other.
    if (this.hoverState && result &&
        this.hoverState.shapeId === result.shapeId &&
        this.hoverState.sub?.type === result.sub?.type &&
        this.hoverState.sub?.index === result.sub?.index &&
        this.hoverState.instanceId === result.instanceId) {
      return;
    }

    // Nothing hovered — clear and return.
    if (!result) {
      if (this.hoverState) {
        this.clearHover();
      }
      return;
    }

    // Don't hover-highlight the currently selected face/edge (same instance).
    if (this.highlightedShapeId === result.shapeId &&
        this.highlightedSub?.type === result.sub?.type &&
        this.highlightedSub?.index === result.sub?.index &&
        this.highlightedInstanceId === result.instanceId) {
      if (this.hoverState) {
        this.clearHover();
      }
      return;
    }

    this.clearHover();
    this.hoverState = { shapeId: result.shapeId, sub: result.sub, instanceId: result.instanceId };
    this.ctx.renderer.domElement.style.cursor = 'pointer';

    if (result.sub?.type === 'face') {
      this.applyHoverFace(result.shapeId, result.sub.index, result.instanceId);
    } else if (result.sub?.type === 'edge') {
      this.applyHoverEdge(result.shapeId, result.sub.index, result.instanceId);
    }
  }

  clearHover(): void {
    // Remove face hover overlays
    for (const m of this.hoverFaceOverlayMeshes) {
      m.parent?.remove(m);
      m.geometry.dispose();
      (m.material as MeshPhongMaterial).dispose();
    }
    this.hoverFaceOverlayMeshes = [];

    // Restore edge hover colors
    this.ctx.scene.traverse((child) => {
      if (child.userData.hoverOriginalColor !== undefined) {
        (child as any).material.color.setHex(child.userData.hoverOriginalColor);
        delete child.userData.hoverOriginalColor;
      }
      if (child.userData.hoverOriginalLineWidth !== undefined) {
        (child as any).material.linewidth = child.userData.hoverOriginalLineWidth;
        delete child.userData.hoverOriginalLineWidth;
      }
    });

    this.hoverState = null;
    this.ctx.renderer.domElement.style.cursor = '';
    this.ctx.requestRender();
  }

  private applyHoverFace(shapeId: string, faceIndex: number, instanceId: string | null): void {
    const scope = this.resolveScope(instanceId);
    if (!scope) return;
    scope.traverse((obj) => {
      if (!(obj as Mesh).isMesh) {
        return;
      }
      const mapping: number[] | undefined = obj.userData.faceMapping;
      if (!mapping) {
        return;
      }

      let belongsToShape = false;
      let cur: Object3D | null = obj;
      while (cur) {
        if (cur.userData.shapeId === shapeId && !cur.userData.isMetaShape) {
          belongsToShape = true;
          break;
        }
        cur = cur.parent;
      }
      if (!belongsToShape) {
        return;
      }

      const mesh = obj as Mesh;
      const geo = mesh.geometry as BufferGeometry;
      const indexAttr = geo.index;
      if (!indexAttr) {
        return;
      }

      const indices = indexAttr.array;
      const positions = (geo.getAttribute('position').array) as Float32Array;
      const newPositions: number[] = [];

      for (let tri = 0; tri < mapping.length; tri++) {
        if (mapping[tri] === faceIndex) {
          const i0 = (indices[tri * 3] as number) * 3;
          const i1 = (indices[tri * 3 + 1] as number) * 3;
          const i2 = (indices[tri * 3 + 2] as number) * 3;
          newPositions.push(positions[i0], positions[i0 + 1], positions[i0 + 2]);
          newPositions.push(positions[i1], positions[i1 + 1], positions[i1 + 2]);
          newPositions.push(positions[i2], positions[i2 + 1], positions[i2 + 2]);
        }
      }

      if (newPositions.length === 0) {
        return;
      }

      const overlayGeo = new BufferGeometry();
      overlayGeo.setAttribute('position', new BufferAttribute(new Float32Array(newPositions), 3));

      const overlayMat = new MeshPhongMaterial({
        color: themeColors.highlightColor,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -1,
      });

      const overlayMesh = new Mesh(overlayGeo, overlayMat);
      (mesh.parent ?? this.ctx.scene).add(overlayMesh);
      this.hoverFaceOverlayMeshes.push(overlayMesh);
    });

    this.ctx.requestRender();
  }

  private applyHoverEdge(shapeId: string, edgeIndex: number, instanceId: string | null): void {
    const scope = this.resolveScope(instanceId);
    if (!scope) return;
    scope.traverse((obj) => {
      if (!(obj as LineSegments).isLine && !obj.userData.isEdgeLine) {
        return;
      }
      if (obj.userData.edgeIndex !== edgeIndex) {
        return;
      }

      let belongsToShape = false;
      let cur: Object3D | null = obj;
      while (cur) {
        if (cur.userData.shapeId === shapeId && !cur.userData.isMetaShape) {
          belongsToShape = true;
          break;
        }
        cur = cur.parent;
      }
      if (!belongsToShape) {
        return;
      }

      obj.userData.hoverOriginalColor = (obj as any).material.color.getHex();
      (obj as any).material.color.set(themeColors.highlightColor);
      obj.userData.hoverOriginalLineWidth = (obj as any).material.linewidth;
      (obj as any).material.linewidth = HOVER_EDGE_LINE_WIDTH;
    });

    this.ctx.requestRender();
  }

  showCentroid(pos: { x: number; y: number; z: number }): void {
    const radius = this.computeCentroidRadius();
    this.centroidIndicator.show(this.ctx.scene, pos, radius);
    this.ctx.requestRender();
  }

  clearCentroid(): void {
    this.centroidIndicator.clear(this.ctx.scene);
    this.ctx.requestRender();
  }

  dispose(): void {
    this.ctx.dispose();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Compute an edge pick threshold in world units equivalent to ~8 screen pixels,
   * so edge selection scales correctly regardless of model size or zoom level.
   */
  private computeEdgePickThreshold(): number {
    const camera = this.ctx.camera;
    const rect = this.ctx.renderer.domElement.getBoundingClientRect();
    const canvasHeight = rect.height || 1;
    const EDGE_PICK_PIXELS = 8;

    let worldHeight: number;
    const cam = camera as any;
    if (cam.isOrthographicCamera) {
      worldHeight = (cam.top - cam.bottom) / (cam.zoom || 1);
    } else {
      const target = new Vector3();
      this.ctx.cameraControls.getTarget(target);
      const d = camera.position.distanceTo(target);
      const fovRad = (cam.fov * Math.PI) / 180;
      worldHeight = 2 * d * Math.tan(fovRad / 2);
    }

    return (worldHeight / canvasHeight) * EDGE_PICK_PIXELS;
  }

  /** Compute centroid sphere radius as ~1.5 % of the scene diagonal, with a fallback. */
  private computeCentroidRadius(): number {
    const compiled = this.ctx.scene.getObjectByName('compiledMesh');
    if (compiled) {
      const box = new Box3();
      expandBoxExcludingMeta(box, compiled);
      if (!box.isEmpty()) {
        return box.getSize(new Vector3()).length() * 0.015;
      }
    }
    return 2;
  }

  /** Fit the camera to all scene geometry, excluding meta shapes. */
  private fitViewToScene(): void {
    const compiled = this.ctx.scene.getObjectByName('compiledMesh');
    if (!compiled) return;
    const box = new Box3();
    expandBoxExcludingMeta(box, compiled);
    if (!box.isEmpty()) {
      this.ctx.fitToBox(box, true);
    }
  }

  private findShapeById(shapeId: string): SceneObjectPart | undefined {
    for (const obj of this.sceneObjects) {
      for (const part of obj.sceneShapes) {
        if (part.shapeId === shapeId) return part;
      }
    }
    return undefined;
  }

  private findMeshByShapeId(shapeId: string, scope: Object3D): Object3D | undefined {
    let result: Object3D | undefined;
    scope.traverse((child) => {
      if (child.userData.shapeId === shapeId) {
        result = child;
      }
    });
    return result;
  }

  /** Find the last root-level (or Part-child) object — this is the "active" feature.
   *  Returns regardless of visibility so that a non-sketch last item with no shapes
   *  doesn't fall through to an earlier sketch and wrongly enter sketch mode. */
  private findActiveObject(objects: SceneObjectRender[]): SceneObjectRender | undefined {
    for (let i = objects.length - 1; i >= 0; i--) {
      const obj = objects[i];
      if (!obj.parentId) return obj;
      const parent = objects.find(o => o.id === obj.parentId);
      if (parent?.type === 'part') return obj;
    }
    return undefined;
  }

  /** During rollback the current "active" sketch is the rolled-back target's
   *  sketch ancestor (or the target itself if it is a sketch). Returns null
   *  when the target isn't inside a sketch. */
  private findRollbackActiveSketchId(objects: SceneObjectRender[], rollbackStop?: number): string | null {
    if (rollbackStop == null || rollbackStop < 0 || rollbackStop >= objects.length) {
      return null;
    }
    let current: SceneObjectRender | undefined = objects[rollbackStop];
    while (current) {
      if (current.type === 'sketch') {
        return current.id;
      }
      if (!current.parentId) {
        return null;
      }
      current = objects.find(o => o.id === current!.parentId);
    }
    return null;
  }

  /** Check if a new bounding box is still fully visible within the last fitted (padded) sphere.
   *  Returns true when the new box's circumscribed sphere fits inside the old padded sphere,
   *  meaning we can safely skip re-fitting. */
  private isBoxContained(newBox: Box3): boolean {
    if (!this.lastFitBox) return false;

    const oldCenter = this.lastFitBox.getCenter(new Vector3());
    const oldPaddedRadius =
      this.lastFitBox.getSize(new Vector3()).length() / 2 * FIT_PADDING;
    if (oldPaddedRadius === 0) return false;

    const newCenter = newBox.getCenter(new Vector3());
    const newRadius = newBox.getSize(new Vector3()).length() / 2;

    // The new box is contained when its circumscribed sphere fits within
    // the padded sphere we last fitted to.
    return oldCenter.distanceTo(newCenter) + newRadius <= oldPaddedRadius;
  }

  /** Rebuild the scene mesh using the current scene objects (no mode transitions or auto-fit). */
  rebuildSceneMesh(): void {
    if (!this.sceneObjects) {
      return;
    }
    // In assembly mode, the AssemblyController is the source of truth for
    // geometry — its instance groups already render every referenced part
    // at the right pose with connectors hidden. Building a separate
    // `compiledMesh` here would draw each part again at world origin with
    // its connectors visible (they're not inside an instance group, so the
    // controller's `setConnectorsVisible(false)` never sees them) and the
    // stray mesh would only get cleared on the next assembly update — i.e.
    // the user has to edit the file before the rogue connectors disappear.
    if (this.assemblyController?.getContainer().parent) {
      return;
    }
    this.removeCompiledMesh();
    const mesh = buildSceneMesh(this.sceneObjects, this.activeSketchId, this.ctx.camera, this.isRegionPicking);
    this.ctx.scene.add(mesh);
    this.applyShapeOverridesAndPrune(this.sceneObjects);
    if (this.modeManager.isSketchMode && viewerSettings.current.sectionView) {
      this.applySectionView();
    }
    this.ctx.requestRender();
  }

  setShapeVisibility(shapeId: string, visible: boolean): void {
    if (visible) {
      this.hiddenShapeIds.delete(shapeId);
    } else {
      this.hiddenShapeIds.add(shapeId);
    }
    this.applyVisibilityForId(shapeId, visible);
    this.ctx.requestRender();
  }

  isShapeHidden(shapeId: string): boolean {
    return this.hiddenShapeIds.has(shapeId);
  }

  private applyVisibilityForId(shapeId: string, visible: boolean): void {
    this.ctx.scene.traverse((child) => {
      if (child.userData.shapeId === shapeId) {
        child.visible = visible;
      }
    });
  }

  setShapeTransparency(shapeId: string, opacity: number): void {
    if (opacity >= 1) {
      this.shapeOpacities.delete(shapeId);
    } else {
      this.shapeOpacities.set(shapeId, opacity);
    }
    this.applyOpacityForId(shapeId, opacity);
    this.ctx.requestRender();
  }

  getShapeTransparency(shapeId: string): number {
    return this.shapeOpacities.get(shapeId) ?? 1;
  }

  resetAllTransparency(): void {
    if (this.shapeOpacities.size === 0) {
      return;
    }
    const ids = Array.from(this.shapeOpacities.keys());
    this.shapeOpacities.clear();
    for (const id of ids) {
      this.applyOpacityForId(id, 1);
    }
    this.ctx.requestRender();
  }

  private applyOpacityForId(shapeId: string, opacity: number): void {
    const roots: Object3D[] = [];
    this.ctx.scene.traverse((child) => {
      if (child.userData.shapeId === shapeId) {
        roots.push(child);
      }
    });
    for (const root of roots) {
      this.applyOpacityToSubtree(root, opacity);
    }
  }

  private applyOpacityToSubtree(root: Object3D, opacity: number): void {
    root.traverse((child) => {
      const mat = (child as any).material;
      if (!mat) {
        return;
      }
      const materials = Array.isArray(mat) ? mat : [mat];
      for (const m of materials) {
        m.transparent = opacity < 1;
        m.opacity = opacity;
        m.depthWrite = opacity >= 1;
        m.needsUpdate = true;
      }
    });
  }

  private applyShapeOverridesAndPrune(sceneObjects: SceneObjectRender[]): void {
    const presentIds = new Set<string>();
    for (const obj of sceneObjects) {
      if (!obj.sceneShapes) continue;
      for (const shape of obj.sceneShapes) {
        if (shape.isMetaShape) continue;
        if (shape.shapeId) presentIds.add(shape.shapeId);
      }
    }

    for (const id of this.hiddenShapeIds) {
      if (!presentIds.has(id)) this.hiddenShapeIds.delete(id);
    }
    for (const id of this.shapeOpacities.keys()) {
      if (!presentIds.has(id)) this.shapeOpacities.delete(id);
    }

    this.ctx.scene.traverse((child) => {
      const sid = child.userData.shapeId;
      if (typeof sid !== 'string') return;
      if (this.hiddenShapeIds.has(sid)) {
        child.visible = false;
      }
      const opacity = this.shapeOpacities.get(sid);
      if (opacity !== undefined) {
        this.applyOpacityToSubtree(child, opacity);
      }
    });
  }

  // Fake transparency for sketch mode by tinting non-sketch materials toward
  // the scene background. Materials stay fully opaque, so the renderer skips
  // the transparency sort and overdraw blending that was crippling complex
  // scenes. Active sketch subtrees and selection overlays are left untouched.
  private applySketchModeGhosting(): void {
    const compiled = this.ctx.scene.getObjectByName('compiledMesh');
    if (!compiled) { return; }

    const bg = themeColors.backgroundColor;
    for (const child of compiled.children) {
      this.tintForGhosting(child, bg);
    }
  }

  private tintForGhosting(node: Object3D, bg: Color): void {
    if (node.userData.isSketchRoot) { return; }
    if (node.renderOrder >= 999) { return; }

    const mat = (node as any).material;
    if (mat) {
      const materials = Array.isArray(mat) ? mat : [mat];
      for (const m of materials) {
        if (!m.color || !(m.color instanceof Color)) { continue; }
        if (!m.userData.ghostOriginalColor) {
          m.userData.ghostOriginalColor = m.color.clone();
        }
        m.color.copy(m.userData.ghostOriginalColor).lerp(bg, SKETCH_GHOST_TINT_FACTOR);
      }
    }

    for (const c of node.children) {
      this.tintForGhosting(c, bg);
    }
  }

  private applySectionView(): void {
    const plane = this.modeManager.sectionPlane;
    if (!plane) { return; }

    const compiled = this.ctx.scene.getObjectByName('compiledMesh');
    if (!compiled) { return; }

    this.forEachClippableMaterial(compiled, (m) => { m.clippingPlanes = [plane]; });

    this.ctx.requestRender();
  }

  private clearSectionView(): void {
    const compiled = this.ctx.scene.getObjectByName('compiledMesh');
    if (!compiled) { return; }

    this.forEachClippableMaterial(compiled, (m) => { m.clippingPlanes = []; });

    this.ctx.requestRender();
  }

  // Walk the subtree, skipping sketch UI (it lives on the section plane and
  // would be half-clipped by it). Visit each material exactly once.
  private forEachClippableMaterial(root: Object3D, fn: (m: any) => void): void {
    if (root.userData.isSketchRoot) { return; }
    const mat = (root as any).material;
    if (mat) {
      const materials = Array.isArray(mat) ? mat : [mat];
      for (const m of materials) {
        fn(m);
      }
    }
    for (const child of root.children) {
      this.forEachClippableMaterial(child, fn);
    }
  }

  /** Remove the previous compiled mesh tree and dispose its GPU resources. */
  private removeCompiledMesh(): void {
    const existing = this.ctx.scene.getObjectByName('compiledMesh');
    if (!existing) return;

    existing.traverse((child: Object3D & { geometry?: any; material?: any }) => {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) {
        child.material.forEach(m => m.dispose());
      } else {
        child.material?.dispose();
      }
    });

    this.ctx.scene.remove(existing);
  }
}
