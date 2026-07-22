import { PointPickMode, HighlightInfo } from './point-pick-mode';
import { TrimRegionMode } from './trim-region-mode';
import { TrimMode } from './trim-dialog';
import { SnapManager } from '../snapping/snap-manager';
import { insertPoint, addPick, removePick, removeFeature, applyTrimRegion, setPickPoints } from '../api';
import { isTopLevel } from '../helpers/scene-utils';
import { SceneObjectRender, PlaneData } from '../types';
import { Viewer } from '../viewer';
import { EdgeEntry, buildEdgeIndex } from './sketch-edge-utils';
import { Mesh, Object3D } from 'three';

const HIGHLIGHT_COLOR = 0xffc578;
const VERTEX_MATCH_EPSILON_SQ = 1e-4;

type TrimInfo = { trimObj: SceneObjectRender & { sourceLocation?: any }; sketchObj: SceneObjectRender };

/**
 * The interactive trimming session behind the sketch toolbar's Trim tool:
 * armed through the trim dialog (By Region / By Point), it rides a
 * `trim().pick()` statement whose build emits the split segments (and the
 * regions they bound) as meta shapes. By Point inserts pick points; By
 * Region synthesizes edge-filter targets for a clicked region's boundary,
 * falling back to pick points when no filter separates it.
 */
export class TrimPickService {
  private viewer: Viewer;
  private _state: 'idle' | 'picking-active' = 'idle';
  private _mode: TrimMode = 'region';
  private _lastPickInfo: TrimInfo | null = null;
  private lastSceneObjects: SceneObjectRender[] | null = null;
  private activePointPickMode: PointPickMode | null = null;
  private activeRegionMode: TrimRegionMode | null = null;
  private activeSourceLine: number | null = null;
  private _pendingActivation = false;
  private highlightedVertexDots: { mesh: Mesh; originalMaterial: any }[] = [];

  constructor(viewer: Viewer) {
    this.viewer = viewer;
  }

  get state(): 'idle' | 'picking-active' {
    return this._state;
  }

  get lastPickInfo(): TrimInfo | null {
    return this._lastPickInfo;
  }

  get pendingActivation(): boolean {
    return this._pendingActivation;
  }

  set pendingActivation(value: boolean) {
    this._pendingActivation = value;
  }

  get mode(): TrimMode {
    return this._mode;
  }

  /** The trim dialog's tab choice; swaps the live handler mid-session. */
  setMode(mode: TrimMode): void {
    if (this._mode === mode) {
      return;
    }
    this._mode = mode;
    if (this._state === 'picking-active' && this._lastPickInfo && this.lastSceneObjects) {
      this.activateInteractive(this._lastPickInfo, this.lastSceneObjects);
    }
  }

  update(sceneObjects: SceneObjectRender[]): void {
    const triggerInfo = this.hasTrimPickingTrigger(sceneObjects);

    if (!triggerInfo.hasTrigger) {
      if (!this._pendingActivation) {
        this.reset();
      }
      return;
    }

    this._lastPickInfo = { trimObj: triggerInfo.trimObj!, sketchObj: triggerInfo.sketchObj! };
    this.lastSceneObjects = sceneObjects;
    const hasPicking = (triggerInfo.trimObj as any).object?.picking;

    if (this._pendingActivation) {
      this._pendingActivation = false;
      this.enter();
      return;
    }

    if (this._state !== 'picking-active') {
      return;
    }

    if (hasPicking) {
      const srcLine = this._lastPickInfo.trimObj.sourceLocation!.line;
      if (this._mode === 'point'
        && this.activePointPickMode && this.activeSourceLine === srcLine) {
        this.activePointPickMode.updateEdges(sceneObjects, triggerInfo.sketchObj!.id!);
        return;
      }
      // Region meshes are rebuilt with the scene — re-arm the raycast mode.
      this.activateInteractive(this._lastPickInfo, sceneObjects);
    }
  }

