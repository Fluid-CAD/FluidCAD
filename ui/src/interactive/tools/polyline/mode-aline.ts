import { roundPoint } from '../../sketch-plane-utils';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedLine,
  addDashedArc,
  addSegmentHighlight,
} from '../tool-preview-utils';
import { buildPathTargetIndex, closestPointOnSegment, PathTargetEntry } from '../../sketch-edge-utils';
import { applyAlineToEdge } from '../../../api';
import { themeColors } from '../../../scene/theme-colors';
import type { SceneObjectRender } from '../../../types';
import type { SegmentMode, ModeContext, ClickResult, Point2D, SegmentCommitResult } from './types';
import type { SnapResult } from '../../../snapping/types';
import type { CommitResult } from '../../../ui/expression-input';
import type { NewVariable } from '../../sketch-tool';

const enum ALineSubState {
  AWAITING_ANGLE,
  AWAITING_LENGTH,
}

const ANGLE_SNAP_STEP_DEG = 15;
const ANGLE_SNAP_TOL_DEG = 2.5;

// Fraction of the preview line's length at which the angle-reference arc is drawn.
const ANGLE_ARC_RADIUS_FRACTION = 0.35;

/** Pixel distance at which the line snaps onto an existing geometry target. */
const EDGE_SNAP_PX = 12;
const SNAP_HINT = 'Line up to intersection';
/**
 * A geometry this close to the chain start is the one the line leaves from —
 * never a snap target. Wide enough to absorb the Float32 mesh vertices the
 * edge index is built from, far tighter than any deliberate geometry.
 */
const TOUCH_EPSILON = 1e-3;

/** A snapped target: the geometry to reference and where the line lands. */
type HoverTarget = {
  shapeId: string;
  segments: PathTargetEntry['segments'];
  point: Point2D;
  /** Signed distance from the chain start to the intersection along the locked direction. */
  t: number;
};

/**
 * Two-stage angled-line mode: the first click locks the angle (degrees,
 * measured from the previous segment's end tangent, CCW positive), the second
 * locks the length. Emits the kernel's `aLine(angle, length)`, or the
 * explicit-start `aLine(start, angle, length)` when the chain opens away from
 * the cursor — there the angle reference is +X on both sides.
 */
export class ALineMode implements SegmentMode {
  readonly id = 'aLine' as const;
  readonly label = 'A-Line';
  readonly requiresTangent = false;

  private subState: ALineSubState = ALineSubState.AWAITING_ANGLE;
  private mousePoint: Point2D | null = null;
  private lastSnapType: SnapResult['snapType'] = 'none';
  /** Live mouse-derived angle in degrees, snapped to 15° multiples. */
  private previewAngle = 0;
  /** Numeric angle locked by the first stage (preview/endpoint math). */
  private lockedAngle: number | null = null;
  /**
   * Whether {@link lockedAngle} is the committed expression's actual value.
   * False means the expression couldn't be resolved statically and the mouse
   * angle stands in — the preview is then best-effort, and the edge snap is
   * withheld: it would compute an intersection along a direction the kernel
   * won't draw.
   */
  private angleResolved = false;
  /** Source text for the angle argument — a typed expression or the number. */
  private angleExpr: string | null = null;
  private angleVariable: NewVariable | null = null;
  /** Live mouse-derived length while in AWAITING_LENGTH. */
  private previewLength = 0;

  /** Snap candidates, cached per scene payload (see {@link targets}). */
  private targetEntries: PathTargetEntry[] | null = null;
  private targetSource: SceneObjectRender[] | null = null;
  private hoverTarget: HoverTarget | null = null;
  /** An aLine-to-target apply is in flight — ignore further clicks until it lands. */
  private applying = false;
  /** Bumped on enter/exit so an in-flight apply can't advance a stale chain. */
  private generation = 0;

  enter(ctx: ModeContext): void {
    this.generation++;
    this.reset();
    ctx.setSnapHint(null);
  }

  exit(ctx: ModeContext): void {
    this.generation++;
    this.reset();
    this.targetEntries = null;
    this.targetSource = null;
    ctx.hideExpressionInput();
    ctx.setSnapHint(null);
  }

  private reset(): void {
    this.subState = ALineSubState.AWAITING_ANGLE;
    this.mousePoint = null;
    this.lastSnapType = 'none';
    this.previewAngle = 0;
    this.lockedAngle = null;
    this.angleResolved = false;
    this.angleExpr = null;
    this.angleVariable = null;
    this.previewLength = 0;
    this.hoverTarget = null;
  }

