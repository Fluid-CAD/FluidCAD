// The gear fixture: a spur gear with straight flanks — a disc of `teeth`
// trapezoid teeth round a shaft bore — standing on a picked planar face,
// centred on it. Its class names what a model works on beside its values:
// the tooth tips, flanks and roots, the bore, and the edges of the tips and
// of the bore (derived from their faces), so a model rounds `g.tipEdges()`
// or chamfers `g.boreEdges()`; its top face is the standard `endFaces`,
// declared to document it. The outline and the extrusion are raw
// OpenCascade (`this.occ()`): the curated kernel draws no outline. Written
// against the SDK entry points only, with Feature.with() and defineFeature().

import { Feature, defineFeature, type FeatureArgs, type FeatureWith, type ValuesOf } from "../../../sdk/index.js";
import { getFeatureMeta, type ResolvedFeatureMeta } from "../../../index.js";
import { ShapeFactory, ShapeOps, type Face, type Shape } from "../../../sdk/kernel.js";
import type { OccScope, TopoDS_Edge, TopoDS_Face, TopoDS_Shape, TopoDS_Vertex } from "../../../sdk/occt.js";
import { Matrix4 } from "../../../math/index.js";

export const GEAR_DEFAULTS = { teeth: 20, module: 2, thickness: 8, bore: 8 };

/** The flanks' slant from the tooth's centre line: the old 14.5° rack, which keeps a root land down to ten teeth. */
const FLANK_ANGLE = (14.5 * Math.PI) / 180;

/** The gear's values, as `Feature.with()` declares them. */
const GEAR_PARAMS = {
  face: { picker: 'face', label: 'On face', surface: 'planar', description: 'The planar face the gear stands on, centred on it' },
  teeth: { type: 'integer', default: GEAR_DEFAULTS.teeth, min: 10, max: 120, description: 'How many teeth go round the gear' },
  module: { type: 'length', default: GEAR_DEFAULTS.module, min: 0.2, description: 'The tooth size: the pitch diameter over the number of teeth' },
  thickness: { type: 'length', default: GEAR_DEFAULTS.thickness, min: 0, description: 'How far the gear stands off the face' },
  bore: { type: 'length', default: GEAR_DEFAULTS.bore, min: 0, label: 'Bore diameter', description: 'The shaft hole through the middle; 0 leaves it solid' },
} as const;

/** What the gear names, in the order the editor tries them. */
const GEAR_BUCKETS = {
  tipFaces: { description: 'The top land of every tooth, one per tooth, in tooth order' },
  tipEdges: { description: 'The edges round the tip faces: where a fillet rounds the tooth tips' },
  flankFaces: { description: 'The tooth flanks, two per tooth, in tooth order' },
  rootFaces: { description: 'The bottom land between neighbouring teeth' },
  boreFaces: { description: 'The wall of the shaft hole' },
  boreEdges: { label: 'Bore Rims', description: 'The rims of the shaft hole, top and bottom' },
  endFaces: { description: 'The face of the gear opposite the face it stands on' },
} as const;

/** `gear(face, { teeth, module, thickness, bore })`. */
const GEAR_CALL = ['face', { teeth: 'teeth', module: 'module', thickness: 'thickness', bore: 'bore' }] as const;

export type GearValues = ValuesOf<typeof GEAR_PARAMS>;

/** What a gear names in `setBuckets()`. */
export type GearBuckets = {
  startFaces: Face[]; endFaces: Face[]; sideFaces: Face[]; internalFaces: Face[];
  tipFaces: Face[]; flankFaces: Face[]; rootFaces: Face[]; boreFaces: Face[];
};

/** A gear feature: its values, and the accessors its buckets add (`g.tipEdges()`). */
export type GearFeature = InstanceType<FeatureWith<typeof GEAR_PARAMS, typeof GEAR_BUCKETS>>;

export type GearFunction = (...args: FeatureArgs<typeof GEAR_PARAMS, typeof GEAR_CALL>) => GearFeature;

