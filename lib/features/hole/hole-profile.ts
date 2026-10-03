// What a hole() statement says, resolved into the numbers its tool is built
// from — and that tool: one revolved half-profile covering the countersink or
// counterbore, the bore and the drill point, so the cut carves a single clean
// solid instead of a fuse of primitives (the binding has no MakeCone).

import { Shape } from "../../common/shape.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { Axis } from "../../math/axis.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { WireOps } from "../../oc/wire-ops.js";
import { FaceOps } from "../../oc/face-ops.js";
import { ExtrudeOps } from "../../oc/extrude-ops.js";
import { OccHitTest } from "../../oc/hit-test.js";
import { buildOrthonormalFrame } from "../shape-anchor.js";
import { rad } from "../../helpers/math-helpers.js";
import { convertLength, type LengthUnit } from "../../units/units.js";
import {
  FASTENER_TABLE_UNIT,
  findFastenerSize,
  tapDrillFor,
  type FastenerFit,
  type FastenerStandard,
} from "./fastener-tables.js";

export type HoleFastenerSpec =
  | { type: 'clearance'; fit: FastenerFit }
  | { type: 'tapped'; pitch: number | null };

export type HoleStyleSpec =
  | { kind: 'counterbore'; diameter: number | null; depth: number | null }
  | { kind: 'countersink'; diameter: number | null; angle: number | null };

/** The statement's options, numbers in the file's unit; nulls read the fastener tables. */
export interface HoleSpec {
  /** A drilled diameter, or a fastener size label ('M6', '1/4', '#10'). */
  size: number | string;
  fastener: HoleFastenerSpec | null;
  style: HoleStyleSpec | null;
  /** Blind depth to the shoulder, or null for through all. */
  depth: number | null;
  /** Drill point included angle for a blind hole; null is a flat bottom. */
  tipAngle: number | null;
}

export interface HoleFastenerInfo {
  standard: FastenerStandard;
  label: string;
  type: 'clearance' | 'tapped';
  major: number;
  fit?: FastenerFit;
  pitch?: number;
}

/** Every dimension the tool is built from, in the file's unit. */
export interface HoleDimensions {
  diameter: number;
  counterbore: { diameter: number; depth: number } | null;
  countersink: { diameter: number; angle: number } | null;
  depth: number | null;
  tipAngle: number | null;
  fastener: HoleFastenerInfo | null;
}

export const DEFAULT_FASTENER_FIT: FastenerFit = 'normal';

function requirePositive(value: number, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`hole(): ${what} must be a positive number (got ${String(value)})`);
  }
  return value;
}

/**
 * Resolve the statement into numbers. Table values are converted from the
 * standard's unit into `unit`; explicit values are taken as written.
 */
export function resolveHoleDimensions(spec: HoleSpec, unit: LengthUnit): HoleDimensions {
  let diameter: number;
  let fastener: HoleFastenerInfo | null = null;
  let table: { counterbore: { diameter: number; depth: number }; countersink: { diameter: number; angle: number } } | null = null;

  if (typeof spec.size === 'number') {
    diameter = requirePositive(spec.size, 'the diameter');
    if (spec.fastener) {
      throw new Error(`hole(): .${spec.fastener.type}() needs a fastener size such as 'M6' or '1/4' — a numeric size is the drilled diameter`);
    }
  } else if (typeof spec.size === 'string') {
    const found = findFastenerSize(spec.size);
    if (!found) {
      throw new Error(`hole(): unknown fastener size '${spec.size}' — use a metric size like 'M6' or an inch size like '1/4' or '#10'`);
    }
    const from = FASTENER_TABLE_UNIT[found.standard];
    const convert = (value: number) => convertLength(value, from, unit);
    const { size, standard } = found;
    const request = spec.fastener ?? { type: 'clearance', fit: DEFAULT_FASTENER_FIT };
    if (request.type === 'clearance') {
      diameter = convert(size.clearance[request.fit]);
      fastener = { standard, label: size.label, type: 'clearance', major: convert(size.major), fit: request.fit };
    } else {
      const tap = tapDrillFor(size, request.pitch);
      if (!tap) {
        throw new Error(`hole(): ${size.label} has no ${request.pitch} pitch — its pitches are ${size.pitches.join(', ')}`);
      }
      diameter = convert(tap.tapDrill);
      fastener = { standard, label: size.label, type: 'tapped', major: convert(size.major), pitch: tap.pitch };
    }
    table = {
      counterbore: { diameter: convert(size.counterbore.diameter), depth: convert(size.counterbore.depth) },
      countersink: { diameter: convert(size.countersink.diameter), angle: size.countersink.angle },
    };
  } else {
    throw new Error("hole(): the first argument is the hole size — a diameter, or a fastener size like 'M6'");
  }

  let counterbore: HoleDimensions['counterbore'] = null;
  let countersink: HoleDimensions['countersink'] = null;
  if (spec.style?.kind === 'counterbore') {
    if ((spec.style.diameter === null || spec.style.depth === null) && !table) {
      throw new Error("hole(): .counterbore() without values needs a fastener size ('M6', '1/4') to read the table — pass the diameter and depth for a drilled hole");
    }
    counterbore = {
      diameter: spec.style.diameter === null ? table!.counterbore.diameter : requirePositive(spec.style.diameter, 'the counterbore diameter'),
      depth: spec.style.depth === null ? table!.counterbore.depth : requirePositive(spec.style.depth, 'the counterbore depth'),
    };
    if (counterbore.diameter <= diameter) {
      throw new Error(`hole(): the counterbore diameter (${counterbore.diameter}) must be larger than the hole diameter (${diameter})`);
    }
  } else if (spec.style?.kind === 'countersink') {
    if (spec.style.diameter === null && !table) {
      throw new Error("hole(): .countersink() without values needs a fastener size ('M6', '1/4') to read the table — pass the diameter and angle for a drilled hole");
    }
    countersink = {
      diameter: spec.style.diameter === null ? table!.countersink.diameter : requirePositive(spec.style.diameter, 'the countersink diameter'),
      angle: spec.style.angle === null ? (table?.countersink.angle ?? 90) : spec.style.angle,
    };
    if (countersink.diameter <= diameter) {
      throw new Error(`hole(): the countersink diameter (${countersink.diameter}) must be larger than the hole diameter (${diameter})`);
    }
    if (!(countersink.angle > 0 && countersink.angle < 180)) {
      throw new Error(`hole(): the countersink angle must be between 0 and 180 degrees (got ${countersink.angle})`);
    }
  }

  const depth = spec.depth === null ? null : requirePositive(spec.depth, 'the depth');
  const tipAngle = spec.tipAngle === null ? null : spec.tipAngle;
  if (tipAngle !== null && !(tipAngle > 0 && tipAngle < 180)) {
    throw new Error(`hole(): the tip angle must be between 0 and 180 degrees (got ${tipAngle})`);
  }
  if (depth !== null) {
    const entry = counterbore ? counterbore.depth : countersink ? countersinkDepth(countersink, diameter) : 0;
    if (entry >= depth) {
      throw new Error(`hole(): the ${counterbore ? 'counterbore' : 'countersink'} reaches ${entry}, deeper than the hole depth ${depth}`);
    }
  }

  return { diameter, counterbore, countersink, depth, tipAngle, fastener };
}

