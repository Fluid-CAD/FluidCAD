export interface MeasureVec {
  x: number;
  y: number;
  z: number;
}

/** A distance value together with the two world-space endpoints that realize it. */
export interface MeasureDistanceValue {
  value: number;
  from: MeasureVec;
  to: MeasureVec;
}

export type MeasureEntityKind = 'face' | 'edge';

export interface MeasureEntityRef {
  shapeId: string;
  kind: MeasureEntityKind;
  index: number;
}

export interface MeasureEntityInfo {
  ref: MeasureEntityRef;
  geomType: string;
  area?: number;
  length?: number;
  radius?: number;
}

export type MeasurePrimaryKey =
  | 'parallelDist'
  | 'centerDist'
  | 'axisDist'
  | 'minDist'
  | 'angle'
  | 'totalArea'
  | 'totalLength';

export interface MeasureResult {
  entities: MeasureEntityInfo[];
  primary: MeasurePrimaryKey;
  primaryLabel: string;
  minDist?: MeasureDistanceValue;
  maxDist?: MeasureDistanceValue;
  parallelDist?: MeasureDistanceValue;
  centerDist?: MeasureDistanceValue;
  axisDist?: MeasureDistanceValue;
  angleDeg?: number;
  angleLabel?: string;
  totalArea?: number;
  totalLength?: number;
}
