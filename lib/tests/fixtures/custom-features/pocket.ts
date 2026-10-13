// The pocket fixture: a rounded-rectangle pocket sunk into a picked planar
// face, centred on it — the recess a lid, a battery bay or a magnet seat is
// milled as. It removes by default and can also be kept apart (`.new()`, the
// pocket's volume as a solid of its own). Its class names what a model works
// on beside its values: the floor and its rim (derived from the floor), the
// walls, and the vertical edges between neighbouring walls (named
// explicitly) — so a model breaks the floor rim with `chamfer(0.5,
// p.floorEdges())`, or rounds a square pocket's corners with `fillet(2,
// p.wallEdges())`. Through a remove they name what the cut left: the floor
// faces up, out of the material, and a pocket that goes right through has
// none. The outline and the extrusion are raw OpenCascade (`this.occ()`):
// the curated kernel draws no outline. Written against the SDK entry points
// only, with Feature.with() and defineFeature().

import { Feature, defineFeature, type FeatureArgs, type FeatureBuckets, type FeatureWith, type ValuesOf } from "../../../sdk/index.js";
import { getFeatureMeta, type ResolvedFeatureMeta } from "../../../index.js";
import { ShapeFactory, ShapeOps, type Edge, type Face, type Shape } from "../../../sdk/kernel.js";
import type { OccScope, TopoDS_Edge, TopoDS_Shape, TopoDS_Vertex } from "../../../sdk/occt.js";
import { Matrix4, Plane, type Point } from "../../../math/index.js";

export const POCKET_DEFAULTS = { length: 30, width: 20, radius: 4, depth: 5 };

/** The pocket's values, as `Feature.with()` declares them. */
const POCKET_PARAMS = {
  face: { picker: 'face', label: 'On face', surface: 'planar', description: 'The planar face the pocket is sunk into, centred on it' },
  length: { type: 'length', default: POCKET_DEFAULTS.length, min: 0, description: "The pocket's size along the face's X direction" },
  width: { type: 'length', default: POCKET_DEFAULTS.width, min: 0, description: "The pocket's size along the face's Y direction" },
  radius: { type: 'length', default: POCKET_DEFAULTS.radius, min: 0, label: 'Corner radius', description: 'The radius of the rounded corners; 0 leaves them square' },
  depth: { type: 'length', default: POCKET_DEFAULTS.depth, min: 0, description: 'How deep the pocket goes into the material' },
} as const;

/** What the pocket names, in the order the editor tries them. */
const POCKET_BUCKETS = {
  floorFaces: {}, // the flat bottom of the pocket; none when the pocket goes right through
  floorEdges: {}, // the rim round the pocket floor: where a chamfer or a fillet breaks the floor edge
  wallFaces: {}, // the walls round the pocket, straight sides and rounded corners, in outline order
  wallEdges: {}, // the vertical edges between neighbouring walls, where the straight sides meet the corners
} as const;

/** `pocket(face, { length, width, radius, depth })`. */
const POCKET_CALL = ['face', { length: 'length', width: 'width', radius: 'radius', depth: 'depth' }] as const;

const POCKET_META = {
  label: 'Pocket',
  description: 'A rounded-rectangle pocket sunk into a planar face',
  group: 'modify',
  operations: ['remove', 'new'],
} as const;

export type PocketValues = ValuesOf<typeof POCKET_PARAMS>;

/** A pocket feature: its values, and the accessors its buckets add (`p.floorEdges()`). */
export type PocketFeature = InstanceType<FeatureWith<typeof POCKET_PARAMS, typeof POCKET_BUCKETS>>;

export type PocketFunction = (...args: FeatureArgs<typeof POCKET_PARAMS, typeof POCKET_CALL>) => PocketFeature;

export type PocketDefinition = { Pocket: new (values: PocketValues) => PocketFeature; pocket: PocketFunction; meta: ResolvedFeatureMeta };

/** What a pocket names: the standard buckets, and its own. */
type PocketBuckets = FeatureBuckets & { floorFaces: Face[]; wallFaces: Face[]; wallEdges: Edge[] };