  enter(): void {
    if (!this._lastPickInfo) {
      return;
    }

    const hasPicking = (this._lastPickInfo.trimObj as any).object?.picking;

    if (!hasPicking) {
      addPick((this._lastPickInfo.trimObj as any).sourceLocation);
    } else if (this.lastSceneObjects) {
      this.activateInteractive(this._lastPickInfo, this.lastSceneObjects);
    }
    this._state = 'picking-active';
    this.viewer.isTrimming = true;
  }

  exit(): void {
    this.deactivateHandler();
    this.viewer.isTrimming = false;
    this._state = 'idle';

    const trimObj = this._lastPickInfo?.trimObj as any;
    const isPicking = trimObj?.object?.picking;
    const pickPoints = trimObj?.object?.pickPoints as [number, number][] | undefined;
    if (isPicking && (!pickPoints || pickPoints.length === 0) && trimObj?.sourceLocation) {
      if (trimObj.object?.hasTargets) {
        // Keep the applied trim; drop only the interactive .pick() marker.
        removePick(trimObj.sourceLocation);
      } else {
        // Nothing was trimmed — remove the placeholder statement entirely.
        removeFeature(trimObj.sourceLocation);
      }
    }
  }

  reset(): void {
    this.deactivateHandler();
    this._state = 'idle';
    this._lastPickInfo = null;
    this.lastSceneObjects = null;
    this.viewer.isTrimming = false;
  }

  private activateInteractive(info: TrimInfo, sceneObjects: SceneObjectRender[]): void {
    this.deactivateHandler();

    const plane: PlaneData = (info.sketchObj as any).object.plane;
    const sourceLocation = (info.trimObj as any).sourceLocation;
    const sketchId = info.sketchObj.id!;
    this.activeSourceLine = sourceLocation.line;

    if (this._mode === 'region') {
      this.activeRegionMode = new TrimRegionMode(
        this.viewer.sceneContext,
        (edgeIds) => {
          this.viewer.clearHighlight();
          if (edgeIds) {
            this.viewer.highlightEntities([], edgeIds);
          }
        },
        (edgeIds) => {
          void this.applyRegion(edgeIds);
        },
      );
      this.activeRegionMode.activate();
      return;
    }

    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, plane, this.viewer.sceneContext);

