import { Vector3 } from 'three';
import { Snapper, SnapResult, SolvedVertexRef } from './types';
import { VertexSnapper, VertexCandidate } from './vertex-snapper';
import { AxisSnapper } from './axis-snapper';
import { GridSnapper, computeAdaptiveGridSpacing } from './grid-snapper';
import { PlaneData, SceneObjectRender } from '../types';
import { SceneContext } from '../scene/scene-context';
import { buildSolvedSketchModel, isSolvedSketch } from '../sketch-solver-client/model';

const DEFAULT_SNAP_THRESHOLD_PX = 15;

export class SnapManager {
  private snappers: Snapper[] = [];
  private threshold: number;
  private ctx: SceneContext | null;

  /**
   * `threshold` is a screen-pixel radius when a SceneContext is provided —
   * converted to sketch units at the current zoom on every snap. Without a
   * context it is used as-is in sketch units.
   */
  constructor(snappers: Snapper[], threshold: number = DEFAULT_SNAP_THRESHOLD_PX, ctx: SceneContext | null = null) {
    this.snappers = snappers;
    this.threshold = threshold;
    this.ctx = ctx;
  }

  setExcludedVertices(excluded: [number, number][]): void {
    for (const s of this.snappers) {
      if (s instanceof VertexSnapper) {
        s.setExcluded(excluded);
      }
    }
  }

  snap(point2d: [number, number], plane: PlaneData): SnapResult {
    let threshold = this.threshold;
    if (this.ctx) {
      const worldUnitsPerPixel = this.worldUnitsPerPixel();
      threshold = this.threshold * worldUnitsPerPixel;
      this.updateGridSpacing(worldUnitsPerPixel);
    }

    // Try each snapper in priority order; first match wins
    for (const snapper of this.snappers) {
      const result = snapper.snap(point2d, threshold);
      if (result) {
        return result;
      }
    }

    // No snap — return the original point
    const o = plane.origin;
    const x = plane.xDirection;
    const y = plane.yDirection;

    return {
      point2d,
      worldPoint: new Vector3(
        o.x + x.x * point2d[0] + y.x * point2d[1],
        o.y + x.y * point2d[0] + y.y * point2d[1],
        o.z + x.z * point2d[0] + y.z * point2d[1],
      ),
      snapType: 'none',
    };
  }

  private worldUnitsPerPixel(): number {
    const camera = this.ctx!.camera;
    const rect = this.ctx!.renderer.domElement.getBoundingClientRect();
    const canvasHeight = rect.height || 1;

    let worldHeight: number;
    const cam = camera as any;
    if (cam.isOrthographicCamera) {
      worldHeight = (cam.top - cam.bottom) / (cam.zoom || 1);
    } else {
      const target = new Vector3();
      this.ctx!.cameraControls.getTarget(target);
      const d = camera.position.distanceTo(target);
      const fovRad = (cam.fov * Math.PI) / 180;
      worldHeight = 2 * d * Math.tan(fovRad / 2);
    }

    return worldHeight / canvasHeight;
  }

  private updateGridSpacing(worldUnitsPerPixel: number): void {
    const adaptiveSpacing = computeAdaptiveGridSpacing(worldUnitsPerPixel);

    for (const s of this.snappers) {
      if (s instanceof GridSnapper) {
        s.setSpacing(adaptiveSpacing);
      }
    }
  }


