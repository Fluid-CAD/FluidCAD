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
