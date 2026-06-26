import type { TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import type {
  MeasureDistanceValue,
  MeasureEntityInfo,
  MeasureEntityRef,
  MeasurePrimaryKey,
  MeasureResult,
  MeasureVec,
} from "./measure-types.js";
import { classifyEdge, classifyFace } from "./classify.js";
import type { ClassifiedEntity } from "./classify.js";
import { maxDistanceBetween, sampleEntityPoints } from "./sampling.js";
import { acuteAngleDeg, add, areParallel, dist, dot, projectPointOnLine, scale, sub } from "./vec.js";

export interface MeasureInput {
  ref: MeasureEntityRef;
  shape: TopoDS_Shape;
}

// sin(angle) tolerance for treating two directions as exactly parallel; loose
// enough to absorb numeric noise from booleans/imports, far below any
// deliberately modeled angle.
const PARALLEL_SIN_TOL = 1e-6;
const PERP_ANGLE_TOL_DEG = 1e-3;

const PRIMARY_LABELS: Record<Exclude<MeasurePrimaryKey, 'angle'>, string> = {
  parallelDist: 'Parallel dist',
  centerDist: 'Center dist',
  axisDist: 'Axis dist',
  minDist: 'Min dist',
  totalArea: 'Area',
  totalLength: 'Length',
};

function mkDist(from: MeasureVec, to: MeasureVec): MeasureDistanceValue {
  return { value: dist(from, to), from, to };
}

function entityInfo(entity: ClassifiedEntity, ref: MeasureEntityRef): MeasureEntityInfo {
  const info: MeasureEntityInfo = { ref, geomType: entity.form };
  if (entity.kind === 'face') {
    info.area = entity.area;
  } else {
    info.length = entity.length;
  }
  if (entity.radius !== undefined) {
    info.radius = entity.radius;
  }
  return info;
}

/** Closest-pair distance between the two B-rep entities via BRepExtrema. */
function minDistanceBetween(a: ClassifiedEntity, b: ClassifiedEntity): MeasureDistanceValue | undefined {
  const oc = getOC();
  const progress = new oc.Message_ProgressRange();
  const calc = new oc.BRepExtrema_DistShapeShape(
    a.shape,
    b.shape,
    oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN,
    oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad,
    progress,
  );

  let result: MeasureDistanceValue | undefined;
  if (calc.IsDone() && calc.NbSolution() > 0) {
    const p1 = calc.PointOnShape1(1);
    const p2 = calc.PointOnShape2(1);
    result = {
      value: calc.Value(),
      from: { x: p1.X(), y: p1.Y(), z: p1.Z() },
      to: { x: p2.X(), y: p2.Y(), z: p2.Z() },
    };
    p1.delete();
    p2.delete();
  }

  calc.delete();
  progress.delete();
  return result;
}

/** A point on the entity's carrier line: the anchor itself for edges, the anchor projected onto the axis for cylinders/cones. */
function axisAnchor(entity: ClassifiedEntity): MeasureVec {
  if (entity.form === 'line') {
    return entity.anchor;
  }
  return projectPointOnLine(entity.anchor, entity.point!, entity.dir!);
}

/** Perpendicular distance from a parallel pair: plane↔plane, plane↔axis, axis↔axis. */
function parallelDistanceBetween(a: ClassifiedEntity, b: ClassifiedEntity): MeasureDistanceValue | undefined {
  const aPlane = a.form === 'plane';
  const bPlane = b.form === 'plane';
  const aAxis = a.dirKind === 'axis';
  const bAxis = b.dirKind === 'axis';

  if (aPlane && bPlane) {
    if (!areParallel(a.dir!, b.dir!, PARALLEL_SIN_TOL)) {
      return undefined;
    }
    const signed = dot(sub(b.anchor, a.anchor), a.dir!);
    return { value: Math.abs(signed), from: a.anchor, to: add(a.anchor, scale(a.dir!, signed)) };
  }

  if ((aPlane && bAxis) || (aAxis && bPlane)) {
    const [plane, axis] = aPlane ? [a, b] : [b, a];
    if (Math.abs(dot(plane.dir!, axis.dir!)) >= PARALLEL_SIN_TOL) {
      return undefined;
    }
    const onAxis = axisAnchor(axis);
    const signed = dot(sub(onAxis, plane.anchor), plane.dir!);
    const onPlane = sub(onAxis, scale(plane.dir!, signed));
    return aPlane ? mkDist(onPlane, onAxis) : mkDist(onAxis, onPlane);
  }

  if (a.form === 'line' && b.form === 'line') {
    if (!areParallel(a.dir!, b.dir!, PARALLEL_SIN_TOL)) {
      return undefined;
    }
    return mkDist(a.anchor, projectPointOnLine(a.anchor, b.point!, b.dir!));
  }

  return undefined;
}

/** Distance between the carrier axes of two parallel axis-bearing entities (cylinder/cone/line), at least one a surface. */
function axisDistanceBetween(a: ClassifiedEntity, b: ClassifiedEntity): MeasureDistanceValue | undefined {
  if (a.dirKind !== 'axis' || b.dirKind !== 'axis') {
    return undefined;
  }
  if (a.form === 'line' && b.form === 'line') {
    return undefined;
  }
  if (!areParallel(a.dir!, b.dir!, PARALLEL_SIN_TOL)) {
    return undefined;
  }
  const from = axisAnchor(a);
  return mkDist(from, projectPointOnLine(from, b.point!, b.dir!));
}

/**
 * Angle between two entities, normalized to [0, 90]°. Normal-vs-normal and
 * axis-vs-axis compare directly; normal-vs-axis measures the axis against the
 * plane (0° when the axis lies in the plane).
 */
function angleBetween(a: ClassifiedEntity, b: ClassifiedEntity): { deg: number; label: string } | undefined {
  if (!a.dir || !b.dir || !a.dirKind || !b.dirKind) {
    return undefined;
  }

  if (a.dirKind === b.dirKind) {
    const deg = acuteAngleDeg(a.dir, b.dir);
    if (a.form === 'plane' && b.form === 'plane') {
      const label = Math.abs(deg - 90) < PERP_ANGLE_TOL_DEG ? 'Perp planes angle' : 'Planes angle';
      return { deg, label };
    }
    if (a.form === 'line' && b.form === 'line') {
      return { deg, label: 'Lines angle' };
    }
    return { deg, label: a.dirKind === 'axis' ? 'Axes angle' : 'Angle' };
  }

  const [normal, axis] = a.dirKind === 'normal' ? [a, b] : [b, a];
  const deg = 90 - acuteAngleDeg(normal.dir!, axis.dir!);
  if (normal.form === 'plane') {
    return { deg, label: axis.form === 'line' ? 'Line-plane angle' : 'Axis-plane angle' };
  }
  return { deg, label: 'Angle' };
}

function isParallelPair(a: ClassifiedEntity, b: ClassifiedEntity): boolean {
  if (!a.dir || !b.dir || !a.dirKind || !b.dirKind) {
    return false;
  }
  if (a.dirKind === b.dirKind) {
    return areParallel(a.dir, b.dir, PARALLEL_SIN_TOL);
  }
  return Math.abs(dot(a.dir, b.dir)) < PARALLEL_SIN_TOL;
}

function pickPrimary(a: ClassifiedEntity, b: ClassifiedEntity, result: MeasureResult): MeasurePrimaryKey {
  const parallel = isParallelPair(a, b);
  const planeLike = (e: ClassifiedEntity) => e.form === 'plane' || e.form === 'line';

  if (planeLike(a) && planeLike(b)) {
    return parallel && result.parallelDist ? 'parallelDist' : 'angle';
  }
  if (result.centerDist) {
    return 'centerDist';
  }
  if (result.axisDist) {
    return 'axisDist';
  }
  return 'minDist';
}

export class MeasureOps {
  static measure(inputs: MeasureInput[]): MeasureResult {
    const classified = inputs.map((input) =>
      input.ref.kind === 'face' ? classifyFace(input.shape) : classifyEdge(input.shape),
    );

    const result: MeasureResult = {
      entities: classified.map((entity, i) => entityInfo(entity, inputs[i].ref)),
      primary: 'minDist',
      primaryLabel: PRIMARY_LABELS.minDist,
    };

    const faces = classified.filter((e) => e.kind === 'face');
    const edges = classified.filter((e) => e.kind === 'edge');
    if (faces.length > 0) {
      result.totalArea = faces.reduce((sum, e) => sum + (e.area ?? 0), 0);
    }
    if (edges.length > 0) {
      result.totalLength = edges.reduce((sum, e) => sum + (e.length ?? 0), 0);
    }

    if (classified.length === 2) {
      const [a, b] = classified;

      result.minDist = minDistanceBetween(a, b);
      result.maxDist = maxDistanceBetween(sampleEntityPoints(a), sampleEntityPoints(b));
      result.parallelDist = parallelDistanceBetween(a, b);
      result.axisDist = axisDistanceBetween(a, b);
      if (a.center && b.center) {
        result.centerDist = mkDist(a.center, b.center);
      }
      if (!isParallelPair(a, b)) {
        const angle = angleBetween(a, b);
        if (angle) {
          result.angleDeg = angle.deg;
          result.angleLabel = angle.label;
        }
      }

      let primary = pickPrimary(a, b, result);
      if (primary === 'angle' && result.angleDeg === undefined) {
        primary = 'minDist';
      }
      if (primary !== 'angle' && primary !== 'minDist' && !result[primary]) {
        primary = 'minDist';
      }
      result.primary = primary;
      result.primaryLabel = primary === 'angle' ? result.angleLabel! : PRIMARY_LABELS[primary];
      return result;
    }

    // Single entity or 3+ entities: aggregate values only.
    if (result.totalArea !== undefined) {
      result.primary = 'totalArea';
    } else if (result.totalLength !== undefined) {
      result.primary = 'totalLength';
    }
    result.primaryLabel = PRIMARY_LABELS[result.primary as Exclude<MeasurePrimaryKey, 'angle'>];
    return result;
  }
}
