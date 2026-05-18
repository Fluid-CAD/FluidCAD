export type DragHitResult = {
  sourceLocation: { line: number; column: number };
  uniqueType: string;
  hitZone: 'start' | 'end' | 'body' | 'center';
  anchorPoint?: [number, number];
  fixedVertex?: [number, number];
  fixedVertex2?: [number, number];
  originalDistance?: number;
  initialValue?: number;
  draggedVertices?: [number, number][];
  arcCCW?: boolean;
  arcArgCount?: number;
  arcIsRadiusMode?: boolean;
  arcMajor?: boolean;
  tangentDir?: [number, number];
  rectCentered?: boolean;
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
