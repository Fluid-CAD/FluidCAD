import { Vector3 } from 'three';
import { SketchTool, InsertGeometryFn, FetchVariablesFn } from '../sketch-tool';
import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../../types';
import { SnapController } from '../../snapping/snap-controller';
import { SnapManager } from '../../snapping/snap-manager';
import { SnapType } from '../../snapping/types';
import {
  projectToSketch,
  roundPoint,
  pixelToSketchThreshold,
} from '../sketch-plane-utils';
import { ICON_TANGENT_ARC } from '../../ui/icons';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedArc,
  angleFromCenter,
} from './tool-preview-utils';

type ConnectionHit = {
  point: [number, number];
  tangent: [number, number];
  hitZone: 'start' | 'end';
};

const enum State {
  IDLE,
  START_PLACED,
}

export class TangentArcTool extends SketchTool {
  readonly id = 'tarc' as const;
  readonly label = 'Tangent Arc';
  readonly icon = ICON_TANGENT_ARC;

  private state: State = State.IDLE;
  private startPoint: [number, number] | null = null;
  private tangentDir: [number, number] | null = null;
  private connectionType: 'chain' | 'explicit' | null = null;
  private mousePoint: [number, number] | null = null;
  private lastSnapType: SnapType = 'none';
  private sceneObjects: SceneObjectRender[] = [];
  private sketchId = '';

  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;
  private downX = 0;
  private downY = 0;

  constructor(
    ctx: SceneContext,
    plane: PlaneData,
    snapController: SnapController,
    insertGeometry: InsertGeometryFn,
    _container: HTMLElement,
    _fetchVariables: FetchVariablesFn,
  ) {
    super(ctx, plane, snapController, insertGeometry);
    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
    this.boundMouseMove = this.handleMouseMove.bind(this);
    this.boundKeyDown = this.handleKeyDown.bind(this);
  }

  activate(): void {
    this.addPreviewToScene();
    this.canvas.addEventListener('mousedown', this.boundMouseDown);
    this.canvas.addEventListener('mouseup', this.boundMouseUp);
    this.canvas.addEventListener('mousemove', this.boundMouseMove);
    window.addEventListener('keydown', this.boundKeyDown);
  }

  deactivate(): void {
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.canvas.removeEventListener('mousemove', this.boundMouseMove);
    window.removeEventListener('keydown', this.boundKeyDown);
    this.resetState();
    this.removePreviewFromScene();
  }

