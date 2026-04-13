import { FaceFilterBuilder } from './face/face-filter.js';
import { EdgeFilterBuilder } from './edge/edge-filter.js';

/**
 * Creates a new face filter builder for selecting faces by geometric properties.
 */
export function face() {
  return new FaceFilterBuilder();
}

/**
 * Creates a new edge filter builder for selecting edges by geometric properties.
 */
export function edge() {
  return new EdgeFilterBuilder();
}
