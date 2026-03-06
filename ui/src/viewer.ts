import { Box3, BufferAttribute, BufferGeometry, Color, LineSegments, Mesh, MeshBasicMaterial, MeshPhongMaterial, Object3D, Raycaster, Vector2, Vector3, WebGLRenderTarget } from 'three';
import { FIT_PADDING, SceneContext } from './scene/scene-context';
import { SceneModeManager } from './scene/scene-mode';
import { buildSceneMesh } from './meshes/mesh-factory';
import { SceneObjectPart, SceneObjectRender, SubSelection } from './types';
import { SettingsPanel } from './ui/settings-panel';
import { CentroidIndicator } from './scene/centroid-indicator';

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

const FILENAME_PILL_STYLES = `
.filename-pill {
  position: absolute;
  bottom: 16px;
  left: 16px;
  z-index: 100;
  background: rgba(30, 30, 30, 0.85);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-radius: 9999px;
  padding: 4px 14px;
  color: #bbb;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 12px;
  white-space: nowrap;
  user-select: none;
  pointer-events: none;
}
`;

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
  private fileNamePill: HTMLDivElement;
  private selectionHandler: ((shapeId: string | null, sub: SubSelection) => void) | null = null;
  private pickTarget: WebGLRenderTarget | null = null;
  private centroidIndicator = new CentroidIndicator();

  constructor(containerId: string) {
    const container = document.getElementById(containerId)!;
    this.ctx = new SceneContext(container);
    this.modeManager = new SceneModeManager(this.ctx);
    this.settingsPanel = new SettingsPanel(container, (mode) => this.ctx.switchCamera(mode));
    this.settingsPanel.setFitHandler(() => this.fitViewToScene());

    if (!document.getElementById('filename-pill-styles')) {
      const style = document.createElement('style');
      style.id = 'filename-pill-styles';
      style.textContent = FILENAME_PILL_STYLES;
      document.head.appendChild(style);
    }

    this.fileNamePill = document.createElement('div');
    this.fileNamePill.className = 'filename-pill';
    this.fileNamePill.style.display = 'none';
    container.appendChild(this.fileNamePill);

    this.initClickDetection();
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

    canvas.addEventListener('mouseup', async (e) => {
      if (!this.selectionHandler) {
        return;
      }
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      if (dx * dx + dy * dy > 64) {
        return; // was a drag (> 8px)
      }

      const shapeId = this.pickShapeAt(e.clientX, e.clientY);
      if (!shapeId) {
        this.selectionHandler(null, null);
        return;
      }
      const sub = await this.pickSubAtServer(e.clientX, e.clientY, shapeId);
      this.selectionHandler(shapeId, sub);
    });

  }

  private computeWorldRay(clientX: number, clientY: number): { origin: [number, number, number]; dir: [number, number, number] } {
    const renderer = this.ctx.renderer;
    const camera = this.ctx.camera;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new Raycaster();
    raycaster.setFromCamera(new Vector2(ndcX, ndcY), camera);

    const o = raycaster.ray.origin;
    const d = raycaster.ray.direction;
    return {
      origin: [o.x, o.y, o.z],
      dir: [d.x, d.y, d.z],
    };
  }

  private async pickSubAtServer(clientX: number, clientY: number, shapeId: string): Promise<SubSelection> {
    const { origin, dir } = this.computeWorldRay(clientX, clientY);
    const edgeThreshold = this.computeEdgePickThreshold();
    try {
      const response = await fetch('/api/hit-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shapeId, rayOrigin: origin, rayDir: dir, edgeThreshold }),
      });
      if (!response.ok) {
        return null;
      }
      const result = await response.json();
      return result ?? null;
    } catch {
      return null;
    }
  }

  /**
   * GPU colour-picking: renders every shape with a unique flat colour into an
   * off-screen buffer, then reads the single pixel under the cursor.
   * Pixel-perfect regardless of zoom level, camera angle, or surface curvature.
   */
  private pickShapeAt(clientX: number, clientY: number): string | null {
    const renderer = this.ctx.renderer;
    const camera = this.ctx.camera;
    const canvasW = renderer.domElement.width;
    const canvasH = renderer.domElement.height;

    if (!this.pickTarget || this.pickTarget.width !== canvasW || this.pickTarget.height !== canvasH) {
      this.pickTarget?.dispose();
      this.pickTarget = new WebGLRenderTarget(canvasW, canvasH);
    }

    const shapeToColor = new Map<string, number>();
    const colorToShape = new Map<number, string>();
    let colorIndex = 1;
    const meshesToRestore: { mesh: Mesh; mat: any }[] = [];

    // For each leaf Mesh, walk up to find its shapeId and assign a unique colour.
    this.ctx.scene.traverse((obj) => {
      if (!(obj as Mesh).isMesh) {
        return;
      }
      let shapeId: string | undefined;
      let cur: Object3D | null = obj;
      while (cur) {
        if (cur.userData.shapeId && !cur.userData.isMetaShape) {
          shapeId = cur.userData.shapeId as string;
          break;
        }
        cur = cur.parent;
      }
      if (!shapeId) {
        return;
      }

      if (!shapeToColor.has(shapeId)) {
        const c = colorIndex++;
        shapeToColor.set(shapeId, c);
        colorToShape.set(c, shapeId);
      }
      const c = shapeToColor.get(shapeId)!;

      const mesh = obj as Mesh;
      meshesToRestore.push({ mesh, mat: mesh.material });
      mesh.material = new MeshBasicMaterial({
        color: new Color(
          ((c >> 16) & 0xff) / 255,
          ((c >> 8) & 0xff) / 255,
          (c & 0xff) / 255,
        ),
      });
    });

    // Render picking scene to off-screen target.
    const prevTarget = renderer.getRenderTarget();
    const prevClearColor = new Color();
    const prevClearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(prevClearColor);

    renderer.setRenderTarget(this.pickTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(this.ctx.scene, camera);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClearColor, prevClearAlpha);

    // Restore original materials.
    for (const { mesh, mat } of meshesToRestore) {
      (mesh.material as MeshBasicMaterial).dispose();
      mesh.material = mat;
    }

    // Read pixel (WebGL Y is bottom-up).
    const rect = renderer.domElement.getBoundingClientRect();
    const dpr = renderer.getPixelRatio();
    const px = Math.floor((clientX - rect.left) * dpr);
    const py = Math.floor((rect.height - (clientY - rect.top)) * dpr);

    if (px < 0 || px >= canvasW || py < 0 || py >= canvasH) {
      return null;
    }

    const pixel = new Uint8Array(4);
    renderer.readRenderTargetPixels(this.pickTarget, px, py, 1, 1, pixel);

    const encoded = (pixel[0] << 16) | (pixel[1] << 8) | pixel[2];
    if (encoded === 0) {
      return null;
    }
    return colorToShape.get(encoded) ?? null;
  }

  /**
   * Raycaster sub-selection picking: given a shapeId already identified by GPU picking,
   * find which OCC face or edge was hit. Whichever intersection has a smaller distance wins.
   */
  private pickSubAt(clientX: number, clientY: number, shapeId: string): SubSelection {
    const renderer = this.ctx.renderer;
    const camera = this.ctx.camera;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new Raycaster();
    raycaster.setFromCamera(new Vector2(ndcX, ndcY), camera);
    raycaster.params.Line = { threshold: this.computeEdgePickThreshold() };

    const faceCandidates: Mesh[] = [];
    const edgeCandidates: LineSegments[] = [];

    this.ctx.scene.traverse((obj) => {
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

    // For faces: pick the closest hit whose triangle normal actually faces the camera.
    // This guards against back-face or opposite-side hits that can occur on concave or
    // complex boolean shapes even with FrontSide material (e.g. mis-wound normals).
    // Do NOT fall back to faceHits[0] if no front-facing hit is found — a back-face
    // fallback would give a large faceDepth that lets back edges pass the depth check.
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

    // Edge depth test.
    //
    // Key insight: Three.js sets hit.point for lines to the closest point ON THE RAY, not
    // on the segment.  At oblique angles this is far from the actual edge surface, so any
    // depth comparison using hit.point is unreliable.  We use ray.distanceSqToSegment to
    // recover the actual closest point on the segment (segPt).
    //
    // Depth metric: project segPt onto the pick ray and compare with bestFace.distance.
    // Both values are scalars along the same ray, so they are directly comparable at any
    // viewing angle and for both orthographic and perspective cameras.  viewDir.dot() was
    // wrong here because for off-centre pixels the per-pixel ray direction ≠ viewDir,
    // which caused diagonal back edges to pass the check by having the same viewDir
    // projection as the front face despite being physically behind it.
    //
    // When there is no face hit (tessellation seam gap) faceDist = Infinity so any edge
    // candidate wins.  We iterate all hits (sorted closest-first) so a back edge that
    // happens to rank first does not block a valid front edge later in the list.
    const faceDist = bestFace != null ? bestFace.distance : Infinity;
    const rayOrigin = raycaster.ray.origin;
    const rayDir = raycaster.ray.direction; // normalised by setFromCamera
    const segPt = new Vector3();
    const toSeg = new Vector3();
    for (const edgeHit of edgeHits) {
      // Recover actual closest point on the edge segment.
      const geo = edgeHit.object.geometry;
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
      // Depth of the edge along the pick ray (comparable to bestFace.distance).
      const edgeDist = rayDir.dot(toSeg.copy(segPt).sub(rayOrigin));
      // Tiny seam tolerance (1e-3 world units) for OCC boundary tessellation gaps.
      if (edgeDist <= faceDist + 1e-3) {
        const edgeIndex = edgeHit.object.userData.edgeIndex as number;
        return { type: 'edge', index: edgeIndex };
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
      return { type: 'face', index: faceIndex };
    }

    return null;
  }

  toggleSketchMode(enable: boolean): void {
    this.modeManager.sketchEnabled = enable;
  }

  setFileName(absPath: string): void {
    const name = absPath.split('/').pop() ?? absPath;
    this.fileNamePill.textContent = name;
    this.fileNamePill.style.display = '';
  }

  updateView(sceneObjects: SceneObjectRender[], isRollback = false): void {
    this.sceneObjects = sceneObjects;
    this.highlightedShapeId = null;

    this.removeCompiledMesh();

    if (!isRollback) {
      const activeObject = this.findActiveObject(sceneObjects);

      if (activeObject?.type === 'sketch' && activeObject.object?.plane) {
        this.modeManager.enterSketchMode(activeObject.object.plane);
        this.settingsPanel.setProjectionLocked(true);
        this.settingsPanel.setFitButtonVisible(false);
      } else {
        this.modeManager.enterDefaultMode();
        this.settingsPanel.setProjectionLocked(false);
        this.settingsPanel.setFitButtonVisible(true);
        this.lastFitBox = null;
      }
    }

    const mesh = buildSceneMesh(sceneObjects, this.modeManager.isSketchMode);
    this.ctx.scene.add(mesh);

    // Auto-fit on first render or in sketch mode (skip if viewport barely changed)
    if (!this.hasRendered || (this.modeManager.isSketchMode && !isRollback)) {
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
      }
    });

    this.highlightedShapeId = shapeId;
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
    });

    for (const m of this.faceHighlightMeshes) {
      m.parent?.remove(m);
      m.geometry.dispose();
      (m.material as MeshPhongMaterial).dispose();
    }
    this.faceHighlightMeshes = [];

    this.highlightedShapeId = null;
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
    this.ctx.render();
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