  onSceneUpdate(sceneObjects: SceneObjectRender[], sketchId: string): void {
    this.sceneObjects = sceneObjects;
    this.sketchId = sketchId;
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, this.plane);
    this.updateSnapManager(snapManager);
  }

  private resetState(): void {
    this.state = State.IDLE;
    this.startPoint = null;
    this.tangentDir = null;
    this.connectionType = null;
    this.mousePoint = null;
  }

  private handleMouseDown(e: MouseEvent): void {
    this.downX = e.clientX;
    this.downY = e.clientY;
  }

  private handleMouseUp(e: MouseEvent): void {
    const dx = e.clientX - this.downX;
    const dy = e.clientY - this.downY;
    if (dx * dx + dy * dy > 64) {
      return;
    }

    const raw = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!raw) {
      return;
    }

    const result = this.snapController.snap(raw);
    const point = roundPoint(result.point2d);

    if (this.state === State.IDLE) {
      if (result.snapType !== 'vertex') {
        return;
      }

      const conn = this.findConnectionGeometry(point);
      if (!conn) {
        return;
      }

      this.startPoint = roundPoint(conn.point);
      this.tangentDir = conn.tangent;
      if (conn.hitZone === 'end' && this.isAtCurrentPosition(this.startPoint)) {
        this.connectionType = 'chain';
      } else {
        this.connectionType = 'explicit';
      }

      this.state = State.START_PLACED;
      this.rebuildPreview();
      return;
    }

    if (this.state === State.START_PLACED) {
      this.commitArc(point);
    }
  }

  private handleMouseMove(e: MouseEvent): void {
    const raw = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!raw) {
      this.mousePoint = null;
      this.lastSnapType = 'none';
      this.rebuildPreview();
      return;
    }

    const result = this.snapController.snap(raw);
    this.mousePoint = result.point2d;
    this.lastSnapType = result.snapType;
    this.rebuildPreview();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && this.state === State.START_PLACED) {
      this.resetState();
      this.rebuildPreview();
    }
  }

  // ── Connection detection ───────────────────────────────────────────

  private static readonly CONNECTABLE_TYPES = new Set([
    'line-two-points', 'hline', 'vline',
    'tarc-to-point', 'tarc-to-point-tangent', 'tarc-with-tangent',
  ]);

  private findConnectionGeometry(point2d: [number, number]): ConnectionHit | null {
    const threshold = pixelToSketchThreshold(this.ctx, 12);
    const thresholdSq = threshold * threshold;

    let bestHit: ConnectionHit | null = null;
    let bestDistSq = Infinity;

    for (const child of this.sceneObjects) {
      if (child.parentId !== this.sketchId || !child.sourceLocation) {
        continue;
      }
      if (!TangentArcTool.CONNECTABLE_TYPES.has(child.uniqueType ?? '')) {
        continue;
      }

      for (const part of child.sceneShapes) {
        if (part.isMetaShape) {
          continue;
        }
        for (const mesh of part.meshes) {
          const verts = this.meshToSketch2D(mesh.vertices);
          if (verts.length < 2) {
            continue;
          }

          const startV = verts[0];
          const endV = verts[verts.length - 1];

          const edx = endV[0] - point2d[0];
          const edy = endV[1] - point2d[1];
          const endDist = edx * edx + edy * edy;
          if (endDist < thresholdSq && endDist < bestDistSq) {
            const tangent = this.tangentFromVertices(verts, 'end');
            if (tangent) {
              bestHit = { point: endV, tangent, hitZone: 'end' };
              bestDistSq = endDist;
            }
          }

          const sdx = startV[0] - point2d[0];
          const sdy = startV[1] - point2d[1];
          const startDist = sdx * sdx + sdy * sdy;
          if (startDist < thresholdSq && startDist < bestDistSq) {
            const tangent = this.tangentFromVertices(verts, 'start');
            if (tangent) {
              bestHit = { point: startV, tangent, hitZone: 'start' };
              bestDistSq = startDist;
            }
          }
        }
      }
    }

    return bestHit;
  }

  private tangentFromVertices(verts: [number, number][], hitZone: 'start' | 'end'): [number, number] | null {
    let dx: number, dy: number;
    if (hitZone === 'end') {
      const a = verts[verts.length - 2];
      const b = verts[verts.length - 1];
      dx = b[0] - a[0];
      dy = b[1] - a[1];
    } else {
      const a = verts[0];
      const b = verts[1];
      dx = a[0] - b[0];
      dy = a[1] - b[1];
    }
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-10) {
      return null;
    }
    return [dx / len, dy / len];
  }

  private meshToSketch2D(vertices: number[]): [number, number][] {
    const ox = this.plane.origin.x, oy = this.plane.origin.y, oz = this.plane.origin.z;
    const xx = this.plane.xDirection.x, xy = this.plane.xDirection.y, xz = this.plane.xDirection.z;
    const yx = this.plane.yDirection.x, yy = this.plane.yDirection.y, yz = this.plane.yDirection.z;
    const result: [number, number][] = [];
    for (let i = 0; i < vertices.length; i += 3) {
      const rx = vertices[i] - ox, ry = vertices[i + 1] - oy, rz = vertices[i + 2] - oz;
      result.push([rx * xx + ry * xy + rz * xz, rx * yx + ry * yy + rz * yz]);
    }
    return result;
  }

  // ── Arc math ───────────────────────────────────────────────────────

  private computeArcPreview(
    start: [number, number],
    end: [number, number],
    tangent: [number, number],
  ): { center: [number, number]; radius: number; startAngle: number; endAngle: number; ccw: boolean } | null {
    const perpX = -tangent[1];
    const perpY = tangent[0];

    const dx = start[0] - end[0];
    const dy = start[1] - end[1];
    const distSq = dx * dx + dy * dy;
    const dDotN = dx * perpX + dy * perpY;

    if (Math.abs(dDotN) < 1e-10) {
      return null;
    }

    const t = -distSq / (2 * dDotN);
    const radius = Math.abs(t);
    const center: [number, number] = [start[0] + perpX * t, start[1] + perpY * t];
    const startAngle = angleFromCenter(center, start);
    const endAngle = angleFromCenter(center, end);

    return { center, radius, startAngle, endAngle, ccw: t >= 0 };
  }

  // ── Commit ─────────────────────────────────────────────────────────

  private commitArc(endPoint: [number, number]): void {
    if (!this.startPoint || !this.tangentDir) {
      return;
    }

    const re = roundPoint(endPoint);

    let statement: string;
    if (this.connectionType === 'chain') {
      statement = `tArc(${this.formatPoint(re)})`;
    } else {
      const rs = this.startPoint;
      const rt = this.formatTangent(this.tangentDir);
      statement = `tArc(${this.formatPoint(rs)}, ${this.formatPoint(re)}, ${rt})`;
    }

    this.insertGeometry(statement);
    this.resetState();
    this.rebuildPreview();
  }

  private formatTangent(t: [number, number]): string {
    const tx = Math.round(t[0] * 10000) / 10000;
    const ty = Math.round(t[1] * 10000) / 10000;
    return `[${tx}, ${ty}]`;
  }

  // ── Preview ────────────────────────────────────────────────────────

  private rebuildPreview(): void {
    this.disposePreview();

    const camera = this.ctx.camera;
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    if (this.state === State.IDLE) {
      if (this.mousePoint && this.lastSnapType === 'vertex') {
        const conn = this.findConnectionGeometry(this.mousePoint);
        if (conn) {
          addDot(this.previewGroup, this.mousePoint, SNAP_VERTEX_COLOR, camera, planeNormal, this.plane, 0.6);
        }
      }
    } else if (this.state === State.START_PLACED && this.startPoint && this.tangentDir) {
      addDot(this.previewGroup, this.startPoint, START_POINT_COLOR, camera, planeNormal, this.plane);

      if (this.mousePoint) {
        const arc = this.computeArcPreview(this.startPoint, this.mousePoint, this.tangentDir);
        if (arc) {
          addDashedArc(this.previewGroup, arc.center, arc.radius, arc.startAngle, arc.endAngle, arc.ccw, this.plane);
        }

        if (this.lastSnapType !== 'none') {
          const color = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
          addDot(this.previewGroup, this.mousePoint, color, camera, planeNormal, this.plane, 0.6);
        }
      }
    }

    this.requestRender();
  }
}
