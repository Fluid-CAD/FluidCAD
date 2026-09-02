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

/** A rigid world pose: where an assembly instance sits, in the assembly's unit. */
export interface MeasurePose {
  position: MeasureVec;
  quaternion: { x: number; y: number; z: number; w: number };
}

export interface MeasureEntityRef {
  shapeId: string;
  kind: MeasureEntityKind;
  index: number;
  /**
   * The assembly instance the entity belongs to. Part shapes live once per
   * template in an assembly scene, so two instances of one part share a
   * shapeId — the instance id tells them apart and selects the pose the
   * entity is measured at.
   */
  instanceId?: string;
  /**
   * The instance's live world pose (the browser-side solver owns solved and
   * dragged poses). Absent → the statement pose the scene serialized.
   */
  pose?: MeasurePose;
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
