import { Mesh, MeshBasicMaterial, Object3D, Raycaster, Vector2, Vector3 } from 'three';
import { SceneContext } from '../scene/scene-context';
import { PlaneData } from '../types';

const HOVER_COLOR = '#64B5F6';
const HOVER_OPACITY = 0.35;

/**
 * Interactive mode for picking face regions in the sketch.
 *
 * Uses Three.js raycasting against meta face meshes (pick-region / pick-region-selected)
 * to detect hover and click on individual sketch regions.
 */
export class RegionPickMode {
  private canvas: HTMLCanvasElement;
  private ctx: SceneContext;
  private plane: PlaneData;
  private onPick: (point2d: [number, number]) => void;
  private onRemove: (finalPoints: [number, number][]) => void;
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
    plane: PlaneData,
    onPick: (point2d: [number, number]) => void,
    onRemove: (finalPoints: [number, number][]) => void,
    onHighlight: (shapeId: string | null) => void,
  ) {
    this.canvas = ctx.renderer.domElement;
    this.ctx = ctx;
    this.plane = plane;
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

    const point2d = this.projectToSketch(e.clientX, e.clientY);
    if (!point2d) {
      return;
    }

    // Raycast directly to find the region under the click
    const hit = this.raycastRegions(e.clientX, e.clientY);
    if (!hit) {
      return;
    }

    const hitGroup = hit.parent;
    const isSelected = hitGroup?.userData.isPickRegionSelected === true;

    if (isSelected) {
      // Collect all currently selected regions' pick points, minus the clicked one
      const finalPoints = this.collectSelectedPickPoints(hitGroup!);
      this.onRemove(finalPoints);
    } else {
      const rounded: [number, number] = [
        Math.round(point2d[0] * 100) / 100,
        Math.round(point2d[1] * 100) / 100,
      ];
      this.onPick(rounded);
    }
  }

  /**
   * Collect pick points from ALL selected regions except the one being deselected.
   * Each selected region's metaData.pickPoint holds its associated point.
   */
  private collectSelectedPickPoints(excludeGroup: Object3D): [number, number][] {
    const points: [number, number][] = [];
    this.ctx.scene.traverse((obj: Object3D) => {
      if (obj === excludeGroup) {
        return;
      }
      if (obj.userData.isPickRegion && obj.userData.isPickRegionSelected && obj.userData.metaData?.pickPoint) {
        points.push(obj.userData.metaData.pickPoint);
      }
    });
    return points;
  }

  private handleMouseMove(e: MouseEvent): void {
    const hit = this.raycastRegions(e.clientX, e.clientY);

    if (hit === this.highlightedMesh) {
      return; // Same mesh, no change
    }

    // Restore previous highlight
    this.restoreHighlight();

    if (hit) {
      // Apply hover highlight
      const mat = hit.material as MeshBasicMaterial;
      this.highlightedOriginalColor = mat.color.getHex();
      this.highlightedOriginalOpacity = mat.opacity;
      mat.color.set(HOVER_COLOR);
      mat.opacity = HOVER_OPACITY;
      this.highlightedMesh = hit;

      // Find shapeId from parent group
      let shapeId: string | null = null;
      let obj: Object3D | null = hit;
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

  /** Raycast against pick-region meta face meshes and return the closest hit Mesh. */
  private raycastRegions(clientX: number, clientY: number): Mesh | null {
    const renderer = this.ctx.renderer;
    const camera = this.ctx.camera;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new Raycaster();
    raycaster.setFromCamera(new Vector2(ndcX, ndcY), camera);

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
    return intersects.length > 0 ? intersects[0].object as Mesh : null;
  }

  /** Project screen coordinates to 2D sketch plane coordinates. */
  private projectToSketch(clientX: number, clientY: number): [number, number] | null {
    const renderer = this.ctx.renderer;
    const camera = this.ctx.camera;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new Raycaster();
    raycaster.setFromCamera(new Vector2(ndcX, ndcY), camera);

    const rayOrigin = raycaster.ray.origin;
    const rayDir = raycaster.ray.direction;

    const planeOrigin = new Vector3(this.plane.origin.x, this.plane.origin.y, this.plane.origin.z);
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    const denom = rayDir.dot(planeNormal);
    if (Math.abs(denom) < 1e-6) {
      return null;
    }

    const t = planeOrigin.clone().sub(rayOrigin).dot(planeNormal) / denom;
    if (t < 0) {
      return null;
    }

    const worldPoint = rayOrigin.clone().add(rayDir.clone().multiplyScalar(t));

    const rel = worldPoint.clone().sub(planeOrigin);
    const xDir = new Vector3(this.plane.xDirection.x, this.plane.xDirection.y, this.plane.xDirection.z);
    const yDir = new Vector3(this.plane.yDirection.x, this.plane.yDirection.y, this.plane.yDirection.z);

    return [rel.dot(xDir), rel.dot(yDir)];
  }
}