/** How far a countersink's cone reaches below the surface before it meets the bore. */
export function countersinkDepth(countersink: { diameter: number; angle: number }, diameter: number): number {
  return (countersink.diameter - diameter) / 2 / Math.tan(rad(countersink.angle) / 2);
}

/** The drill point's height below the shoulder. */
export function tipHeight(diameter: number, tipAngle: number | null): number {
  return tipAngle === null ? 0 : diameter / 2 / Math.tan(rad(tipAngle) / 2);
}

/**
 * How far below the placement the hole axis first enters `stock` — where a
 * blind hole in a solid under the placement starts. Null when the axis
 * never reaches it.
 */
export function axisEntryDistance(stock: Shape[], origin: Point, direction: Vector3d): number | null {
  const dir = direction.normalize();
  let entry: number | null = null;
  for (const solid of stock) {
    const distance = OccHitTest.entryDistance(solid.getShape(), origin.toArray(), dir.toArray());
    if (distance !== null && (entry === null || distance < entry)) {
      entry = distance;
    }
  }
  return entry;
}

/**
 * The half-profile of the hole as (radius, depth) pairs, top to bottom, on
 * the axis at both ends. `length` is the bore length below the surface to
 * the shoulder — the blind depth, or the through-all reach.
 */
export function holeProfile(dims: HoleDimensions, length: number): [number, number][] {
  const r = dims.diameter / 2;
  const points: [number, number][] = [[0, 0]];
  if (dims.countersink) {
    points.push([dims.countersink.diameter / 2, 0], [r, countersinkDepth(dims.countersink, dims.diameter)]);
  } else if (dims.counterbore) {
    const R = dims.counterbore.diameter / 2;
    points.push([R, 0], [R, dims.counterbore.depth], [r, dims.counterbore.depth]);
  } else {
    points.push([r, 0]);
  }
  points.push([r, length]);
  points.push([0, length + tipHeight(dims.diameter, dims.tipAngle)]);
  return points;
}

/**
 * The tool solid for one placement: the profile revolved about the hole
 * axis. `direction` points into the material (unit length), `origin` is the
 * point on the surface the hole starts from.
 */
export function buildHoleTool(origin: Point, direction: Vector3d, dims: HoleDimensions, length: number): Shape {
  const axisDir = direction.normalize();
  const frame = buildOrthonormalFrame(origin, axisDir, {});
  const radial = frame.xDirection;
  const at = ([radius, depth]: [number, number]) =>
    origin.add(radial.multiply(radius)).add(axisDir.multiply(depth));

  const profile = holeProfile(dims, length).map(at);
  const edges = [];
  for (let i = 0; i < profile.length; i++) {
    const a = profile[i];
    const b = profile[(i + 1) % profile.length];
    if (a.distanceTo(b) > 0) {
      edges.push(EdgeOps.makeLineEdge(a, b));
    }
  }
  const wire = WireOps.makeWireFromEdges(edges);
  const face = FaceOps.makeFaceWrapped(wire);
  return ExtrudeOps.makeRevol(face, new Axis(origin, axisDir), 2 * Math.PI, { history: false }).solid;
}
