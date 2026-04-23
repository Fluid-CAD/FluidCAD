import { Box3, BufferAttribute, BufferGeometry, Color, LineSegments, Mesh, MeshPhongMaterial, Object3D, Raycaster, Vector2, Vector3 } from 'three';
import { FIT_PADDING, SceneContext } from './scene/scene-context';
import { SceneModeManager } from './scene/scene-mode';
import { buildSceneMesh } from './meshes/mesh-factory';
import { SceneObjectPart, SceneObjectRender, SubSelection } from './types';
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

const HIGHLIGHT_FACE_COLOR = '#ffc578';
const HIGHLIGHT_EDGE_COLOR = '#ffc578';

const HOVER_FACE_COLOR = '#64B5F6';
const HOVER_EDGE_COLOR = '#64B5F6';
const HOVER_FACE_OPACITY = 0.3;

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
  isBezierDrawing = false;

  private selectionHandler: ((shapeId: string | null, sub: SubSelection) => void) | null = null;
  private centroidIndicator = new CentroidIndicator();
  private hoverState: { shapeId: string; sub: SubSelection } | null = null;
  private hoverFaceOverlayMeshes: Mesh[] = [];
  private hoverRafId: number | null = null;
  private isMouseDown = false;
  private highlightedSub: SubSelection = null;
  private activeSketchId: string | null = null;
  private hiddenShapeIndices = new Set<number>();
  private shapeOpacities = new Map<number, number>();

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

  setSelectionHandler(fn: (shapeId: string | null, sub: SubSelection) => void): void {
    this.selectionHandler = fn;
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
      if (!this.selectionHandler || this.isTrimming || this.isRegionPicking || this.isBezierDrawing || this.modeManager.isSketchMode) {
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
        this.selectionHandler(result.shapeId, result.sub);
      } else {
        this.selectionHandler(null, null);
      }
    });
  }

  /**
   * Client-side raycaster picking across all shapes.  Returns the closest
   * front-facing face or edge hit together with its shapeId.
   */
  private pickAt(clientX: number, clientY: number): { shapeId: string; sub: SubSelection } | null {
    const camera = this.ctx.camera;
    const rect = this.ctx.renderer.domElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new Raycaster();
    raycaster.setFromCamera(new Vector2(ndcX, ndcY), camera);
    raycaster.params.Line = { threshold: this.computeEdgePickThreshold() };

    const faceCandidates: Mesh[] = [];
    const edgeCandidates: LineSegments[] = [];

    this.ctx.scene.traverse((obj) => {
      if (obj.userData.isMetaShape) {
        return;
      }
      if ((obj as Mesh).isMesh && obj.userData.faceMapping) {
        faceCandidates.push(obj as Mesh);
      } else if ((obj as LineSegments).isLine && obj.userData.edgeIndex !== undefined) {
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
      const geo = (edgeHit.object as LineSegments).geometry;
      const pos = geo.getAttribute('position') as BufferAttribute;
      const idx = geo.getIndex();
      if (idx !== null && edgeHit.faceIndex != null) {
        const a = idx.getX(edgeHit.faceIndex * 2);
        const b = idx.getX(edgeHit.faceIndex * 2 + 1);
        const v0 = new Vector3().fromBufferAttribute(pos, a).applyMatrix4(edgeHit.object.matrixWorld);
        const v1 = new Vector3().fromBufferAttribute(pos, b).applyMatrix4(edgeHit.object.matrixWorld);
        raycaster.ray.distanceSqToSegment(v0, v1, undefined, segPt);
      } else {
        segPt.copy(edgeHit.point);
      }
      const edgeDist = rayDir.dot(toSeg.copy(segPt).sub(rayOrigin));
      if (edgeDist <= faceDist + 1e-3) {
        const edgeIndex = edgeHit.object.userData.edgeIndex as number;
        const shapeId = this.findShapeIdForObject(edgeHit.object);
        if (shapeId) {
          return { shapeId, sub: { type: 'edge', index: edgeIndex } };
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
        return { shapeId, sub: { type: 'face', index: faceIndex } };
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

  updateView(sceneObjects: SceneObjectRender[], isRollback = false): void {
    this.sceneObjects = sceneObjects;
    this.highlightedShapeId = null;
    this.highlightedSub = null;
    this.hoverState = null;
    this.hoverFaceOverlayMeshes = [];
    this.ctx.renderer.domElement.style.cursor = '';

    this.removeCompiledMesh();

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
    }

    const mesh = buildSceneMesh(sceneObjects, this.activeSketchId, this.ctx.camera, this.isRegionPicking);
    this.ctx.scene.add(mesh);
    this.applyHiddenShapes();
    this.applyShapeOpacities();

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

    // Auto-fit on first render or in sketch mode (skip if viewport barely changed or trimming)
    if (!this.hasRendered || (this.modeManager.isSketchMode && !isRollback && !this.isTrimming && !this.isRegionPicking && !this.isBezierDrawing)) {
      const box = new Box3();
      expandBoxExcludingMeta(box, mesh);
      if (!box.isEmpty() && !this.isBoxContained(box)) {
        this.ctx.fitToBox(box, true);
        this.lastFitBox = box.clone();
        this.hasRendered = true;
      }
    }

    this.ctx.requestRender();
  }

  highlightShape(shapeId: string): void {
    this.clearHighlight();

    const part = this.findShapeById(shapeId);
    if (!part) return;

    const group = this.findMeshByShapeId(shapeId);
    if (!group) return;

    const isFaceHighlight = part.shapeType === 'solid' || part.shapeType === 'face';

    group.traverse((child) => {
      if (!(child as any).material) return;

      if (isFaceHighlight && child instanceof Mesh) {
        child.userData.originalColor = (child as any).material.color.getHex();
        (child as any).material.color.set(HIGHLIGHT_FACE_COLOR);
      } else if (!isFaceHighlight && child instanceof LineSegments) {
        child.userData.originalColor = (child as any).material.color.getHex();
        (child as any).material.color.set(HIGHLIGHT_EDGE_COLOR);
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
    });

    for (const m of this.faceHighlightMeshes) {
      m.parent?.remove(m);
      m.geometry.dispose();
      (m.material as MeshPhongMaterial).dispose();
    }
    this.faceHighlightMeshes = [];

    this.highlightedShapeId = null;
    this.highlightedSub = null;
    this.ctx.render();
  }

  highlightFace(shapeId: string, faceIndex: number): void {
    this.clearHighlight();

    this.ctx.scene.traverse((obj) => {
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
        color: HIGHLIGHT_FACE_COLOR,
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

  highlightEdge(shapeId: string, edgeIndex: number): void {
    this.clearHighlight();

    this.ctx.scene.traverse((obj) => {
      if (!(obj as LineSegments).isLine) {
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
      (obj as any).material.color.set(HIGHLIGHT_EDGE_COLOR);
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
      this.clearHover();
    });

    canvas.addEventListener('mouseup', () => {
      this.isMouseDown = false;
    });

    canvas.addEventListener('mousemove', (e) => {
      if (this.isMouseDown || this.isTrimming || this.isRegionPicking || this.isBezierDrawing || this.modeManager.isSketchMode) {
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
    });
  }

  private updateHover(clientX: number, clientY: number): void {
    if (!this.selectionHandler) {
      return;
    }

    const result = this.pickAt(clientX, clientY);

    // Same as current hover — skip.
    if (this.hoverState && result &&
        this.hoverState.shapeId === result.shapeId &&
        this.hoverState.sub?.type === result.sub?.type &&
        this.hoverState.sub?.index === result.sub?.index) {
      return;
    }

    // Nothing hovered — clear and return.
    if (!result) {
      if (this.hoverState) {
        this.clearHover();
      }
      return;
    }

    // Don't hover-highlight the currently selected face/edge.
    if (this.highlightedShapeId === result.shapeId &&
        this.highlightedSub?.type === result.sub?.type &&
        this.highlightedSub?.index === result.sub?.index) {
      if (this.hoverState) {
        this.clearHover();
      }
      return;
    }

    this.clearHover();
    this.hoverState = result;
    this.ctx.renderer.domElement.style.cursor = 'pointer';

    if (result.sub?.type === 'face') {
      this.applyHoverFace(result.shapeId, result.sub.index);
    } else if (result.sub?.type === 'edge') {
      this.applyHoverEdge(result.shapeId, result.sub.index);
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
    });

    this.hoverState = null;
    this.ctx.renderer.domElement.style.cursor = '';
    this.ctx.requestRender();
  }

  private applyHoverFace(shapeId: string, faceIndex: number): void {
    this.ctx.scene.traverse((obj) => {
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
        color: HOVER_FACE_COLOR,
        transparent: true,
        opacity: HOVER_FACE_OPACITY,
        depthWrite: false,
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

  private applyHoverEdge(shapeId: string, edgeIndex: number): void {
    this.ctx.scene.traverse((obj) => {
      if (!(obj as LineSegments).isLine) {
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
      (obj as any).material.color.set(HOVER_EDGE_COLOR);
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

  private findMeshByShapeId(shapeId: string): Object3D | undefined {
    let result: Object3D | undefined;
    this.ctx.scene.traverse((child) => {
      if (child.userData.shapeId === shapeId) {
        result = child;
      }
    });
    return result;
  }

  /** Find the last root-level (no parent) visible object — this is the "active" feature.
   *  Sketches are always considered even when not visible (empty sketch with no shapes yet). */
  private findActiveObject(objects: SceneObjectRender[]): SceneObjectRender | undefined {
    for (let i = objects.length - 1; i >= 0; i--) {
      const obj = objects[i];
      if (!obj.parentId && (obj.visible || obj.type === 'sketch')) return obj;
      // Also consider objects that are direct children of a Part container
      if (obj.parentId && (obj.visible || obj.type === 'sketch')) {
        const parent = objects.find(o => o.id === obj.parentId);
        if (parent?.type === 'part') return obj;
      }
    }
    return undefined;
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
    this.removeCompiledMesh();
    const mesh = buildSceneMesh(this.sceneObjects, this.activeSketchId, this.ctx.camera, this.isRegionPicking);
    this.ctx.scene.add(mesh);
    this.applyHiddenShapes();
    this.applyShapeOpacities();
    if (this.modeManager.isSketchMode && viewerSettings.current.sectionView) {
      this.applySectionView();
    }
    this.ctx.requestRender();
  }

  setShapeVisibility(shapeId: string, visible: boolean): void {
    const shapeIndex = this.findShapeIndexForId(shapeId);
    if (shapeIndex === undefined) {
      return;
    }
    if (visible) {
      this.hiddenShapeIndices.delete(shapeIndex);
    } else {
      this.hiddenShapeIndices.add(shapeIndex);
    }
    this.applyVisibilityForIndex(shapeIndex, visible);
    this.ctx.requestRender();
  }

  isShapeHidden(shapeId: string): boolean {
    const shapeIndex = this.findShapeIndexForId(shapeId);
    if (shapeIndex === undefined) {
      return false;
    }
    return this.hiddenShapeIndices.has(shapeIndex);
  }

  private applyVisibilityForIndex(shapeIndex: number, visible: boolean): void {
    this.ctx.scene.traverse((child) => {
      if (child.userData.shapeIndex === shapeIndex) {
        child.visible = visible;
      }
    });
  }

  setShapeTransparency(shapeId: string, opacity: number): void {
    const shapeIndex = this.findShapeIndexForId(shapeId);
    if (shapeIndex === undefined) {
      return;
    }
    if (opacity >= 1) {
      this.shapeOpacities.delete(shapeIndex);
    } else {
      this.shapeOpacities.set(shapeIndex, opacity);
    }
    this.applyOpacityForIndex(shapeIndex, opacity);
    this.ctx.requestRender();
  }

  getShapeTransparency(shapeId: string): number {
    const shapeIndex = this.findShapeIndexForId(shapeId);
    if (shapeIndex === undefined) {
      return 1;
    }
    return this.shapeOpacities.get(shapeIndex) ?? 1;
  }

  private findShapeIndexForId(shapeId: string): number | undefined {
    let result: number | undefined;
    this.ctx.scene.traverse((child) => {
      if (child.userData.shapeId === shapeId && typeof child.userData.shapeIndex === 'number') {
        result = child.userData.shapeIndex;
      }
    });
    return result;
  }

  private applyOpacityForIndex(shapeIndex: number, opacity: number): void {
    const roots: Object3D[] = [];
    this.ctx.scene.traverse((child) => {
      if (child.userData.shapeIndex === shapeIndex) {
        roots.push(child);
      }
    });
    for (const root of roots) {
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
  }

  private applyShapeOpacities(): void {
    for (const [shapeIndex, opacity] of this.shapeOpacities) {
      this.applyOpacityForIndex(shapeIndex, opacity);
    }
  }

  private applyHiddenShapes(): void {
    for (const shapeIndex of this.hiddenShapeIndices) {
      this.applyVisibilityForIndex(shapeIndex, false);
    }
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

    compiled.traverse((child) => {
      const mat = (child as any).material;
      if (!mat) { return; }
      const materials = Array.isArray(mat) ? mat : [mat];
      for (const m of materials) {
        m.clippingPlanes = [plane];
      }
    });

    this.ctx.requestRender();
  }

  private clearSectionView(): void {
    const compiled = this.ctx.scene.getObjectByName('compiledMesh');
    if (!compiled) { return; }

    compiled.traverse((child) => {
      const mat = (child as any).material;
      if (!mat) { return; }
      const materials = Array.isArray(mat) ? mat : [mat];
      for (const m of materials) {
        m.clippingPlanes = [];
      }
    });

    this.ctx.requestRender();
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
