import { Point } from "../math/point.js";

export function degree(rad: number): number {
  return rad * (180 / Math.PI);
}

export function rad(deg: number): number {
  return deg * (Math.PI / 180);
}

