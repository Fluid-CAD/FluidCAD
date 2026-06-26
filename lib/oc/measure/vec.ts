import type { MeasureVec } from "./measure-types.js";

export const sub = (a: MeasureVec, b: MeasureVec): MeasureVec => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

export const add = (a: MeasureVec, b: MeasureVec): MeasureVec => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

export const scale = (a: MeasureVec, s: number): MeasureVec => ({ x: a.x * s, y: a.y * s, z: a.z * s });

export const dot = (a: MeasureVec, b: MeasureVec): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a: MeasureVec, b: MeasureVec): MeasureVec => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export const len = (a: MeasureVec): number => Math.sqrt(dot(a, a));

export const dist = (a: MeasureVec, b: MeasureVec): number => len(sub(a, b));

export function projectPointOnLine(p: MeasureVec, linePoint: MeasureVec, lineDir: MeasureVec): MeasureVec {
  return add(linePoint, scale(lineDir, dot(sub(p, linePoint), lineDir)));
}

/** Acute angle between two unit directions, in degrees ([0, 90], orientation-insensitive). */
export function acuteAngleDeg(a: MeasureVec, b: MeasureVec): number {
  const c = Math.min(1, Math.abs(dot(a, b)));
  return Math.acos(c) * (180 / Math.PI);
}

/** True when two unit directions are parallel (or anti-parallel) within `sinTol`. */
export function areParallel(a: MeasureVec, b: MeasureVec, sinTol: number): boolean {
  return len(cross(a, b)) < sinTol;
}
