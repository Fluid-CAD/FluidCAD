import { Camera, Group, Vector3 } from 'three';
import { PlaneData, SceneObjectRender } from '../../../types';
import { CommitResult } from '../../../ui/expression-input';
import { SnapResult } from '../../../snapping/types';
import { NewVariable } from '../../sketch-tool';

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

export type ModeContext = {
  readonly plane: PlaneData;
  readonly previewGroup: Group;
  readonly camera: Camera;
  readonly planeNormal: Vector3;
  readonly tangent: TangentInfo | null;
  readonly sceneObjects: SceneObjectRender[];
  readonly sketchId: string;
  readonly startPoint: Point2D;
  isAtCurrentPosition(point: Point2D): boolean;
  /**
   * A typed chain-start address not yet written to the source, formatted as a
   * point argument (`[w / 2, 10]`), or null. Non-null means the segment must
   * write the start itself via its explicit-start overload — never the
   * chained form, even when the address lands on the cursor.
   */
  pendingStartText(): string | null;
  /** Declarations riding the pending chain start (a typed address's variables). */
  pendingStartVariables(): NewVariable[];
  /**
   * Mark the pending chain start as spent by an out-of-band commit (the
   * apply-feature path writes the statement server-side), so the next
   * segment doesn't write it again.
   */
  clearPendingStart(): void;
  /** Convert a pixel distance to sketch units at the current zoom. */
  pixelThreshold(px: number): number;
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
  insertGeometry(statement: string, newVariable?: NewVariable | NewVariable[]): void;
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
