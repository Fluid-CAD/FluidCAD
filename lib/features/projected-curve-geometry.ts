import type { TopoDS_Edge } from "ocjs-fluidcad";
import { Edge } from "../common/edge.js";
import { Wire } from "../common/wire.js";
import { BuildError } from "../common/build-error.js";
import { CurveOperand } from "../helpers/curve-operand.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { getOC } from "../oc/init.js";
import { ProjectionOps } from "../oc/projection-ops.js";
import { ShapeMeasure } from "../oc/shape-measure.js";
import { WireOps } from "../oc/wire-ops.js";
import { mmTol } from "../units/tolerance.js";
import { facesShape, type IntersectionFaces } from "./intersection-curve-geometry.js";

/** How each point of the source travels: along one line, or to the closest point of the target. */
export type ProjectionMode = 'direction' | 'normal';

/** Which images stay: for each source chain what lies nearest it (see {@link buildProjectedWires}), or every one. */
export type ProjectionKeep = 'nearest' | 'all';

/** What a projection is asked, its direction already read. */
export type ProjectionOptions = {
  mode: ProjectionMode;
  /**
   * Mode 'direction': the line every point travels along, both ways. Its
   * sign only breaks a tie between two images equally near. Ignored in mode
   * 'normal'.
   */
  direction: Vector3d | null;
  keep: ProjectionKeep;
};

/** Points sampled along each source edge, to match images against. */
const SOURCE_SAMPLES = 12;
/** Points sampled along each image edge. */
const IMAGE_SAMPLES = 24;

/**
 * The direction a projection given none travels along: the normal of the
 * plane the source lies in. A source that is all sketch geometry lies in its
 * sketch's plane, even a single straight line; anything else lies in the
 * plane its edges do. `sketchPlanes` holds, per source operand, the plane of
 * the sketch it belongs to, or null.
 *
 * A source in no one plane has no natural direction: refused.
 */
export function naturalDirection(sketchPlanes: readonly (Plane | null)[], edges: readonly Edge[]): Vector3d {
  const planes = sketchPlanes.filter((plane): plane is Plane => plane !== null);
  if (planes.length > 0 && planes.length === sketchPlanes.length
    && planes.every(plane => plane.normal.normalize().cross(planes[0].normal.normalize()).length() <= 1e-9)) {
    return planes[0].normal.normalize();
  }
  const plane = CurveOperand.planeOf(edges);
  if (plane) {
    return plane.normal.normalize();
  }
  throw new BuildError(
    `project: the source does not lie in a plane, so it has no natural direction.`,
    `Add .direction(…), or use .mode('normal').`,
  );
}

/**
 * The images of the source wires on the target, as wires, needing no scene
 * (the build and the live preview both call it).
 *
 * Each source wire is projected on its own: along the line of the direction
 * both ways (`ProjectionOps.alongDirection`), or each point to the closest
 * point of the target (`ProjectionOps.normal`).
 *
 * Keep 'all' leaves every image. Keep 'nearest' leaves, along the
 * direction, what the line through each point of the source meets nearest
 * that point: an image edge that lies behind another image wherever the two
 * share a line is left out, and what is left is chained again — the far
 * side of a body goes, every stretch of the near side stays. Normal to the
 * faces, it leaves the image at the smallest distance from the source.
 *
 * Every image runs the same way as its source (an open image starts at the
 * image of the source's start, as far as the image reaches). Images come in
 * source order; those of one source in the order they start along it, the
 * nearest first where they start together. A source with no image adds
 * none; no image at all, or one the kernel left broken, is the "misses"
 * refusal.
 */
