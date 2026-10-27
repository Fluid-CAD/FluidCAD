// The twist fixture, TypeScript copy: a twisted extrusion — a planar face's
// outline lofted up along the face's normal through copies of itself, each
// turned a little further about the normal through the face's centre
// (OpenCascade's BRepOffsetAPI_ThruSections), so a hexagon grows into a
// twisted column — with an optional bore down its axis (a raw
// BRepAlgoAPI_Cut). The curated kernel can't build it: the feature reaches
// for raw OpenCascade (`fluidcad/sdk/occt`) inside its `this.occ()` scope.
// Written against the SDK entry points only, with Feature.with() and
// defineFeature(). The JavaScript copy is
// server/tests/fixtures/custom-features/twist.feature.js; keep them in step.

import { Feature, defineFeature, type FeatureArgs, type ValuesOf } from "../../../sdk/index.js";
import { getFeatureMeta, type ResolvedFeatureMeta } from "../../../index.js";
import { ShapeFactory, type Face, type Shape } from "../../../sdk/kernel.js";
import { getOC, type OccScope, type TopoDS_Face } from "../../../sdk/occt.js";

export const TWIST_DEFAULTS = { height: 20, angle: 90, sections: 8, bore: 0 };

/** The twist's values, as `Feature.with()` declares them. */
const TWIST_PARAMS = {
  face: {
    picker: 'face', label: 'Profile face', surface: 'planar',
    description: "The planar face whose outline twists upward, such as a sketched profile's extrusion top (foot.endFaces()). Only its outer outline is used, so holes in the face don't carry into the column.",
  },
  height: {
    type: 'length', default: TWIST_DEFAULTS.height, min: 0,
    description: "How far the column rises from the face, along the face's normal.",
  },
  angle: {
    type: 'angle', default: TWIST_DEFAULTS.angle, label: 'Twist',
    description: "How far the top is turned from the bottom, in degrees, about the face's normal through its centre; positive turns anticlockwise seen from above.",
  },
  sections: {
    type: 'integer', default: TWIST_DEFAULTS.sections, min: 2, max: 64,
    description: 'How many steps the loft takes from bottom to top (2 to 64): more sections follow the twist more closely and build more slowly.',
  },
  bore: {
    type: 'length', default: TWIST_DEFAULTS.bore, min: 0, label: 'Bore diameter',
    description: "The diameter of a hole down the column's axis, through its full height; 0 for none. Keep it inside the outline.",
  },
} as const;

/** `twist(face, { height, angle, sections, bore })`. */
const TWIST_CALL = ['face', { height: 'height', angle: 'angle', sections: 'sections', bore: 'bore' }] as const;

export type TwistValues = ValuesOf<typeof TWIST_PARAMS>;

export type TwistFeature = Feature<TwistValues>;

export type TwistFunction = (...args: FeatureArgs<typeof TWIST_PARAMS, typeof TWIST_CALL>) => TwistFeature;

export type TwistDefinition = { Twist: new (values: TwistValues) => TwistFeature; twist: TwistFunction; meta: ResolvedFeatureMeta };

/**
 * `scoped: false` builds the same solid with the raw instance, outside any
 * `this.occ()` scope, and frees nothing — the control the heap test
 * compares the scope against.
 */
export type TwistVariant = { scoped?: boolean };

/** What one build made: the solid, and its faces by bucket. */
type Twisted = { solid: Shape; start: Face[]; end: Face[]; side: Face[]; internal: Face[] };

/**
 * Loft the face's outline through `sections + 1` copies of it — copy `i`
 * risen `height · i/sections` along the face's normal and turned
 * `angle · i/sections` about the normal through the face's centre — and
 * bore it along that normal.
 */