  private referenceDir(ctx: ModeContext): Point2D {
    return ctx.tangent?.direction ?? [1, 0];
  }

  /** Signed angle in degrees from `from` to `to`; positive = CCW, matching the
   * kernel's rotation in lib/features/2d/aline.ts. */
  private signedAngleDeg(from: Point2D, to: Point2D): number {
    const cross = from[0] * to[1] - from[1] * to[0];
    const dot = from[0] * to[0] + from[1] * to[1];
    return (Math.atan2(cross, dot) * 180) / Math.PI;
  }

  private snapAngle(angleDeg: number): number {
    const nearest = Math.round(angleDeg / ANGLE_SNAP_STEP_DEG) * ANGLE_SNAP_STEP_DEG;
    if (Math.abs(angleDeg - nearest) <= ANGLE_SNAP_TOL_DEG) {
      return nearest;
    }
    return angleDeg;
  }

  private rotate(dir: Point2D, angleDeg: number): Point2D {
    const rad = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return [cos * dir[0] - sin * dir[1], sin * dir[0] + cos * dir[1]];
  }

  private lockedDir(ctx: ModeContext): Point2D {
    return this.rotate(this.referenceDir(ctx), this.lockedAngle ?? 0);
  }

  private lengthAlong(dir: Point2D, ctx: ModeContext, point: Point2D): number {
    const dx = point[0] - ctx.startPoint[0];
    const dy = point[1] - ctx.startPoint[1];
    return Math.max(0, dx * dir[0] + dy * dir[1]);
  }

  handleClick(point: Point2D, _snapResult: SnapResult, ctx: ModeContext): ClickResult {
    if (this.subState === ALineSubState.AWAITING_ANGLE) {
      if (ctx.isExpressionVisible()) {
        // The field live-tracks the snapped mouse angle, so a plain click and a
        // typed Enter share one commit path.
        ctx.commitExpressionValue();
        return { kind: 'consumed' };
      }
      const dx = point[0] - ctx.startPoint[0];
      const dy = point[1] - ctx.startPoint[1];
      if (dx === 0 && dy === 0) {
        return { kind: 'ignored' };
      }
      const snapped = this.snapAngle(this.signedAngleDeg(this.referenceDir(ctx), [dx, dy]));
      this.lockAngle(String(Math.round(snapped * 100) / 100), snapped, true, null);
      return { kind: 'consumed' };
    }

    if (this.hoverTarget) {
      return this.commitToTarget(this.hoverTarget, ctx);
    }

    if (ctx.isExpressionVisible()) {
      ctx.commitExpressionValue();
      return { kind: 'ignored' };
    }

    const length = this.lengthAlong(this.lockedDir(ctx), ctx, point);
    const rounded = Math.round(length * 100) / 100;
    if (rounded === 0) {
      return { kind: 'ignored' };
    }
    return { kind: 'committed', result: this.emit(String(rounded), rounded, null, ctx) };
  }

  handleMouseMove(point: Point2D, snapResult: SnapResult, clientX: number, clientY: number, ctx: ModeContext): void {
    this.mousePoint = point;
    this.lastSnapType = snapResult.snapType;

    if (this.subState === ALineSubState.AWAITING_ANGLE) {
      const dx = point[0] - ctx.startPoint[0];
      const dy = point[1] - ctx.startPoint[1];
      if (dx !== 0 || dy !== 0) {
        this.previewAngle = this.snapAngle(this.signedAngleDeg(this.referenceDir(ctx), [dx, dy]));
      }

      if (!ctx.isExpressionVisible()) {
        ctx.showExpressionInput({
          label: 'A:',
          value: String(Math.round(this.previewAngle * 100) / 100),
          clientX,
          clientY,
          onCommit: (result) => this.commitAngle(result, ctx),
        });
      } else {
        ctx.updateExpressionValue(this.previewAngle);
        ctx.updateExpressionPosition(clientX, clientY);
      }
      return;
    }

    this.previewLength = this.lengthAlong(this.lockedDir(ctx), ctx, point);
    this.updateHover(point, ctx);
    if (this.hoverTarget) {
      // The L field tracks the snapped intersection (signed — behind the
      // start is negative), so a typed Enter falls back to the plain
      // overload at the same spot.
      this.previewLength = this.hoverTarget.t;
    }

    if (!ctx.isExpressionVisible()) {
      ctx.showExpressionInput({
        label: 'L:',
        value: String(Math.round(this.previewLength * 100) / 100),
        clientX,
        clientY,
        onCommit: (result) => this.commitLength(result, ctx),
      });
    } else {
      ctx.updateExpressionValue(this.previewLength);
      ctx.updateExpressionPosition(clientX, clientY);
    }
  }

