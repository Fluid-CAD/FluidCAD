// The twist fixture, JavaScript copy: a twisted extrusion — a planar face's
// outline lofted up along the face's normal through copies of itself, each
// turned a little further about the normal through the face's centre
// (OpenCascade's BRepOffsetAPI_ThruSections), so a hexagon grows into a
// twisted column — with an optional bore down its axis (a raw
// BRepAlgoAPI_Cut). The curated kernel can't build it, so the feature
// reaches for raw OpenCascade inside its `this.occ()` scope: everything
// constructed through `oc` and everything handed to `track()` is freed when
// the scope closes (`fluidcad/sdk/occt` holds the raw instance itself and
// its types). The editor marks the feature as using raw OpenCascade. This
// is the file a project keeps as `twist.feature.js`, written against the
// public entry points only. The TypeScript copy the lib tests build from is
// lib/tests/fixtures/custom-features/twist.ts; keep the two in step.

import { Feature, defineFeature } from 'fluidcad/sdk';
import { ShapeFactory } from 'fluidcad/sdk/kernel';

export class Twist extends Feature.with({
  face: { picker: 'face', label: 'Profile face', surface: 'planar' },
  height: { type: 'length', default: 20, min: 0 },
  angle: { type: 'angle', default: 90, label: 'Twist' },
  sections: { type: 'integer', default: 8, min: 2, max: 64 },
  bore: { type: 'length', default: 0, min: 0, label: 'Bore diameter' },
}) {
  static id = 'twist';

  buildTool() {
    const { face, height, angle, sections, bore } = this.values;
    const [profile] = this.facesOf(face);
    const outline = profile?.getOuterWire();
    if (!profile || !outline) {
      throw new Error('twist: pick the planar face to twist up from');
    }
    const n = profile.calculateNormal();

    const built = this.occ(({ oc, track }) => {
      // The axis: the face's normal through its centre.
      const props = new oc.GProp_GProps();
      oc.BRepGProp.SurfaceProperties(profile.getShape(), props, false, false);
      const centre = track(props.CentreOfMass());
      const up = new oc.gp_Dir(n.x, n.y, n.z);
      const axis = new oc.gp_Ax1(centre, up);

      // The outline, risen and turned a little further for each section.
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

      // The faces by where they stand: the caps on the face's plane and at
      // the top, the bore's wall inside, the twisted walls around.
      const solid = ShapeFactory.fromShape(body);
      const tolerance = 1e-6 * Math.max(1, height);
      const start = [], end = [], side = [], internal = [];
      for (const f of solid.getSubShapes('face')) {
        const type = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(f.getShape()), true).GetType();
        const c = f.center();
        const rise = (c.x - centre.X()) * n.x + (c.y - centre.Y()) * n.y + (c.z - centre.Z()) * n.z;
        if (type === oc.GeomAbs_SurfaceType.GeomAbs_Plane && Math.abs(rise) < tolerance) {
          start.push(f);
        } else if (type === oc.GeomAbs_SurfaceType.GeomAbs_Plane && Math.abs(rise - height) < tolerance) {
          end.push(f);
        } else if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
          internal.push(f);
        } else {
          side.push(f);
        }
      }
      return { solid, start, end, side, internal };
    });

    this.setBuckets({ startFaces: built.start, endFaces: built.end, sideFaces: built.side, internalFaces: built.internal });
    return [built.solid];
  }
}

export const twist = defineFeature(Twist, {
  label: 'Twist',
  description: 'A twisted extrusion of a planar face, with an optional bore — built with raw OpenCascade',
  icon: './twist.svg',
  group: 'create',
  operations: ['add', 'new'],
  call: ['face', { height: 'height', angle: 'angle', sections: 'sections', bore: 'bore' }],
});