  static fromSceneObjects(
    sceneObjects: SceneObjectRender[],
    sketchId: string,
    plane: PlaneData,
    ctx?: SceneContext,
  ): SnapManager {
    // Extract vertex positions from sketch child mesh data
    const candidates: VertexCandidate[] = [];
    const EPSILON_SQ = 1e-6;
    const pushUnique = (u: number, v: number, ref?: SolvedVertexRef) => {
      const isDup = candidates.some(
        ({ point: p }) => (p[0] - u) * (p[0] - u) + (p[1] - v) * (p[1] - v) < EPSILON_SQ,
      );
      if (!isDup) {
        candidates.push({ point: [u, v], ...(ref ? { ref } : {}) });
      }
    };

    // Solved sketches: every entity vertex is snappable — with provenance,
    // so an endpoint snap can emit a coincident() (P5). This deliberately
    // includes interior/closed-loop junctions and guide entities, which the
    // degree-1 mesh scan below can never surface. Pushed first so a
    // position-duplicate mesh endpoint doesn't shadow the ref.
    const solvedSketchObj = sceneObjects.find(obj => obj.id === sketchId);
    let hasDatums = false;
    if (isSolvedSketch(solvedSketchObj)) {
      const model = buildSolvedSketchModel(solvedSketchObj!, sceneObjects);
      hasDatums = model?.hasDatums ?? false;
      // The origin datum, first of all: drawing at (0,0) pins to origin()
      // even when an entity vertex already sits there (the strongest intent;
      // pushUnique dedups by position, first ref wins).
      if (hasDatums) {
        pushUnique(0, 0, { datum: 'origin' });
      }
      for (const e of model?.entities.values() ?? []) {
        const loc = e.obj?.sourceLocation;
        if (!loc?.line) {
          continue;
        }
        // Looped statements share a line — the occurrence rides the ref so
        // the emitted coincident() names the right instance.
        const provenance = {
          line: loc.line,
          ...(loc.occurrence !== undefined ? { occurrence: loc.occurrence } : {}),
        };
        const roles: ('start' | 'end' | 'center')[] =
          e.kind === 'line' ? ['start', 'end']
            : e.kind === 'arc' ? ['start', 'end', 'center']
              : e.kind === 'circle' ? ['center'] : [];
        for (const role of roles) {
          const p = e[role];
          if (p) {
            pushUnique(p[0], p[1], { ...provenance, role, featureType: e.kind });
          }
        }
        if (e.kind === 'point' && e.point) {
          pushUnique(e.point[0], e.point[1], { ...provenance, featureType: 'point' });
        }
      }
    }

    // The plane center is the sketch's default start position (the face
    // center when sketching on a face) — make it snappable like any vertex.
    if (plane.center) {
      const [u, v] = SnapManager.worldToPlane2d(plane.center.x, plane.center.y, plane.center.z, plane);
      pushUnique(u, v);
    }

    for (const obj of sceneObjects) {
      if (obj.parentId !== sketchId || !obj.sceneShapes.length) {
        continue;
      }

      for (const shape of obj.sceneShapes) {
        if (shape.isMetaShape || shape.isGuide) {
          continue;
        }

        for (const meshData of shape.meshes) {
          if (!meshData.indices.length) {
            continue;
          }

          // Find topological endpoints (vertices appearing once in line-segment pairs)
          const count = new Map<number, number>();
          for (const idx of meshData.indices) {
            count.set(idx, (count.get(idx) || 0) + 1);
          }

          for (const [idx, c] of count) {
            if (c === 1) {
              const wx = meshData.vertices[idx * 3];
              const wy = meshData.vertices[idx * 3 + 1];
              const wz = meshData.vertices[idx * 3 + 2];

              const [u, v] = SnapManager.worldToPlane2d(wx, wy, wz, plane);
              pushUnique(u, v);
            }
          }
        }
      }
    }

    // Server-computed snap targets riding the sketch's own payload: where
    // the sketch plane slices the scene's bodies (the vertices an
    // intersect() would produce) plus prior shapes' vertices projected onto
    // the plane. Nothing is drawn; they only feed the vertex snapper.
    for (const [u, v] of solvedSketchObj?.snapVertices ?? []) {
      pushUnique(u, v);
    }

    // Priority order: vertex snap, then the datum axes, then grid snap
    const snappers: Snapper[] = [
      new VertexSnapper(candidates, plane),
      ...(hasDatums ? [new AxisSnapper(plane)] : []),
      new GridSnapper(plane),
    ];

    return new SnapManager(snappers, DEFAULT_SNAP_THRESHOLD_PX, ctx ?? null);
  }

  private static worldToPlane2d(wx: number, wy: number, wz: number, plane: PlaneData): [number, number] {
    const rx = wx - plane.origin.x;
    const ry = wy - plane.origin.y;
    const rz = wz - plane.origin.z;
    const u = rx * plane.xDirection.x + ry * plane.xDirection.y + rz * plane.xDirection.z;
    const v = rx * plane.yDirection.x + ry * plane.yDirection.y + rz * plane.yDirection.z;
    return [u, v];
  }
}
