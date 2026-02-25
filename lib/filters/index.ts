import { FaceFilterBuilder } from './face/face-filter.js';
import { EdgeFilterBuilder } from './edge/edge-filter.js';

export function face() {
  return new FaceFilterBuilder();
}

export function edge() {
  return new EdgeFilterBuilder();
}
