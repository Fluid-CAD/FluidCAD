import { Mesh, MeshBasicMaterial, Object3D } from 'three';
import { SceneContext } from '../scene/scene-context';

const HOVER_OPACITY = 0.18;

/**
 * Interactive mode for the trim dialog's By Region tab: raycasts the
 * trim-region meta faces (the cells the surviving split segments partition
 * the plane into), brightening the hovered cell's fill and reporting the
 * ids of its boundary segments for highlighting; a click reports them for
 * trimming.
 */
export class TrimRegionMode {
  private canvas: HTMLCanvasElement;
  private ctx: SceneContext;
  private onHighlight: (edgeIds: string[] | null) => void;
  private onPickRegion: (edgeIds: string[]) => void;

  private highlightedMesh: Mesh | null = null;

  private downX = 0;
  private downY = 0;

  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;

  constructor(
    ctx: SceneContext,
    onHighlight: (edgeIds: string[] | null) => void,
    onPickRegion: (edgeIds: string[]) => void,
  ) {
    this.canvas = ctx.renderer.domElement;
    this.ctx = ctx;
    this.onHighlight = onHighlight;
    this.onPickRegion = onPickRegion;

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
    this.onHighlight(null);
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

    const hit = this.raycastRegions(e.clientX, e.clientY);
    if (!hit) {
      return;
    }
    const edgeIds = this.edgeIdsOf(hit);
    if (edgeIds.length > 0) {
      this.onPickRegion(edgeIds);
    }
  }

  private handleMouseMove(e: MouseEvent): void {
    const hitMesh = this.raycastRegions(e.clientX, e.clientY);

    if (hitMesh === this.highlightedMesh) {
      return;
    }

    this.restoreHighlight();

    if (hitMesh) {
      (hitMesh.material as MeshBasicMaterial).opacity = HOVER_OPACITY;
      this.highlightedMesh = hitMesh;
      this.onHighlight(this.edgeIdsOf(hitMesh));
    } else {
      this.onHighlight(null);
    }
    this.ctx.requestRender();
  }

  /** The boundary segment ids riding on the region group's metaData. */
  private edgeIdsOf(mesh: Mesh): string[] {
    let obj: Object3D | null = mesh;
    while (obj) {
      if (obj.userData.isTrimRegion) {
        const ids = obj.userData.metaData?.edgeIds;
        return Array.isArray(ids) ? ids : [];
      }
      obj = obj.parent;
    }
    return [];
  }

  private restoreHighlight(): void {
    if (this.highlightedMesh) {
      (this.highlightedMesh.material as MeshBasicMaterial).opacity = 0;
      this.highlightedMesh = null;
    }
  }

  private raycastRegions(clientX: number, clientY: number): Mesh | null {
    const renderer = this.ctx.renderer;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = this.ctx.createPickingRaycaster(ndcX, ndcY);

    const regionMeshes: Mesh[] = [];
    this.ctx.scene.traverse((obj: Object3D) => {
      if (obj.userData.isTrimRegion) {
        for (const child of obj.children) {
          if ((child as Mesh).isMesh) {
            regionMeshes.push(child as Mesh);
          }
        }
      }
    });

    if (regionMeshes.length === 0) {
      return null;
    }

    const intersects = raycaster.intersectObjects(regionMeshes, false);
    return intersects.length > 0 ? (intersects[0].object as Mesh) : null;
  }
}