  handleEscape(ctx: ModeContext): boolean {
    if (this.subState === ALineSubState.AWAITING_LENGTH) {
      this.subState = ALineSubState.AWAITING_ANGLE;
      this.lockedAngle = null;
      this.angleResolved = false;
      this.angleExpr = null;
      this.angleVariable = null;
      this.previewLength = 0;
      this.hoverTarget = null;
      ctx.setSnapHint(null);
      ctx.hideExpressionInput();
      return true;
    }
    if (ctx.isExpressionVisible()) {
      ctx.hideExpressionInput();
      return true;
    }
    return false;
  }

  private lockAngle(expr: string, numeric: number, resolved: boolean, variable: NewVariable | null): void {
    this.angleExpr = expr;
    this.angleVariable = variable;
    this.lockedAngle = resolved ? numeric : Math.round(numeric * 100) / 100;
    this.angleResolved = resolved;
    this.subState = ALineSubState.AWAITING_LENGTH;
  }

  private commitAngle(result: CommitResult, ctx: ModeContext): void {
    const { expression, newVariable } = result;
    // The expression's actual value (a variable declaration, parentheses,
    // arithmetic) — parseFloat alone reads none of those, and a preview
    // direction that disagrees with what the kernel will draw corrupts the
    // endpoint math. Only a statically unresolvable expression falls back to
    // the mouse angle, and that fallback withholds the edge snap.
    const value = ctx.resolveCommittedValue(result);
    this.lockAngle(expression, value ?? this.previewAngle, value !== null, newVariable ?? null);
    ctx.hideExpressionInput();
    ctx.requestRender();
  }

  /** Snap candidates ({@link buildPathTargetIndex}), cached per scene payload. */
  private targets(ctx: ModeContext): PathTargetEntry[] {
    if (this.targetSource === ctx.sceneObjects && this.targetEntries) {
      return this.targetEntries;
    }
    this.targetEntries = buildPathTargetIndex(ctx.sceneObjects, ctx.sketchId, ctx.plane);
    this.targetSource = ctx.sceneObjects;
    return this.targetEntries;
  }

  /** Re-evaluate the snap target under the cursor and the hint that goes with it. */
  private updateHover(point: Point2D, ctx: ModeContext): void {
    this.hoverTarget = null;
    // A mouse-fallback angle draws along a direction the kernel won't — an
    // intersection along it would be fiction, so the snap stands down.
    if (!this.angleResolved) {
      ctx.setSnapHint(null);
      return;
    }
    const threshold = ctx.pixelThreshold(EDGE_SNAP_PX);
    const dir = this.lockedDir(ctx);
    let best: { entry: PathTargetEntry; t: number; dist: number } | null = null;

    for (const entry of this.targets(ctx)) {
      let cursorDist = Infinity;
      let startDist = Infinity;
      for (const seg of entry.segments) {
        const c = closestPointOnSegment(point[0], point[1], seg.ax, seg.ay, seg.bx, seg.by);
        if (c.dist < cursorDist) {
          cursorDist = c.dist;
        }
        const s = closestPointOnSegment(ctx.startPoint[0], ctx.startPoint[1], seg.ax, seg.ay, seg.bx, seg.by);
        if (s.dist < startDist) {
          startDist = s.dist;
        }
      }
      // The geometry the chain leaves from touches the start — never a target.
      if (startDist <= TOUCH_EPSILON || cursorDist > threshold) {
        continue;
      }
      if (best && cursorDist >= best.dist) {
        continue;
      }
      // A hovered geometry the locked direction misses entirely solves no
      // intersection — no snap.
      const t = this.nearestIntersectionT(ctx.startPoint, dir, entry.segments);
      if (t !== null) {
        best = { entry, t, dist: cursorDist };
      }
    }

    if (best) {
      this.hoverTarget = {
        shapeId: best.entry.shapeId,
        segments: best.entry.segments,
        point: [ctx.startPoint[0] + dir[0] * best.t, ctx.startPoint[1] + dir[1] * best.t],
        t: best.t,
      };
    }
    ctx.setSnapHint(this.hoverTarget ? SNAP_HINT : null);
  }