/** The pocket's faces and edges by what they are, each an index into the solid's faces or edges. */
type PocketParts = { start: number; floor: number; walls: number[]; wallEdges: number[] };

/**
 * The pocket's volume on the XY plane, extruded along +Z by its depth: the
 * outline runs round from the middle of its -Y side — a straight side, then
 * a corner arc, and so on — on shared vertices, so the wire takes the edges
 * as they are. The walls are told apart by the outline edge each one was
 * swept from, and the vertical edges by the outline vertex.
 */
function pocketBody({ oc, track }: Pick<OccScope, 'oc' | 'track'>, values: PocketValues): { solid: Shape; parts: PocketParts } {
  const { length, width, radius, depth } = values;
  if (!(length > 0 && width > 0 && depth > 0)) {
    throw new Error('pocket: give it a length, a width and a depth');
  }
  if (!(2 * radius < Math.min(length, width))) {
    throw new Error(`pocket: the corner radius (${radius}) must be under half the narrower side (${Math.min(length, width) / 2})`);
  }
  const x = length / 2;
  const y = width / 2;
  const vertex = (px: number, py: number): TopoDS_Vertex => track(new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(px, py, 0)).Vertex());

  // Each corner: where the side before it ends, where the side after it starts, and its centre.
  const corners = [[x, -y, -1, 1], [x, y, -1, -1], [-x, y, 1, -1], [-x, -y, 1, 1]].map(([cx, cy, sx, sy], i) => {
    const sideAlongX = i % 2 === 0;
    const into = sideAlongX ? vertex(cx + sx * radius, cy) : vertex(cx, cy + sy * radius);
    const out = radius === 0 ? into : (sideAlongX ? vertex(cx, cy + sy * radius) : vertex(cx + sx * radius, cy));
    return { into, out, centre: new oc.gp_Pnt(cx + sx * radius, cy + sy * radius, 0) };
  });

  const wire = new oc.BRepBuilderAPI_MakeWire();
  const outline: TopoDS_Edge[] = [];
  const add = (edge: TopoDS_Edge) => {
    wire.Add(track(edge));
    outline.push(track(wire.Edge()));
  };
  corners.forEach((corner, i) => {
    const previous = corners[(i + corners.length - 1) % corners.length];
    add(new oc.BRepBuilderAPI_MakeEdge(previous.out, corner.into).Edge());
    if (radius > 0) {
      const axis = new oc.gp_Ax2(corner.centre, new oc.gp_Dir(0, 0, 1));
      add(new oc.BRepBuilderAPI_MakeEdge(new oc.gp_Circ(axis, radius), corner.into, corner.out).Edge());
    }
  });
  if (!wire.IsDone()) {
    throw new Error('pocket: the outline did not close');
  }
  const vertices = corners.flatMap(corner => (radius > 0 ? [corner.into, corner.out] : [corner.into]));

  const face = new oc.BRepBuilderAPI_MakeFace(track(wire.Wire()), true);
  const prism = new oc.BRepPrimAPI_MakePrism(track(face.Face()), new oc.gp_Vec(0, 0, depth), false, true);
  if (!prism.IsDone()) {
    throw new Error('pocket: the extrusion failed');
  }

  const solid = ShapeFactory.fromShape(track(prism.Shape()));
  const faces = solid.getSubShapes('face');
  const edges = solid.getSubShapes('edge');
  const sweptFrom = (raw: TopoDS_Shape, among: Shape[]): number[] => {
    const list = track(prism.Generated(raw));
    const found: number[] = [];
    for (; list.Size() > 0; list.RemoveFirst()) {
      const image = track(list.First());
      const at = among.findIndex(s => s.getShape().IsSame(image));
      if (at >= 0) {
        found.push(at);
      }
    }
    return found;
  };
  return {
    solid,
    parts: {
      start: faces.findIndex(f => f.getShape().IsSame(track(prism.FirstShape()))),
      floor: faces.findIndex(f => f.getShape().IsSame(track(prism.LastShape()))),
      walls: outline.flatMap(edge => sweptFrom(edge, faces)),
      wallEdges: vertices.flatMap(v => sweptFrom(v, edges)),
    },
  };
}

