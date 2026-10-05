import { Mesh, MeshBasicMaterial, Object3D, Vector3 } from 'three';
import { SceneContext } from '../scene/scene-context';

const HOVER_COLOR = '#64B5F6';
const HOVER_OPACITY = 0.35;

/**
 * Click and hover handling for a set of drawn sketch regions — the region
 * picker's overlay. Raycasts the pick-region meshes under `root` (each group
 * carries its region label in `userData.metaData.key` and its pick state in
 * `userData.isPickRegionSelected`); a click reports the key as a pick or a
 * removal, a hover tints the face. Scoped to `root` on purpose: a scene can
 * hold other region meshes (a `.region()` statement's own), and those are
 * not this picker's to toggle.
 */
export class RegionPickMode {
  private canvas: HTMLCanvasElement;

  private highlightedMesh: Mesh | null = null;
  private highlightedOriginalColor: number | null = null;
  private highlightedOriginalOpacity: number | null = null;

  private downX = 0;
  private downY = 0;

  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;

  constructor(
    private ctx: SceneContext,
    private root: Object3D,
    private handlers: {
      /** An unselected region was clicked. */
      onPick: (key: string) => void;
      /** A selected region was clicked. */
      onRemove: (key: string) => void;
    },
  ) {
    this.canvas = ctx.renderer.domElement;
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

  /** The overlay was redrawn — the tinted mesh is gone with it. */
  forgetHighlight(): void {
    this.highlightedMesh = null;
    this.highlightedOriginalColor = null;
    this.highlightedOriginalOpacity = null;
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

    const hitGroup = hit.mesh.parent;
    const key = hitGroup?.userData.metaData?.key;
    if (typeof key !== 'string') {
      return;
    }

    if (hitGroup.userData.isPickRegionSelected === true) {
      this.handlers.onRemove(key);
    } else {
      this.handlers.onPick(key);
    }
  }

  private handleMouseMove(e: MouseEvent): void {
    const hit = this.raycastRegions(e.clientX, e.clientY);
    const hitMesh = hit?.mesh ?? null;

    if (hitMesh === this.highlightedMesh) {
      return;
    }

    this.restoreHighlight();

    if (hitMesh) {
      const mat = hitMesh.material as MeshBasicMaterial;
      this.highlightedOriginalColor = mat.color.getHex();
      this.highlightedOriginalOpacity = mat.opacity;
      mat.color.set(HOVER_COLOR);
      mat.opacity = HOVER_OPACITY;
      this.highlightedMesh = hitMesh;
    }
    this.ctx.requestRender();
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
      this.forgetHighlight();
    }
  }

  /** The closest pick-region mesh under the pointer, with the hit point. */
  private raycastRegions(clientX: number, clientY: number): { mesh: Mesh; point: Vector3 } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = this.ctx.createPickingRaycaster(ndcX, ndcY);

    const regionMeshes: Mesh[] = [];
    this.root.traverse((obj: Object3D) => {
      if (obj.userData.isPickRegion) {
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
    if (intersects.length === 0) {
      return null;
    }
    return { mesh: intersects[0].object as Mesh, point: intersects[0].point };
  }
}
