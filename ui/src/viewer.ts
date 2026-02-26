import { Box3, LineSegments, Mesh, Object3D, Vector3 } from 'three';
import { SceneContext } from './scene/scene-context';
import { SceneModeManager } from './scene/scene-mode';
import { buildSceneMesh } from './meshes/mesh-factory';
import { SceneObjectPart, SceneObjectRender } from './types';
import { SettingsPanel } from './ui/settings-panel';

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
  private hasRendered = false;
  private lastFitBox: Box3 | null = null;
  private fileNamePill: HTMLDivElement;

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
      const box = new Box3().setFromObject(mesh);
      if (!box.isEmpty() && !this.isBoxSimilar(box)) {
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
    if (!this.highlightedShapeId) return;

    this.ctx.scene.traverse((child) => {
      if (child.userData.originalColor !== undefined) {
        (child as any).material.color.setHex(child.userData.originalColor);
        delete child.userData.originalColor;
      }
    });

    this.highlightedShapeId = null;
    this.ctx.render();
  }

  dispose(): void {
    this.ctx.dispose();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Fit the camera to all scene geometry. */
  private fitViewToScene(): void {
    const compiled = this.ctx.scene.getObjectByName('compiledMesh');
    if (!compiled) return;
    const box = new Box3().setFromObject(compiled);
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

  /** Check if a new bounding box is close enough to the last fitted box to skip re-fitting. */
  private isBoxSimilar(box: Box3): boolean {
    if (!this.lastFitBox) return false;

    const oldSize = this.lastFitBox.getSize(new Vector3());
    const oldDiag = oldSize.length();
    if (oldDiag === 0) return false;

    const oldCenter = this.lastFitBox.getCenter(new Vector3());
    const newCenter = box.getCenter(new Vector3());
    const newSize = box.getSize(new Vector3());
    const newDiag = newSize.length();

    // Skip fit if center shifted less than 30% and size changed less than 30%
    const centerShift = oldCenter.distanceTo(newCenter) / oldDiag;
    const sizeChange = Math.abs(newDiag - oldDiag) / oldDiag;
    return centerShift < 0.3 && sizeChange < 0.3;
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
