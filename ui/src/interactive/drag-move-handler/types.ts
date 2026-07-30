export type DragHitResult = {
  sourceLocation: { line: number; column: number };
  uniqueType: string;
  // 'angle' is the aline angle indicator (double-click dimension edit only).
  hitZone: 'start' | 'end' | 'body' | 'center' | 'angle';
  anchorPoint?: [number, number];
  fixedVertex?: [number, number];
  fixedVertex2?: [number, number];
  originalDistance?: number;
  initialValue?: number;
  draggedVertices?: [number, number][];
  arcCCW?: boolean;
  arcArgCount?: number;
  /**
   * The tArc statement's radius argument is negative (start-reversed leave).
   * The to-target overload cannot express that form, so the end-drag edge
   * snap is not offered.
   */
  tarcRadiusNegative?: boolean;
  tangentDir?: [number, number];
  rectCentered?: boolean;
  rectDim?: 'width' | 'height' | 'radius';
  rectRadiusArgOffset?: number;
  bezierPoleIndex?: number;
  bezierPoles?: [number, number][];
  polygonSides?: number;
  slotHasTwoPoints?: boolean;
  slotAxisDir?: [number, number];
  slotOtherCenter?: [number, number];
  slotRadius?: number;
  slotPointIndex?: number;
};

export type PendingHit = {
  hit: DragHitResult;
  point2d: [number, number];
  clientX: number;
  clientY: number;
};

export type GetSketchSourceLineFn = () => number | null;

export const DRAG_RENDER_ORDER = 5;
export const DRAG_THRESHOLD_PX = 4;