export type GearDefinition = { Gear: new (values: GearValues) => GearFeature; gear: GearFunction; meta: ResolvedFeatureMeta };

/**
 * What a test may change about the gear it defines: `fill` rewrites what
 * the build hands `setBuckets()` — a misspelt name, a member of another
 * shape — from the buckets it built and the solid it returns.
 */
export type GearVariant = { fill?: (buckets: GearBuckets, solid: Shape) => Record<string, unknown> };

/** The gear's faces by what they are, each an index into the solid's faces. */
type GearFaceIndices = Record<'start' | 'end' | 'tip' | 'flank' | 'root' | 'bore', number[]>;

/**
 * The gear's outline on the XY plane, extruded along Z: for each tooth, a
 * flank, the tip land, the other flank, then the root land to the next
 * tooth, all on shared vertices so the wire takes the edges as they are.
 * The faces are told apart by the outline edge each one was swept from.
 */
function gearBody({ oc, track }: Pick<OccScope, 'oc' | 'track'>, values: GearValues): { solid: Shape; faces: GearFaceIndices } {
  const { teeth, module, thickness, bore } = values;
  const pitch = (module * teeth) / 2;
  const tip = pitch + module;
  const root = pitch - 1.25 * module;
  // Half the tooth's width, across its centre line, at the tip and at the root.
  const tipHalf = (Math.PI * module) / 4 - module * Math.tan(FLANK_ANGLE);
  const rootHalf = (Math.PI * module) / 4 + 1.25 * module * Math.tan(FLANK_ANGLE);
  const step = (2 * Math.PI) / teeth;
  if (step - 2 * Math.asin(rootHalf / root) <= 0) {
    throw new Error(`gear: ${teeth} teeth leave no room between them — give it more teeth`);
  }
  if (bore > 0 && bore / 2 >= root - module) {
    throw new Error(`gear: the bore (${bore}) leaves no rim under the teeth — keep it under ${(2 * (root - module)).toFixed(2)}`);
  }

  const vertex = (radius: number, half: number, angle: number): TopoDS_Vertex => {
    const along = Math.sqrt(radius * radius - half * half);
    const x = along * Math.cos(angle) - half * Math.sin(angle);
    const y = along * Math.sin(angle) + half * Math.cos(angle);
    return track(new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(x, y, 0)).Vertex());
  };
  const axis = new oc.gp_Ax2(new oc.gp_Pnt(0, 0, 0), new oc.gp_Dir(0, 0, 1));
  const tipCircle = new oc.gp_Circ(axis, tip);
  const rootCircle = new oc.gp_Circ(axis, root);

  const corners = Array.from({ length: teeth }, (_, i) => ({
    rootIn: vertex(root, -rootHalf, i * step),
    tipIn: vertex(tip, -tipHalf, i * step),
    tipOut: vertex(tip, tipHalf, i * step),
    rootOut: vertex(root, rootHalf, i * step),
  }));
  const wire = new oc.BRepBuilderAPI_MakeWire();
  const roles: { role: 'flank' | 'tip' | 'root'; edge: TopoDS_Edge }[] = [];
  const add = (role: 'flank' | 'tip' | 'root', edge: TopoDS_Edge) => {
    wire.Add(track(edge));
    roles.push({ role, edge: track(wire.Edge()) });
  };
  corners.forEach((c, i) => {
    const next = corners[(i + 1) % teeth];
    add('flank', new oc.BRepBuilderAPI_MakeEdge(c.rootIn, c.tipIn).Edge());
    add('tip', new oc.BRepBuilderAPI_MakeEdge(tipCircle, c.tipIn, c.tipOut).Edge());
    add('flank', new oc.BRepBuilderAPI_MakeEdge(c.tipOut, c.rootOut).Edge());
    add('root', new oc.BRepBuilderAPI_MakeEdge(rootCircle, c.rootOut, next.rootIn).Edge());
  });
  if (!wire.IsDone()) {
    throw new Error('gear: the outline did not close');
  }

  const face = new oc.BRepBuilderAPI_MakeFace(track(wire.Wire()), true);
  let boreEdge: TopoDS_Edge | null = null;
  if (bore > 0) {
    boreEdge = track(new oc.BRepBuilderAPI_MakeEdge(new oc.gp_Circ(axis, bore / 2)).Edge());
    const boreWire = track(new oc.BRepBuilderAPI_MakeWire(boreEdge).Wire());
    // A hole runs the other way round from the outline.
    face.Add(track(oc.TopoDS.Wire(track(boreWire.Reversed()))));
  }
  const prism = new oc.BRepPrimAPI_MakePrism(track(face.Face()), new oc.gp_Vec(0, 0, thickness), false, true);
  if (!prism.IsDone()) {
    throw new Error('gear: the extrusion failed');
  }

  const solid = ShapeFactory.fromShape(track(prism.Shape()));
  const all = solid.getSubShapes('face');
  const indexOf = (raw: TopoDS_Shape) => all.findIndex(f => f.getShape().IsSame(raw));
  const sweptFrom = (edge: TopoDS_Edge): number[] => {
    const list = track(prism.Generated(edge));
    const found: number[] = [];
    for (; list.Size() > 0; list.RemoveFirst()) {
      const at = indexOf(track(list.First()));
      if (at >= 0) {
        found.push(at);
      }
    }
    return found;
  };
  const faces: GearFaceIndices = {
    start: [indexOf(track(prism.FirstShape()))],
    end: [indexOf(track(prism.LastShape()))],
    tip: [],
    flank: [],
    root: [],
    bore: boreEdge ? sweptFrom(boreEdge) : [],
  };
  for (const { role, edge } of roles) {
    faces[role].push(...sweptFrom(edge));
  }
  return { solid, faces };
}

