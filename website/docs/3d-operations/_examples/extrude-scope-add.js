// @screenshot view iso-ftr
import { sketch, plane, extrude, circle, line } from 'fluidcad/core';
import { coincident, diameter, distance, fix, horizontal, vertical } from "fluidcad/constraints";

// The base part every column shares: a 60 mm cube standing on the ground plane.
sketch("xy", () => {
    const sg1 = line([-30, -30], [30, -30]);
    const sg2 = line([30, -30], [30, 30]);
    const sg3 = line([30, 30], [-30, 30]);
    const sg4 = line([-30, 30], [-30, -30]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-30, -30]);
    distance(sg1.start(), sg1.end(), 60);
    distance(sg2.start(), sg2.end(), 60);
  })
extrude(60)

// The feature profile: a Ø50 circle on a plane halfway up the cube, centred
// 45 to the right so it overlaps the cube's right-hand side by 10. Extruding
// symmetrically from this plane grows 30 up and 30 down — the same height as
// the cube — so the cylinder stands on the ground beside the cube and runs
// into it.
sketch(plane("xy", { offset: 30 }), () => {
    const c = circle([45, 0], 50);
    fix(c.center(), [45, 0]);
    diameter(c, 50);
  })

// Add tab, Symmetric direction: a Ø50 cylinder the height of the cube, fused
// with it — one solid, no seam where they meet.
// highlight-next-line
extrude(60).symmetric();