export function buildProjectedWires(sources: readonly Wire[], target: IntersectionFaces, options: ProjectionOptions): Wire[] {
  const direction = options.mode === 'direction' ? requireDirection(options.direction) : null;
  const shape = facesShape(target);
  const kept: Wire[] = [];
  try {
    for (const source of sources) {
      let images = direction
        ? ProjectionOps.alongDirection(source, shape.shape, direction)
        : ProjectionOps.normal(source, shape.shape);
      if (images.length === 0) {
        continue;
      }
      const from = sampleWire(source, SOURCE_SAMPLES);
      const taken = new Set<Wire>();
      try {
        if (direction && options.keep === 'nearest') {
          images = frontOf(images, from, direction);
        }
        const ranked = rankImages(images, source, from, direction);
        const chosen = options.keep === 'nearest' && !direction ? ranked.slice(0, 1) : ranked;
        if (chosen.some(image => !isSound(image.wire))) {
          throw misses(direction);
        }
        for (const image of chosen) {
          if (image.reverse) {
            kept.push(WireOps.reverseWire(image.wire));
          } else {
            taken.add(image.wire);
            kept.push(image.wire);
          }
        }
      } finally {
        images.filter(wire => !taken.has(wire)).forEach(wire => wire.dispose());
      }
    }
  } catch (error) {
    kept.forEach(wire => wire.dispose());
    throw error;
  } finally {
    shape.dispose();
  }
  if (kept.length === 0) {
    throw misses(direction);
  }
  return kept;
}

/** An image edge, sampled: across the direction and along it, from the source point each sample came from. */
type Piece = {
  edge: Edge;
  /** Each sample's place across the direction (its point with the part along the direction taken out). */
  across: Vector3d[];
  /** How far each sample travelled along the direction from its source point, signed. */
  travel: number[];
  /** The widest step across the direction between two neighbouring samples: how near a line must pass to cross the edge. */
  step: number;
};

/** The share of an edge's samples that must lie behind other images for the edge to be left out. */
const BEHIND_SHARE = 0.9;

/**
 * Of the images along the direction, the edges that lie in front: an edge is
 * left out when nearly all its samples have, on the same line, a point of
 * another image edge nearer the source. Edges are first split where they
 * fold round a silhouette, and what is left is chained again. The images
 * given are freed when they are replaced.
 */
function frontOf(given: Wire[], from: Sample[], direction: Vector3d): Wire[] {
  // Where an image folds round a face's silhouette its near and far sides
  // meet inside one edge: split there, so each side is an edge of its own.
  const images = ProjectionOps.splitAtFolds(given, direction);
  const across = (point: Point) => {
    const vector = point.toVector3d();
    return vector.subtract(direction.multiply(vector.dot(direction)));
  };
  const sourceAcross = from.map(sample => across(sample.point));
  const pieces: Piece[] = images.flatMap(wire => wire.getEdges()).map(edge => {
    const samples = sampleEdge(edge, IMAGE_SAMPLES);
    const places = samples.map(sample => across(sample.point));
    const travel = samples.map((sample, i) => {
      const origin = from[nearestIndex(sourceAcross, places[i])];
      return origin.point.vectorTo(sample.point).dot(direction);
    });
    let step = 0;
    for (let i = 1; i < places.length; i++) {
      step = Math.max(step, places[i].distanceTo(places[i - 1]));
    }
    return { edge, across: places, travel, step };
  });

  const reach = mmTol(1e-5);
  const margin = mmTol(1e-4);
  const behind = (piece: Piece): boolean => {
    let hidden = 0;
    piece.across.forEach((place, i) => {
      const covered = pieces.some(other => {
        if (other === piece) {
          return false;
        }
        const j = nearestIndex(other.across, place);
        return other.across[j].distanceTo(place) <= other.step + reach
          && Math.abs(other.travel[j]) < Math.abs(piece.travel[i]) - margin;
      });
      if (covered) {
        hidden++;
      }
    });
    return hidden >= BEHIND_SHARE * piece.across.length;
  };

  const front = pieces.filter(piece => !behind(piece)).map(piece => piece.edge);
  if (front.length === pieces.length) {
    return images;
  }
  const chained = front.length > 0 ? WireOps.chainEdges(front) : [];
  images.forEach(wire => wire.dispose());
  return chained;
}

