import { roundPoint } from '../../sketch-plane-utils';
import { computeFixedRadiusArc } from '../../drag-move-handler/constraint-math';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedArc,
  addSegmentHighlight,
  angleFromCenter,
} from '../tool-preview-utils';
import { buildEdgeIndex, closestPointOnSegment, EdgeEntry } from '../../sketch-edge-utils';
import { applyTarcToEdge } from '../../../api';
import { themeColors } from '../../../scene/theme-colors';
import type { SceneObjectRender } from '../../../types';
import type { SegmentMode, ModeContext, ClickResult, Point2D, SegmentCommitResult, TangentInfo } from './types';
import type { SnapResult } from '../../../snapping/types';

/** Pixel distance at which the arc snaps onto an existing edge target. */
const EDGE_SNAP_PX = 12;
const SNAP_HINT = 'Tangent arc up to intersection';
/**
 * An edge this close to the chain start is the segment the arc leaves from —
 * never a snap target. Wide enough to absorb the Float32 mesh vertices the
 * edge index is built from, far tighter than any deliberate geometry.
 */
const TOUCH_EPSILON = 1e-3;

/** A snapped target edge: the shape to reference and where the arc lands. */
type HoverTarget = {
  shapeId: string;
  point: Point2D;
  segments: EdgeEntry['segments'];
};

export class TArcMode implements SegmentMode {
  readonly id = 'tArc' as const;
  readonly label = 'T-Arc';
  readonly requiresTangent = true;

  private mousePoint: Point2D | null = null;
  private lastSnapType: SnapResult['snapType'] = 'none';

  /** Snap candidates, cached per scene payload (see {@link targets}). */
  private targetEntries: EdgeEntry[] | null = null;
  private targetSource: SceneObjectRender[] | null = null;
  private hoverTarget: HoverTarget | null = null;
  /** A tArc-to-edge apply is in flight — ignore further clicks until it lands. */
  private applying = false;
  /** Bumped on enter/exit so an in-flight apply can't advance a stale chain. */
  private generation = 0;

  enter(ctx: ModeContext): void {
    this.generation++;
    this.mousePoint = null;
    this.lastSnapType = 'none';
    this.hoverTarget = null;
    ctx.setSnapHint(null);
  }

  exit(ctx: ModeContext): void {
    this.generation++;
    this.mousePoint = null;
    this.hoverTarget = null;
    this.targetEntries = null;
    this.targetSource = null;
    ctx.setSnapHint(null);
  }

  handleClick(point: Point2D, _snapResult: SnapResult, ctx: ModeContext): ClickResult {
    if (!ctx.tangent) {
      return { kind: 'ignored' };
    }

    if (this.hoverTarget) {
      return this.commitToTarget(this.hoverTarget, ctx);
    }

    const result = this.commitRadiusToPoint(point, ctx);
    if (!result) {
      return { kind: 'ignored' };
    }
    return { kind: 'committed', result };
  }

  /**
   * The radius + endpoint overload commit at `point`, or null when the point
   * solves no tangent arc. The solved radius is written out explicitly — it
   * keeps the drawn shape while making the radius editable as a plain
   * dimension. The written endpoint must lie on the rounded-radius circle,
   * and the chain must continue from the exact end the kernel will build
   * (the written endpoint re-projected onto that circle) — otherwise the
   * tool's position drifts off the rendered geometry a little per arc.
   */
  private commitRadiusToPoint(point: Point2D, ctx: ModeContext): SegmentCommitResult | null {
    if (!ctx.tangent) {
      return null;
    }
    const tangent = ctx.tangent.direction;
    const solved = this.computeArcPreview(ctx.startPoint, point, tangent);
    if (!solved) {
      return null;
    }
    const radius = Math.round(solved.radius * 100) / 100;
    if (radius === 0) {
      return null;
    }

    const aimed = computeFixedRadiusArc(ctx.startPoint, point, radius, tangent);
    if (!aimed) {
      return null;
    }
    const written = roundPoint(aimed.end);
    const built = computeFixedRadiusArc(ctx.startPoint, written, radius, tangent);
    if (!built) {
      return null;
    }
    ctx.insertGeometry(`tArc(${radius}, ${ctx.formatPoint(written)})`);

    return {
      endpoint: built.end,
      exitTangent: this.exitTangentAt(built.center, built.ccw, built.end),
    };
  }

