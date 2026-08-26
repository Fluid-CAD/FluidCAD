import { Camera, Group, Vector3 } from 'three';
import { PlaneData } from '../../../types';
import { CommitResult } from '../../../ui/expression-input';
import { SnapResult } from '../../../snapping/types';
import { NewVariable } from '../../sketch-tool';
import type { SolvedConstraintParam, SolvedEmissionTargetParam } from '../solved-emission';

export type Point2D = [number, number];

export type TangentInfo = {
  direction: Point2D;
  point: Point2D;
};

export const enum PolylinePhase {
  IDLE,
  DRAWING,
}

export type ModeId = 'line' | 'aLine' | 'arc' | 'tArc' | 'tLine';

export const MODE_ORDER: ModeId[] = ['line', 'aLine', 'arc', 'tArc', 'tLine'];

export type SegmentCommitResult = {
  endpoint: Point2D;
  exitTangent: TangentInfo | null;
};

export type ClickResult =
  | { kind: 'consumed' }
  | { kind: 'committed'; result: SegmentCommitResult }
  | { kind: 'ignored' };

/** One fully-specified segment emission from a mode (solved sketches). The
 * TOOL owns the chain bookkeeping: it prepends the junction coincident to the
 * previous segment (or the chain-start snap ref) and appends the end-snap
 * coincident, then sends everything through the atomic insert-solved rail. */
export type SolvedSegmentSpec = {
  kind: 'line' | 'arc';
  /** Rendered geometry text, e.g. `line([0, 0], [40, 0])` / `arc(…).cw()`. */
  text: string;
  /** Mode-specific constraints: `{newIndex: 0}` targets the new segment,
   * `ctx.solved.prevEntity()` the previous one. */
  constraints?: SolvedConstraintParam[];
  /** The end click's snap — the tool derives the end coincident from its
   * provenance (suppressed under Ctrl, or when the emitted endpoint was
   * quantized away from the snapped vertex). */
  endSnap?: SnapResult | null;
  /** The endpoint the segment text actually wrote, to validate endSnap. */
  endPoint?: Point2D;
  newVariable?: NewVariable | NewVariable[];
};

/** Solved-sketch face of the polyline chain (sketch-rewrite P5). */
export type SolvedModeContext = {
  /** The previous chain segment as a constraint target (no role), or null
   * when the chain opened free. */
  prevEntity(): SolvedEmissionTargetParam | null;
  prevKind(): 'line' | 'arc' | null;
  /** The previous segment's own start→end direction (lines only) — the
   * angle constraint's CCW rule is defined on it, NOT on the junction
   * tangent (they differ when the chain resumed from a line's start). */
  prevOrientedDir(): [number, number] | null;
  emitSegment(spec: SolvedSegmentSpec): void;
  /** The sketch dialog's Auto-constraints toggle — gates the INFERRED
   * constraints a mode adds (auto ortho horizontal/vertical), never the
   * gesture-intrinsic ones (tangent/angle modes, typed dimensions). */
  autoConstraints(): boolean;
};

export type ModeContext = {
  readonly plane: PlaneData;
  readonly previewGroup: Group;
  readonly camera: Camera;
  readonly planeNormal: Vector3;
  readonly tangent: TangentInfo | null;
  readonly startPoint: Point2D;
  /**
   * A typed chain-start address not yet written to the source, formatted as a
   * point argument (`[w / 2, 10]`), or null. Non-null means the segment must
   * write the start itself via its explicit-start overload — never the
   * chained form, even when the address lands on the cursor.
   */
  pendingStartText(): string | null;
  /** Show (or clear, with null) a hint line under the cursor's mode badge. */
  setSnapHint(hint: string | null): void;
  /**
   * Best-effort numeric value of a committed expression: arithmetic over the
   * in-scope variables plus the commit's own declaration. Null when the
   * expression can't be resolved statically — geometry that depends on it
   * (preview directions, snap intersections) must not pretend to know it.
   */
  resolveCommittedValue(result: CommitResult): number | null;
  formatPoint(p: Point2D): string;
  solved: SolvedModeContext | null;
  requestRender(): void;
  isOrthoOverride(): boolean;
  showExpressionInput(opts: {
    label: string;
    value: string;
    clientX: number;
    clientY: number;
    onCommit: (result: CommitResult) => void;
  }): void;
  updateExpressionValue(value: number): void;
  updateExpressionPosition(clientX: number, clientY: number): void;
  hideExpressionInput(): void;
  isExpressionVisible(): boolean;
  /** Whether the visible expression input holds USER-TYPED text — a typed
   * value becomes an explicit dimension in a solved sketch, a click-committed
   * one stays a guess. */
  isExpressionTyping(): boolean;
  commitExpressionValue(): void;
  onSegmentCommitted(result: SegmentCommitResult): void;
};

export interface SegmentMode {
  readonly id: ModeId;
  readonly label: string;
  readonly requiresTangent: boolean;

  /** Extra availability gate beyond `requiresTangent`; a mode without one is
   * always available. Only consulted while a chain is being drawn (non-null
   * mode context). */
  isAvailable?(ctx: ModeContext): boolean;

  enter(ctx: ModeContext): void;
  exit(ctx: ModeContext): void;

  handleClick(point: Point2D, snapResult: SnapResult, ctx: ModeContext): ClickResult;
  handleMouseMove(point: Point2D, snapResult: SnapResult, clientX: number, clientY: number, ctx: ModeContext): void;
  handleEscape(ctx: ModeContext): boolean;
  rebuildPreview(ctx: ModeContext): void;
}