function twisted({ oc, track }: Pick<OccScope, 'oc' | 'track'>, profile: Face, values: TwistValues): Twisted {
  const { height, angle, sections, bore } = values;
  const outline = profile.getOuterWire();
  if (!outline) {
    throw new Error('twist: the profile face has no outline');
  }
  const n = profile.calculateNormal();
  const props = new oc.GProp_GProps();
  oc.BRepGProp.SurfaceProperties(profile.getShape(), props, false, false);
  const centre = track(props.CentreOfMass());
  const up = new oc.gp_Dir(n.x, n.y, n.z);
  const axis = new oc.gp_Ax1(centre, up);

  const loft = new oc.BRepOffsetAPI_ThruSections(true, false, 1e-6);
  // The sections are one outline turned, corner for corner: matching them
  // up again would pair a corner with its neighbour once a step passes half
  // the outline's symmetry (30° for a hexagon) and fold the column.
  loft.CheckCompatibility(false);
  for (let i = 0; i <= sections; i++) {
    const t = i / sections;
    const place = new oc.gp_Trsf();
    place.SetTranslation(new oc.gp_Vec(n.x * height * t, n.y * height * t, n.z * height * t));
    const turn = new oc.gp_Trsf();
    turn.SetRotation(axis, (angle * t * Math.PI) / 180);
    place.Multiply(turn);
    const section = track(outline.getShape().Moved(new oc.TopLoc_Location(place), false));
    loft.AddWire(track(oc.TopoDS.Wire(section)));
  }
  loft.Build(new oc.Message_ProgressRange());
  if (!loft.IsDone()) {
    throw new Error('twist: the loft through the sections failed');
  }

  let body = track(loft.Shape());
  if (bore > 0) {
    // A tool a little longer than the column at both ends, so the cut
    // leaves no sliver of either cap.
    const base = new oc.gp_Pnt(centre.X() - n.x, centre.Y() - n.y, centre.Z() - n.z);
    const tool = new oc.BRepPrimAPI_MakeCylinder(new oc.gp_Ax2(base, up), bore / 2, height + 2);
    const cut = new oc.BRepAlgoAPI_Cut(body, track(tool.Shape()), new oc.Message_ProgressRange());
    if (!cut.IsDone()) {
      throw new Error('twist: the bore could not be cut');
    }
    body = track(cut.Shape());
  }

  // The faces by where they stand: the caps on the face's plane and at the
  // top, the bore's wall inside, the twisted walls around.
  const solid = ShapeFactory.fromShape(body);
  const tolerance = 1e-6 * Math.max(1, height);
  const buckets: Twisted = { solid, start: [], end: [], side: [], internal: [] };
  for (const face of solid.getSubShapes('face')) {
    const surface = new oc.BRepAdaptor_Surface(face.getShape() as TopoDS_Face, true);
    const type = surface.GetType();
    const c = face.center();
    const rise = (c.x - centre.X()) * n.x + (c.y - centre.Y()) * n.y + (c.z - centre.Z()) * n.z;
    if (type === oc.GeomAbs_SurfaceType.GeomAbs_Plane && Math.abs(rise) < tolerance) {
      buckets.start.push(face);
    } else if (type === oc.GeomAbs_SurfaceType.GeomAbs_Plane && Math.abs(rise - height) < tolerance) {
      buckets.end.push(face);
    } else if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
      buckets.internal.push(face);
    } else {
      buckets.side.push(face);
    }
  }
  return buckets;
}

/**
 * The twist class, its builder and its metadata, made anew on every call — a
 * workspace module is evaluated again on every render, so its class is a new
 * class each time; a test calls this twice to do the same.
 */
export function defineTwist(variant: TwistVariant = {}): TwistDefinition {
  const scoped = variant.scoped ?? true;

  class Twist extends Feature.with(TWIST_PARAMS) {
    static id = 'acme.twist';

    buildTool(): Shape[] {
      const [profile] = this.facesOf(this.values.face);
      if (!profile) {
        throw new Error('twist: pick the face to twist up from');
      }
      const built = scoped
        ? this.occ(scope => twisted(scope, profile, this.values))
        : twisted({ oc: getOC(), track: value => value }, profile, this.values);
      this.setBuckets({ startFaces: built.start, endFaces: built.end, sideFaces: built.side, internalFaces: built.internal });
      return [built.solid];
    }
  }

  const twist = defineFeature(Twist, {
    label: 'Twist',
    description: 'A twisted extrusion of a planar face, with an optional bore — built with raw OpenCascade',
    icon: './twist.svg',
    group: 'create',
    operations: ['add', 'new'],
    call: TWIST_CALL,
  });
  return { Twist, twist, meta: getFeatureMeta(twist)! };
}

export const { Twist, twist } = defineTwist();