  /**
   * Commit `tArc(radius, target)` for a snapped edge: the signed radius is
   * the one the preview solved at the projected point (positive sweeps CCW
   * of the chain tangent, matching the kernel's convention), and the server
   * binds the target's statement to a variable and appends the call to the
   * chain. The chain continues optimistically from the projected point — the
   * per-render resync adopts the kernel's exact intersection. A refusal (a
   * repeat clone, a loop body, an out-of-date workspace kernel) degrades to
   * the plain radius + endpoint overload at the same point, so the drawn
   * shape survives either way.
   */
  private commitToTarget(target: HoverTarget, ctx: ModeContext): ClickResult {
    if (this.applying) {
      return { kind: 'consumed' };
    }
    const tangent = ctx.tangent!.direction;
    const solved = this.computeArcPreview(ctx.startPoint, target.point, tangent);
    if (!solved) {
      return { kind: 'ignored' };
    }
    const signed = Math.round((solved.ccw ? solved.radius : -solved.radius) * 100) / 100;
    if (signed === 0) {
      return { kind: 'ignored' };
    }

    const generation = this.generation;
    this.applying = true;
    void applyTarcToEdge(signed, target.shapeId).then((result) => {
      this.applying = false;
      if (this.generation !== generation) {
        return;         // the mode was exited mid-flight; don't advance the chain
      }
      this.hoverTarget = null;
      ctx.setSnapHint(null);
      if (result.success) {
        ctx.onSegmentCommitted({
          endpoint: target.point,
          exitTangent: this.exitTangentAt(solved.center, solved.ccw, target.point),
        });
      } else {
        const fallback = this.commitRadiusToPoint(target.point, ctx);
        if (fallback) {
          ctx.onSegmentCommitted(fallback);
        }
      }
    });
    return { kind: 'consumed' };
  }

  handleMouseMove(point: Point2D, snapResult: SnapResult, _clientX: number, _clientY: number, ctx: ModeContext): void {
    this.mousePoint = point;
    this.lastSnapType = snapResult.snapType;
    this.updateHover(point, ctx);
  }

  handleEscape(_ctx: ModeContext): boolean {
    return false;
  }

  /**
   * Snap candidates: edges of single-edge geometries in this sketch, guide
   * edges included — construction geometry is the classic thing to arc up
   * to. The kernel's `tArc(radius, target)` resolves the target through the
   * owner's FIRST shape, so multi-edge owners (rect, polygon) are excluded —
   * on those the arc would silently aim at an arbitrary edge. Owners without
   * a source location can't be bound to a variable and are excluded too.
   * Cached per scene payload.
   */
  private targets(ctx: ModeContext): EdgeEntry[] {
    if (this.targetSource === ctx.sceneObjects && this.targetEntries) {
      return this.targetEntries;
    }

    const ownerByShapeId = new Map<string, SceneObjectRender>();
    for (const obj of ctx.sceneObjects) {
      if (obj.parentId !== ctx.sketchId) {
        continue;
      }
      for (const shape of obj.sceneShapes) {
        if (shape.shapeId) {
          ownerByShapeId.set(shape.shapeId, obj);
        }
      }
    }

    const entries = buildEdgeIndex(ctx.sceneObjects, ctx.sketchId, ctx.plane, { includeGuides: true });
    const entriesPerOwner = new Map<SceneObjectRender, number>();
    for (const entry of entries) {
      const owner = ownerByShapeId.get(entry.shapeId);
      if (owner) {
        entriesPerOwner.set(owner, (entriesPerOwner.get(owner) ?? 0) + 1);
      }
    }

    this.targetEntries = entries.filter((entry) => {
      const owner = ownerByShapeId.get(entry.shapeId);
      return owner !== undefined && !!owner.sourceLocation && entriesPerOwner.get(owner) === 1;
    });
    this.targetSource = ctx.sceneObjects;
    return this.targetEntries;
  }