  /**
   * Signed distance from `start` along `dir` to the nearest intersection
   * with the segments — in either sign, matching the kernel's ray semantics
   * — or null when the direction misses them entirely. Hits at the start
   * itself are skipped, mirroring the kernel's on-target guard.
   */
  private nearestIntersectionT(start: Point2D, dir: Point2D, segments: PathTargetEntry['segments']): number | null {
    let best: number | null = null;
    for (const seg of segments) {
      const ex = seg.bx - seg.ax;
      const ey = seg.by - seg.ay;
      const denom = ex * dir[1] - ey * dir[0];
      if (Math.abs(denom) < 1e-12) {
        continue;
      }
      const rx = seg.ax - start[0];
      const ry = seg.ay - start[1];
      const t = (ex * ry - ey * rx) / denom;
      const u = (dir[0] * ry - dir[1] * rx) / denom;
      if (u < -1e-9 || u > 1 + 1e-9 || Math.abs(t) < 1e-7) {
        continue;
      }
      if (best === null || Math.abs(t) < Math.abs(best)) {
        best = t;
      }
    }
    return best;
  }

  /**
   * Commit `aLine(angle, target)` for a snapped geometry: the server binds
   * the target's statement to a variable and appends the call to the chain;
   * a chain opened away from the sketch cursor sends its start address along
   * (`aLine([10, 5], 30, l)`), spending the pending typed start. The chain
   * continues optimistically from the computed intersection — the per-render
   * resync adopts the kernel's exact point. A refusal (a repeat clone, a
   * loop body, an out-of-date workspace kernel) degrades to the plain
   * angle + length overload at the same spot, so the drawn shape survives
   * either way.
   */
  private commitToTarget(target: HoverTarget, ctx: ModeContext): ClickResult {
    if (this.applying) {
      return { kind: 'consumed' };
    }
    const angleArg = this.angleExpr ?? String(this.lockedAngle ?? 0);
    const dir = this.lockedDir(ctx);
    // A target behind the start draws the segment backwards; the chain's
    // exit tangent follows the drawn direction, matching the kernel's end
    // tangent.
    const sign = target.t < 0 ? -1 : 1;
    const endpoint: Point2D = [target.point[0], target.point[1]];
    // Mirrors emit(): a chain opening away from the cursor writes its start
    // into the statement, and the angle is then absolute (from +X).
    const pendingStart = ctx.pendingStartText();
    const roundedStart = roundPoint(ctx.startPoint);
    const explicitStart = ctx.tangent === null
      && (pendingStart !== null || !ctx.isAtCurrentPosition(roundedStart));
    const start = explicitStart ? (pendingStart ?? ctx.formatPoint(roundedStart)) : undefined;
    const vars: NewVariable[] = [
      ...(pendingStart !== null ? ctx.pendingStartVariables() : []),
      ...(this.angleVariable ? [this.angleVariable] : []),
    ];

    const generation = this.generation;
    this.applying = true;
    void applyAlineToEdge(angleArg, target.shapeId, {
      start,
      newVariables: vars.length > 0 ? vars : undefined,
    }).then((result) => {
      this.applying = false;
      if (this.generation !== generation) {
        return;         // the mode was exited mid-flight; don't advance the chain
      }
      this.hoverTarget = null;
      ctx.setSnapHint(null);
      if (result.success) {
        if (pendingStart !== null) {
          ctx.clearPendingStart();
        }
        ctx.hideExpressionInput();
        ctx.onSegmentCommitted({
          endpoint,
          exitTangent: { direction: [dir[0] * sign, dir[1] * sign], point: endpoint },
        });
      } else {
        const rounded = Math.round(target.t * 100) / 100;
        if (rounded !== 0) {
          ctx.onSegmentCommitted(this.emit(String(rounded), rounded, null, ctx));
        }
      }
    });
    return { kind: 'consumed' };
  }

  private commitLength(result: CommitResult, ctx: ModeContext): void {
    const { expression, newVariable } = result;
    const value = ctx.resolveCommittedValue(result);
    const numericLength = value ?? Math.round(this.previewLength * 100) / 100;
    ctx.onSegmentCommitted(this.emit(expression, numericLength, newVariable ?? null, ctx));
  }