    this.activePointPickMode = new PointPickMode(
      this.viewer.sceneContext,
      plane,
      snapManager,
      sceneObjects,
      sketchId,
      (point2d) => {
        insertPoint(point2d, sourceLocation);
      },
      (info: HighlightInfo) => {
        this.viewer.clearHighlight();
        this.clearVertexHighlights();
        if (info) {
          this.viewer.highlightShape(info.shapeId);
          this.highlightVerticesAt(info.endpoints);
        }
      },
    );
    this.activePointPickMode.activate();
  }

  /**
   * A region click: ask the server to write edge-filter targets for the
   * boundary segments; when no filter separates them, fall back to pick
   * points at the segments' midpoints — the click always trims.
   */
  private async applyRegion(edgeIds: string[]): Promise<void> {
    const trimObj = this._lastPickInfo?.trimObj as any;
    if (!trimObj?.sourceLocation) {
      return;
    }
    const result = await applyTrimRegion(edgeIds, trimObj.sourceLocation);
    if (result.success) {
      return;
    }

    const existing = (trimObj.object?.pickPoints as [number, number][] | undefined) ?? [];
    const midpoints = this.segmentMidpoints(edgeIds);
    if (midpoints.length > 0) {
      setPickPoints([...existing, ...midpoints], trimObj.sourceLocation);
    }
  }

  /** Sketch-plane midpoints (by arc length) of the given trim segments. */
  private segmentMidpoints(edgeIds: string[]): [number, number][] {
    if (!this._lastPickInfo || !this.lastSceneObjects) {
      return [];
    }
    const plane: PlaneData = (this._lastPickInfo.sketchObj as any).object.plane;
    const index = buildEdgeIndex(this.lastSceneObjects, this._lastPickInfo.sketchObj.id!, plane);
    const result: [number, number][] = [];
    for (const id of edgeIds) {
      const entry = index.find(e => e.shapeId === id);
      const mid = entry ? TrimPickService.polylineMidpoint(entry) : null;
      if (mid) {
        result.push([Math.round(mid[0] * 100) / 100, Math.round(mid[1] * 100) / 100]);
      }
    }
    return result;
  }

  /** The point halfway along the entry's tessellated length. */
  private static polylineMidpoint(entry: EdgeEntry): [number, number] | null {
    let total = 0;
    const lengths = entry.segments.map(s => {
      const len = Math.hypot(s.bx - s.ax, s.by - s.ay);
      total += len;
      return len;
    });
    if (total === 0) {
      return null;
    }
    let remaining = total / 2;
    for (let i = 0; i < entry.segments.length; i++) {
      if (remaining > lengths[i]) {
        remaining -= lengths[i];
        continue;
      }
      const s = entry.segments[i];
      const t = lengths[i] === 0 ? 0 : remaining / lengths[i];
      return [s.ax + (s.bx - s.ax) * t, s.ay + (s.by - s.ay) * t];
    }
    return null;
  }

  private deactivateHandler(): void {
    if (this.activePointPickMode) {
      this.activePointPickMode.deactivate();
      this.activePointPickMode = null;
    }
    if (this.activeRegionMode) {
      this.activeRegionMode.deactivate();
      this.activeRegionMode = null;
    }
    this.activeSourceLine = null;
    this.viewer.clearHighlight();
    this.clearVertexHighlights();
  }

  private highlightVerticesAt(endpoints: [number, number, number][]): void {
    this.clearVertexHighlights();
    if (endpoints.length === 0) {
      return;
    }

    this.viewer.sceneContext.scene.traverse((obj: Object3D) => {
      if (!obj.userData.isVertexDot) {
        return;
      }
      const dot = obj.children[0] as Mesh;
      if (!dot || !(dot as any).isMesh) {
        return;
      }
      const pos = obj.position;
      for (const ep of endpoints) {
        const dx = pos.x - ep[0];
        const dy = pos.y - ep[1];
        const dz = pos.z - ep[2];
        if (dx * dx + dy * dy + dz * dz < VERTEX_MATCH_EPSILON_SQ) {
          const originalMaterial = dot.material;
          const cloned = (originalMaterial as any).clone();
          cloned.color.setHex(HIGHLIGHT_COLOR);
          dot.material = cloned;
          this.highlightedVertexDots.push({ mesh: dot, originalMaterial });
          break;
        }
      }
    });

    this.viewer.sceneContext.requestRender();
  }

  private clearVertexHighlights(): void {
    for (const { mesh, originalMaterial } of this.highlightedVertexDots) {
      (mesh.material as any).dispose();
      mesh.material = originalMaterial;
    }
    if (this.highlightedVertexDots.length > 0) {
      this.highlightedVertexDots.length = 0;
      this.viewer.sceneContext.requestRender();
    }
  }

  private hasTrimPickingTrigger(sceneObjects: SceneObjectRender[]): {
    hasTrigger: boolean;
    trimObj?: SceneObjectRender & { sourceLocation?: any };
    sketchObj?: SceneObjectRender;
  } {
    let lastRoot: SceneObjectRender | null = null;
    for (let i = sceneObjects.length - 1; i >= 0; i--) {
      if (isTopLevel(sceneObjects[i], sceneObjects)) {
        lastRoot = sceneObjects[i];
        break;
      }
    }

    if (!lastRoot || lastRoot.type !== 'sketch' || !lastRoot.id || !lastRoot.object?.plane) {
      return { hasTrigger: false };
    }

    let lastChild: SceneObjectRender | null = null;
    for (let i = sceneObjects.length - 1; i >= 0; i--) {
      if (sceneObjects[i].parentId === lastRoot.id) {
        lastChild = sceneObjects[i];
        break;
      }
    }

    const obj = lastChild as any;
    if (!obj || obj.type !== 'trim2d' || obj.object?.trigger !== 'trim-picking' || !obj.sourceLocation) {
      return { hasTrigger: false };
    }

    return { hasTrigger: true, trimObj: lastChild!, sketchObj: lastRoot };
  }
}