/**
 * The gear class, its builder and its metadata, made anew on every call — a
 * workspace module is evaluated again on every render, so its class is a new
 * class each time; a test calls this twice to do the same.
 */
export function defineGear(variant: GearVariant = {}): GearDefinition {
  class Gear extends Feature.with(GEAR_PARAMS, { buckets: GEAR_BUCKETS }) {
    static id = 'acme.gear';

    buildTool(): Shape[] {
      const faces = this.facesOf(this.values.face);
      if (faces.length !== 1) {
        throw new Error(`gear: pick one planar face to stand on (got ${faces.length} faces)`);
      }
      const plane = faces[0].getPlane();
      const origin = plane.projectPoint(faces[0].center());
      const body = this.occ(scope => gearBody(scope, this.values));

      // Placed on the face, centred on it, growing along its normal.
      const all = body.solid.getSubShapes('face') as Face[];
      const frame = Matrix4.fromBasis(plane.xDirection, plane.yDirection, plane.normal, origin);
      const placed = ShapeOps.transformTracking(body.solid, frame, all);
      body.solid.dispose();
      const imagesOf = (indices: number[]) => indices.map(i => placed.images[i]).filter((f): f is Face => f !== null);
      const tipFaces = imagesOf(body.faces.tip);
      const flankFaces = imagesOf(body.faces.flank);
      const rootFaces = imagesOf(body.faces.root);
      const boreFaces = imagesOf(body.faces.bore);
      const buckets: GearBuckets = {
        startFaces: imagesOf(body.faces.start),
        endFaces: imagesOf(body.faces.end),
        sideFaces: [...flankFaces, ...tipFaces, ...rootFaces],
        internalFaces: boreFaces,
        tipFaces, flankFaces, rootFaces, boreFaces,
      };
      this.setBuckets(variant.fill ? variant.fill(buckets, placed.shape) as GearBuckets : buckets);
      return [placed.shape];
    }
  }

  const gear = defineFeature(Gear, {
    label: 'Gear',
    description: 'A spur gear with straight flanks and a shaft bore, standing on a planar face',
    group: 'create',
    operations: ['add', 'new'],
    call: GEAR_CALL,
  });
  return { Gear, gear, meta: getFeatureMeta(gear)! };
}

export const { Gear, gear } = defineGear();