  private emit(lengthExpr: string, numericLength: number, lengthVariable: NewVariable | null, ctx: ModeContext): SegmentCommitResult {
    const angleArg = this.angleExpr ?? String(this.lockedAngle ?? 0);
    // The explicit-start overload's angle is absolute (from +X): only correct
    // when the preview measured from +X too, i.e. the chain has no tangent
    // here. With a tangent the angle is relative, so the chained form stays
    // even mid-render-lag when the cursor hasn't caught up yet.
    const pendingStart = ctx.pendingStartText();
    const roundedStart = roundPoint(ctx.startPoint);
    const explicitStart = ctx.tangent === null
      && (pendingStart !== null || !ctx.isAtCurrentPosition(roundedStart));
    const statement = explicitStart
      ? `aLine(${pendingStart ?? ctx.formatPoint(roundedStart)}, ${angleArg}, ${lengthExpr})`
      : `aLine(${angleArg}, ${lengthExpr})`;

    const vars: NewVariable[] = [];
    if (this.angleVariable) {
      vars.push(this.angleVariable);
    }
    if (lengthVariable) {
      vars.push(lengthVariable);
    }
    ctx.insertGeometry(statement, vars.length > 0 ? vars : undefined);
    ctx.hideExpressionInput();

    const dir = this.lockedDir(ctx);
    const endpoint = roundPoint([
      ctx.startPoint[0] + dir[0] * numericLength,
      ctx.startPoint[1] + dir[1] * numericLength,
    ]);
    // A typed negative length draws the segment backwards; the chain's exit
    // tangent follows the drawn direction, matching the kernel's end tangent.
    const sign = numericLength < 0 ? -1 : 1;
    const exitDir: Point2D = [dir[0] * sign, dir[1] * sign];

    return { endpoint, exitTangent: { direction: exitDir, point: endpoint } };
  }

  rebuildPreview(ctx: ModeContext): void {
    addDot(ctx.previewGroup, ctx.startPoint, START_POINT_COLOR, ctx.camera, ctx.planeNormal, ctx.plane);

    if (!this.mousePoint) {
      return;
    }

    let effectiveEnd: Point2D | null = null;

    if (this.subState === ALineSubState.AWAITING_ANGLE) {
      const previewDir = this.rotate(this.referenceDir(ctx), this.previewAngle);
      const length = this.lengthAlong(previewDir, ctx, this.mousePoint);
      if (length > 1e-10) {
        effectiveEnd = [
          ctx.startPoint[0] + previewDir[0] * length,
          ctx.startPoint[1] + previewDir[1] * length,
        ];
        addDashedLine(ctx.previewGroup, ctx.startPoint, effectiveEnd, ctx.plane);

        if (Math.abs(this.previewAngle) > 1e-6) {
          const ref = this.referenceDir(ctx);
          const startAngle = Math.atan2(ref[1], ref[0]);
          const endAngle = startAngle + (this.previewAngle * Math.PI) / 180;
          addDashedArc(
            ctx.previewGroup,
            ctx.startPoint,
            length * ANGLE_ARC_RADIUS_FRACTION,
            startAngle,
            endAngle,
            this.previewAngle > 0,
            ctx.plane,
          );
        }
      }
    } else {
      const target = this.hoverTarget;
      if (target) {
        const highlight = themeColors.highlightColor.getHex();
        addSegmentHighlight(ctx.previewGroup, target.segments, ctx.plane, highlight);
        addDashedLine(ctx.previewGroup, ctx.startPoint, target.point, ctx.plane);
        addDot(ctx.previewGroup, target.point, highlight, ctx.camera, ctx.planeNormal, ctx.plane, 0.9);
        return;
      }
      const dir = this.lockedDir(ctx);
      if (this.previewLength > 1e-10) {
        effectiveEnd = [
          ctx.startPoint[0] + dir[0] * this.previewLength,
          ctx.startPoint[1] + dir[1] * this.previewLength,
        ];
        addDashedLine(ctx.previewGroup, ctx.startPoint, effectiveEnd, ctx.plane);
      }
    }

    if (effectiveEnd && this.lastSnapType !== 'none') {
      const snapColor = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
      addDot(ctx.previewGroup, effectiveEnd, snapColor, ctx.camera, ctx.planeNormal, ctx.plane, 0.6);
    }
  }
}