  /** Re-evaluate the snap target under the cursor and the hint that goes with it. */
  private updateHover(point: Point2D, ctx: ModeContext): void {
    this.hoverTarget = null;
    if (!ctx.tangent) {
      ctx.setSnapHint(null);
      return;
    }

    const threshold = ctx.pixelThreshold(EDGE_SNAP_PX);
    let best: { entry: EdgeEntry; point: Point2D; dist: number } | null = null;

    for (const entry of this.targets(ctx)) {
      let nearest: { x: number; y: number; dist: number } | null = null;
      let startDist = Infinity;
      for (const seg of entry.segments) {
        const c = closestPointOnSegment(point[0], point[1], seg.ax, seg.ay, seg.bx, seg.by);
        if (!nearest || c.dist < nearest.dist) {
          nearest = c;
        }
        const s = closestPointOnSegment(ctx.startPoint[0], ctx.startPoint[1], seg.ax, seg.ay, seg.bx, seg.by);
        if (s.dist < startDist) {
          startDist = s.dist;
        }
      }
      // The edge the chain leaves from touches the start — never a target.
      if (!nearest || startDist <= TOUCH_EPSILON) {
        continue;
      }
      if (nearest.dist <= threshold && (!best || nearest.dist < best.dist)) {
        best = { entry, point: [nearest.x, nearest.y], dist: nearest.dist };
      }
    }

    if (best) {
      // A projected point collinear with the tangent solves no arc — no snap.
      const solved = this.computeArcPreview(ctx.startPoint, best.point, ctx.tangent.direction);
      if (solved && Math.round(solved.radius * 100) / 100 !== 0) {
        this.hoverTarget = {
          shapeId: best.entry.shapeId,
          point: best.point,
          segments: best.entry.segments,
        };
      }
    }
    ctx.setSnapHint(this.hoverTarget ? SNAP_HINT : null);
  }

  /** The chain's exit tangent at `endpoint` on the arc's circle, or null when degenerate. */
  private exitTangentAt(center: Point2D, ccw: boolean, endpoint: Point2D): TangentInfo | null {
    const dx = endpoint[0] - center[0];
    const dy = endpoint[1] - center[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len <= 1e-10) {
      return null;
    }
    const tx = ccw ? -dy / len : dy / len;
    const ty = ccw ? dx / len : -dx / len;
    return { direction: [tx, ty], point: endpoint };
  }

  private computeArcPreview(
    start: Point2D,
    end: Point2D,
    tangent: Point2D,
  ): { center: Point2D; radius: number; startAngle: number; endAngle: number; ccw: boolean } | null {
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
    const center: Point2D = [start[0] + perpX * t, start[1] + perpY * t];
    const startAngle = angleFromCenter(center, start);
    const endAngle = angleFromCenter(center, end);

    return { center, radius, startAngle, endAngle, ccw: t >= 0 };
  }

  rebuildPreview(ctx: ModeContext): void {
    if (!ctx.tangent) {
      return;
    }

    addDot(ctx.previewGroup, ctx.startPoint, START_POINT_COLOR, ctx.camera, ctx.planeNormal, ctx.plane);

    const target = this.hoverTarget;
    if (target) {
      const highlight = themeColors.highlightColor.getHex();
      addSegmentHighlight(ctx.previewGroup, target.segments, ctx.plane, highlight);
      const arc = this.computeArcPreview(ctx.startPoint, target.point, ctx.tangent.direction);
      if (arc) {
        addDashedArc(ctx.previewGroup, arc.center, arc.radius, arc.startAngle, arc.endAngle, arc.ccw, ctx.plane);
      }
      addDot(ctx.previewGroup, target.point, highlight, ctx.camera, ctx.planeNormal, ctx.plane, 0.9);
      return;
    }

    if (this.mousePoint) {
      const arc = this.computeArcPreview(ctx.startPoint, this.mousePoint, ctx.tangent.direction);
      if (arc) {
        addDashedArc(ctx.previewGroup, arc.center, arc.radius, arc.startAngle, arc.endAngle, arc.ccw, ctx.plane);
      }

      if (this.lastSnapType !== 'none') {
        const color = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
        addDot(ctx.previewGroup, this.mousePoint, color, ctx.camera, ctx.planeNormal, ctx.plane, 0.6);
      }
    }
  }
}
