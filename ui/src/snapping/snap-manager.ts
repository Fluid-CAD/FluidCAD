import { Vector3 } from 'three';
import { Snapper, SnapResult, SolvedVertexRef } from './types';
import { VertexSnapper, VertexCandidate } from './vertex-snapper';
import { AxisSnapper } from './axis-snapper';
import { GridSnapper } from './grid-snapper';
import { PlaneData, SceneObjectRender } from '../types';
import { SceneContext } from '../scene/scene-context';
import { buildSolvedSketchModel, isSolvedSketch } from '../sketch-solver-client/model';
import { worldUnitsPerPixel } from '../meshes/screen-scale';
import { resolveGridSpacing } from '../grid/grid-spacing';
import { currentGridPrefs } from '../grid/grid-prefs';
import { sceneUnit } from '../units/scene-unit';
import { worldFromMm } from '../units/scene-scale';

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
    const ctx = this.ctx!;
    const rect = ctx.renderer.domElement.getBoundingClientRect();
    // Sketch mode is orthographic, so the focus only matters for a 3D-mode
    // snap; the orbit target is the honest depth there.
    const cam = ctx.camera as { isOrthographicCamera?: boolean };
    const focus = cam.isOrthographicCamera ? undefined : ctx.cameraControls.getTarget(new Vector3());
    return worldUnitsPerPixel(ctx.camera, rect.height, focus);
  }

  /** The drawn grid's pitch at this zoom — same resolver, same inputs. */
  private updateGridSpacing(worldUnitsPerPixel: number): void {
    const { minor } = resolveGridSpacing(sceneUnit.current, worldUnitsPerPixel, currentGridPrefs());

    for (const s of this.snappers) {
      if (s instanceof GridSnapper) {
        s.setSpacing(minor);
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
    // Two vertices within a thousandth of a millimetre are one vertex.
    const EPSILON_SQ = worldFromMm(1e-3) ** 2;
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
        // Fixed references (P6) and copy duplicates live on a
        // project()/intersect()/copy() statement, not an entity call — the
        // ref names that producer plus its `.ref(i)` / `.instance(k)`
        // address so the emitted coincident targets the right edge.
        const owner = e.reference
          ? { featureType: e.reference.producer, refIndex: e.reference.refIndex }
          : e.copyInstance
            ? { featureType: 'copy' as const, instanceIndex: e.copyInstance.slot }
            : { featureType: e.kind };
        const roles: ('start' | 'end' | 'center')[] =
          e.kind === 'line' ? ['start', 'end']
            : e.kind === 'arc' ? ['start', 'end', 'center']
              : e.kind === 'circle' ? ['center'] : [];
        for (const role of roles) {
          const p = e[role];
          if (p) {
            pushUnique(p[0], p[1], { ...provenance, role, ...owner });
          }
        }
        if (e.kind === 'point' && e.point) {
          // Anchor points (P8) name their owning statement's callee, so an
          // emitted coincident renders the anchor accessor (`el.center()`,
          // `t.anchor()`, `bz.point(i)`) instead of a bogus point() target.
          const ref = e.anchor
            ? {
              ...provenance,
              featureType: e.anchor.owner,
              ...(e.anchor.owner === 'bezier' ? { pointIndex: e.anchor.pointIndex } : {}),
            }
            : { ...provenance, featureType: 'point' as const };
          pushUnique(e.point[0], e.point[1], ref);
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

    // Priority order: vertex snap, then the datum axes, then grid snap.
    // The grid starts at the zoom-free pitch (fixed mode's value); with a
    // context every snap re-pitches it to the drawn grid first.
    const initialGrid = resolveGridSpacing(sceneUnit.current, 0, currentGridPrefs());
    const snappers: Snapper[] = [
      new VertexSnapper(candidates, plane),
      ...(hasDatums ? [new AxisSnapper(plane)] : []),
      new GridSnapper(plane, initialGrid.minor),
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