/** One image of a source wire, measured against it. */
type RankedImage = {
  wire: Wire;
  /** Where along the source it starts, as a share of the source's samples: 0 for a closed image. */
  start: number;
  /** How far it lies from the source: the mean travel along the direction, or the smallest distance. */
  distance: number;
  /** Along the direction, the mean signed travel: of two images equally near, the one ahead comes first. */
  ahead: number;
  centre: Point;
  /** Whether it runs against its source. */
  reverse: boolean;
};

/** The images of one source wire, in order (see {@link buildProjectedWires}), each told whether it runs against the source. */
function rankImages(images: readonly Wire[], source: Wire, from: Sample[], direction: Vector3d | null): RankedImage[] {
  const ranked = images.map(wire => measureImage(wire, source, from, direction));
  const tolerance = mmTol(1e-6);
  ranked.sort((a, b) => {
    if (Math.abs(a.start - b.start) > 1e-9) {
      return a.start - b.start;
    }
    if (Math.abs(a.distance - b.distance) > tolerance) {
      return a.distance - b.distance;
    }
    if (Math.abs(a.ahead - b.ahead) > tolerance) {
      return b.ahead - a.ahead;
    }
    return lexCompare(a.centre, b.centre, tolerance);
  });
  return ranked;
}

/**
 * How far `image` lies from the source, which way it runs and where along
 * the source it starts.
 *
 * Every point of the source is matched to the image point it went to: along
 * the direction, the one on its line (the nearest across the direction);
 * normal to the faces, the nearest. The image runs against the source where
 * their tangents at matched points point apart, summed over the source.
 * Along the direction, the image's points are matched back the same way,
 * and how far each travelled along the direction gives its distance.
 */
function measureImage(image: Wire, source: Wire, from: Sample[], direction: Vector3d | null): RankedImage {
  const to = sampleWire(image, IMAGE_SAMPLES);
  const across = (vector: Vector3d) => direction ? vector.subtract(direction.multiply(vector.dot(direction))) : vector;
  const gap = (a: Point, b: Point) => across(a.vectorTo(b)).length();

  let agreement = 0;
  for (const sample of from) {
    const match = to[nearestBy(to, sample.point, gap)];
    agreement += across(sample.tangent).dot(across(match.tangent));
  }
  const reverse = agreement < 0;

  // Where the image starts once it runs as its source does.
  const head = reverse ? to[to.length - 1] : to[0];
  const closed = image.isClosed();
  const start = closed ? 0 : nearestBy(from, head.point, gap) / from.length;
  const centre = ShapeMeasure.centerOfMass(image);
  if (!direction) {
    return { wire: image, start, distance: minimumDistance(source, image), ahead: 0, centre, reverse };
  }
  let travel = 0;
  let signed = 0;
  for (const sample of to) {
    const origin = from[nearestBy(from, sample.point, gap)];
    const along = origin.point.vectorTo(sample.point).dot(direction);
    travel += Math.abs(along);
    signed += along;
  }
  return { wire: image, start, distance: travel / to.length, ahead: signed / to.length, centre, reverse };
}

/** A point along a wire, with the unit tangent there in the wire's walk. */
export type Sample = { point: Point; tangent: Vector3d };

/** Points along `wire`, `perEdge` on each edge between its ends, with the wire's tangent at each, in its walk. */
export function sampleWire(wire: Wire, perEdge: number): Sample[] {
  return wire.getEdges().flatMap(edge => sampleEdge(edge, perEdge));
}

/** `count` points along `edge` between its ends, with the tangent at each, in the edge's own direction. */
export function sampleEdge(edge: Edge, count: number): Sample[] {
  const oc = getOC();
  const raw = edge.getShape() as TopoDS_Edge;
  const sense = raw.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED ? -1 : 1;
  const adaptor = new oc.BRepAdaptor_Curve(raw);
  const point = new oc.gp_Pnt();
  const vector = new oc.gp_Vec();
  const samples: Sample[] = [];
  try {
    const first = adaptor.FirstParameter();
    const last = adaptor.LastParameter();
    for (let i = 0; i < count; i++) {
      // A reversed edge runs from its last parameter to its first.
      const share = sense > 0 ? (i + 0.5) / count : 1 - (i + 0.5) / count;
      adaptor.D1(first + (last - first) * share, point, vector);
      const tangent = new Vector3d(vector.X(), vector.Y(), vector.Z()).multiply(sense);
      samples.push({
        point: new Point(point.X(), point.Y(), point.Z()),
        tangent: tangent.length() > 0 ? tangent.normalize() : tangent,
      });
    }
  } finally {
    vector.delete();
    point.delete();
    adaptor.delete();
  }
  return samples;
}