/** Where a pocket stands: the picked face's plane and its centre on it. */
function pocketFrame(faces: Face[]): { plane: Plane; origin: Point } {
  if (faces.length !== 1) {
    throw new Error(`pocket: pick one planar face to sink it into (got ${faces.length} faces)`);
  }
  const plane = faces[0].getPlane();
  return { plane, origin: plane.projectPoint(faces[0].center()) };
}

/**
 * The pocket's volume placed on its face — centred on it, its depth running
 * into the material — and its buckets. The frame keeps the face's X
 * direction and turns Z into the material, so it stays right-handed.
 */
function placePocket(body: ReturnType<typeof pocketBody>, { plane, origin }: ReturnType<typeof pocketFrame>): { tool: Shape; buckets: PocketBuckets } {
  const into = plane.normal.negate();
  const frame = Matrix4.fromBasis(plane.xDirection, plane.yDirection.negate(), into, origin);
  const faceList = body.solid.getSubShapes('face') as Face[];
  const edgeList = body.solid.getSubShapes('edge') as Edge[];
  const placed = ShapeOps.transformTracking(body.solid, frame, [...faceList, ...edgeList]);
  body.solid.dispose();
  const faceAt = (i: number) => placed.images[i] as Face;
  const edgeAt = (i: number) => placed.images[faceList.length + i] as Edge;

  const floorFaces = [faceAt(body.parts.floor)];
  const wallFaces = body.parts.walls.map(faceAt);
  return {
    tool: placed.shape,
    buckets: {
      startFaces: [faceAt(body.parts.start)],
      endFaces: floorFaces,
      sideFaces: wallFaces,
      // The tool grows into the material from the face: a remove reads its
      // rims at the face as start edges, those round the floor as end edges.
      startPlane: new Plane(origin, plane.xDirection, into),
      floorFaces,
      wallFaces,
      wallEdges: body.parts.wallEdges.map(edgeAt),
    },
  };
}

/** The standard buckets of `buckets`, the pocket's own left out. */
function standardOf({ floorFaces: _floor, wallFaces: _walls, wallEdges: _edges, ...standard }: PocketBuckets): FeatureBuckets {
  return standard;
}

/**
 * The pocket class, its builder and its metadata, made anew on every call — a
 * workspace module is evaluated again on every render, so its class is a new
 * class each time.
 */
export function definePocket(): PocketDefinition {
  class Pocket extends Feature.with(POCKET_PARAMS, { buckets: POCKET_BUCKETS }) {
    static id = 'acme.pocket';

    buildTool(): Shape[] {
      const frame = pocketFrame(this.facesOf(this.values.face));
      const { tool, buckets } = placePocket(this.occ(scope => pocketBody(scope, this.values)), frame);
      this.setBuckets(buckets);
      return [tool];
    }
  }

  const pocket = defineFeature(Pocket, { ...POCKET_META, call: POCKET_CALL });
  return { Pocket, pocket, meta: getFeatureMeta(pocket)! };
}

/**
 * The same pocket with no buckets of its own declared — it names the
 * standard ones only — to hold a remove's standard classification to what
 * it is without custom buckets.
 */
export function definePlainPocket(): { pocket: (...args: FeatureArgs<typeof POCKET_PARAMS, typeof POCKET_CALL>) => Feature<PocketValues> } {
  class PlainPocket extends Feature.with(POCKET_PARAMS) {
    static id = 'acme.pocket';

    buildTool(): Shape[] {
      const frame = pocketFrame(this.facesOf(this.values.face));
      const { tool, buckets } = placePocket(this.occ(scope => pocketBody(scope, this.values)), frame);
      this.setBuckets(standardOf(buckets));
      return [tool];
    }
  }

  return { pocket: defineFeature(PlainPocket, { ...POCKET_META, call: POCKET_CALL }) };
}

export const { Pocket, pocket } = definePocket();
