// Spec-level predicates classifying a producer slot by the feature that consumes it.

import { requiredChainRoots, SKETCH_PRODUCER_CALLEES } from './callees.ts';
import type { ApplyFeatureEditSpec } from '../spec.ts';

/** Whether producer index `i` is a valid sketch producer of `spec`. */
export function isSketchProducer(spec: ApplyFeatureEditSpec, i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < spec.producers.length
    && spec.producers[i].featureType === 'sketch';
}

/**
 * Whether producer index `i` is a valid wire producer of `spec` — a sketch
 * or a helix, for the slots that consume a bare wire (a sweep path, a loft
 * guide). Plain 'sketch' is accepted too: it is a strictly narrower claim.
 */
export function isWireProducer(spec: ApplyFeatureEditSpec, i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < spec.producers.length
    && (spec.producers[i].featureType === 'wire' || spec.producers[i].featureType === 'sketch');
}

/** Whether producer index `i` is a valid plane producer of `spec`. */
export function isPlaneProducer(spec: ApplyFeatureEditSpec, i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < spec.producers.length
    && spec.producers[i].featureType === 'plane';
}

/** Whether producer index `i` is a valid axis producer of `spec`. */
export function isAxisProducer(spec: ApplyFeatureEditSpec, i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < spec.producers.length
    && spec.producers[i].featureType === 'axis';
}

/** Whether producer index `i` is a valid repeat-target feature producer. */
export function isFeatureProducer(spec: ApplyFeatureEditSpec, i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < spec.producers.length
    && spec.producers[i].featureType === 'feature';
}

/**
 * Whether producer index `i` can serve as a `.scope(…)` target: a bound
 * producer of a solid-bearing statement — the dedicated `feature` type, or a
 * selector part's own producer (whose featureType is the producing feature,
 * e.g. 'extrude') doubling as the scope target when both reference the same
 * statement. The identity-referenced kinds (sketch/plane/axis/wire, and the
 * extrude profile's 'offset') never bear solids, so they never qualify.
 */
export function isScopeTargetProducer(spec: ApplyFeatureEditSpec, i: number): boolean {
  if (!Number.isInteger(i) || i < 0 || i >= spec.producers.length) {
    return false;
  }
  const producer = spec.producers[i];
  return producer.bind !== false
    && requiredChainRoots(producer.featureType) === null
    && producer.featureType !== 'offset'
    && SKETCH_PRODUCER_CALLEES[producer.featureType] === undefined;
}

/**
 * Whether producer index `i` may be a copy target: a 3D feature producer, or
 * — the 2D in-sketch form — a sketch-geometry producer (rect, circle, …).
 */
export function isCopyTargetProducer(spec: ApplyFeatureEditSpec, i: number): boolean {
  if (!Number.isInteger(i) || i < 0 || i >= spec.producers.length) {
    return false;
  }
  const type = spec.producers[i].featureType;
  return type === 'feature' || SKETCH_PRODUCER_CALLEES[type] !== undefined;
}