/** The index of the sample nearest `point` by `gap`. */
function nearestBy(samples: readonly Sample[], point: Point, gap: (a: Point, b: Point) => number): number {
  let best = 0;
  let bestGap = Infinity;
  samples.forEach((sample, i) => {
    const value = gap(sample.point, point);
    if (value < bestGap) {
      best = i;
      bestGap = value;
    }
  });
  return best;
}

/** The index of the vector nearest `place`. */
function nearestIndex(places: readonly Vector3d[], place: Vector3d): number {
  let best = 0;
  let bestDistance = Infinity;
  places.forEach((candidate, i) => {
    const distance = candidate.distanceTo(place);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  });
  return best;
}

/** The smallest distance between two wires. */
function minimumDistance(a: Wire, b: Wire): number {
  const oc = getOC();
  const progress = new oc.Message_ProgressRange();
  const extrema = new oc.BRepExtrema_DistShapeShape(
    a.getShape(), b.getShape(), oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad, progress,
  );
  try {
    return extrema.IsDone() ? extrema.Value() : Infinity;
  } finally {
    extrema.delete();
    progress.delete();
  }
}

/**
 * Whether the kernel left an image sound: the wire passes the kernel's
 * checks, and every edge has a length. A direction nearly along the faces
 * leaves long, badly conditioned images; those are refused, not emitted.
 */
function isSound(wire: Wire): boolean {
  const oc = getOC();
  const analyzer = new oc.BRepCheck_Analyzer(wire.getShape(), true, false);
  try {
    if (!analyzer.IsValid()) {
      return false;
    }
  } finally {
    analyzer.delete();
  }
  return wire.getEdges().every(edge => {
    const length = ShapeMeasure.size(edge);
    return Number.isFinite(length) && length > mmTol(1e-6);
  });
}

/** The refusal of a projection nothing of which lands on the target. */
function misses(direction: Vector3d | null): BuildError {
  return new BuildError(
    `project: the projection misses the target.`,
    direction
      ? `Along ${describeDirection(direction)}, no part of the source falls on the picked faces.`
      : `Normal to the picked faces, no part of the source falls on them.`,
  );
}

function requireDirection(direction: Vector3d | null): Vector3d {
  if (!direction || direction.length() === 0) {
    throw new Error(`project: a projection along a direction was asked for with no direction.`);
  }
  return direction.normalize();
}

/** "X", "Y" or "Z" for a direction along a world axis (either way); its rounded components otherwise. */
function describeDirection(direction: Vector3d): string {
  const axes: [string, Vector3d][] = [['X', new Vector3d(1, 0, 0)], ['Y', new Vector3d(0, 1, 0)], ['Z', new Vector3d(0, 0, 1)]];
  const axis = axes.find(([, unit]) => unit.cross(direction).length() <= 1e-9);
  if (axis) {
    return axis[0];
  }
  return `(${[direction.x, direction.y, direction.z].map(value => String(+value.toFixed(3) + 0)).join(', ')})`;
}

/** Lexicographic order of two points, x then y then z, coordinates within `tolerance` tying. */
function lexCompare(a: Point, b: Point, tolerance: number): number {
  for (const [p, q] of [[a.x, b.x], [a.y, b.y], [a.z, b.z]]) {
    if (p < q - tolerance) {
      return -1;
    }
    if (p > q + tolerance) {
      return 1;
    }
  }
  return 0;
}
