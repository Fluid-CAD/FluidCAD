import { Mesh, MeshBasicMaterial, Object3D, Vector3 } from 'three';
import { SceneContext } from '../scene/scene-context';

const HOVER_COLOR = '#64B5F6';
const HOVER_OPACITY = 0.35;

/**
 * Interactive mode for picking face regions in the sketch.
 *
 * Uses Three.js raycasting against meta face meshes (pick-region / pick-region-selected)
 * to detect hover and click on individual sketch regions. Each region group
 * carries its region key in `userData.metaData.key`; a click reports that key.
 */
export class RegionPickMode {
  private canvas: HTMLCanvasElement;
  private ctx: SceneContext;
  private onPick: (key: string) => void;
  private onRemove: (key: string) => void;
  private onHighlight: (shapeId: string | null) => void;

  private highlightedMesh: Mesh | null = null;
  private highlightedOriginalColor: number | null = null;
  private highlightedOriginalOpacity: number | null = null;

  private downX = 0;
  private downY = 0;

  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;

  constructor(
    ctx: SceneContext,
    onPick: (key: string) => void,
    onRemove: (key: string) => void,
    onHighlight: (shapeId: string | null) => void,
  ) {
    this.canvas = ctx.renderer.domElement;
    this.ctx = ctx;
    this.onPick = onPick;
    this.onRemove = onRemove;
    this.onHighlight = onHighlight;

    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
    this.boundMouseMove = this.handleMouseMove.bind(this);
  }

  activate(): void {
    this.canvas.addEventListener('mousedown', this.boundMouseDown);
    this.canvas.addEventListener('mouseup', this.boundMouseUp);
    this.canvas.addEventListener('mousemove', this.boundMouseMove);
  }

  deactivate(): void {
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.canvas.removeEventListener('mousemove', this.boundMouseMove);
    this.restoreHighlight();
  }

  private handleMouseDown(e: MouseEvent): void {
    this.downX = e.clientX;
    this.downY = e.clientY;
  }

  private handleMouseUp(e: MouseEvent): void {
    const dx = e.clientX - this.downX;
    const dy = e.clientY - this.downY;
    if (dx * dx + dy * dy > 64) {
      return; // drag, not click
    }

    // Raycast directly to find the region under the click
    const hit = this.raycastRegions(e.clientX, e.clientY);
    if (!hit) {
      return;
    }

    const hitGroup = hit.mesh.parent;
    const key = hitGroup?.userData.metaData?.key;
    if (typeof key !== 'string') {
      return;
    }

    if (hitGroup.userData.isPickRegionSelected === true) {
      this.onRemove(key);
    } else {
      this.onPick(key);
    }
  }

  private handleMouseMove(e: MouseEvent): void {
    const hit = this.raycastRegions(e.clientX, e.clientY);
    const hitMesh = hit?.mesh ?? null;

    if (hitMesh === this.highlightedMesh) {
      return; // Same mesh, no change
    }

    // Restore previous highlight
    this.restoreHighlight();

    if (hitMesh) {
      // Apply hover highlight
      const mat = hitMesh.material as MeshBasicMaterial;
      this.highlightedOriginalColor = mat.color.getHex();
      this.highlightedOriginalOpacity = mat.opacity;
      mat.color.set(HOVER_COLOR);
      mat.opacity = HOVER_OPACITY;
      this.highlightedMesh = hitMesh;

      // Find shapeId from parent group
      let shapeId: string | null = null;
      let obj: Object3D | null = hitMesh;
      while (obj) {
        if (obj.userData.shapeId) {
          shapeId = obj.userData.shapeId;
          break;
        }
        obj = obj.parent;
      }
      this.onHighlight(shapeId);
      this.ctx.requestRender();
    } else {
      this.highlightedMesh = null;
      this.onHighlight(null);
      this.ctx.requestRender();
    }
  }

  private restoreHighlight(): void {
    if (this.highlightedMesh) {
      const mat = this.highlightedMesh.material as MeshBasicMaterial;
      if (this.highlightedOriginalColor !== null) {
        mat.color.setHex(this.highlightedOriginalColor);
      }
      if (this.highlightedOriginalOpacity !== null) {
        mat.opacity = this.highlightedOriginalOpacity;
      }
      this.highlightedMesh = null;
      this.highlightedOriginalColor = null;
      this.highlightedOriginalOpacity = null;
    }
  }

  /** Raycast against pick-region meta face meshes and return the closest hit Mesh + world point. */
  private raycastRegions(clientX: number, clientY: number): { mesh: Mesh; point: Vector3 } | null {
    const renderer = this.ctx.renderer;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = this.ctx.createPickingRaycaster(ndcX, ndcY);

    // Collect all pick-region meshes from the scene
    const regionMeshes: Mesh[] = [];
    this.ctx.scene.traverse((obj: Object3D) => {
      if (obj.userData.isPickRegion && obj.children) {
        for (const child of obj.children) {
          if ((child as any).isMesh) {
            regionMeshes.push(child as Mesh);
          }
        }
      }
    });

    if (regionMeshes.length === 0) {
      return null;
    }

    const intersects = raycaster.intersectObjects(regionMeshes, false);
    if (intersects.length === 0) {
      return null;
    }
    return { mesh: intersects[0].object as Mesh, point: intersects[0].point };
  }
}
