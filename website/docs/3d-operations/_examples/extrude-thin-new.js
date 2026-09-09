// @screenshot view iso-ftr
import { sketch, plane, extrude, circle, line } from 'fluidcad/core';
import { coincident, diameter, distance, fix, horizontal, vertical } from "fluidcad/constraints";

// The base part every column shares: a 60 mm cube.
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

// The feature profile: a Ø50 circle on the cube's right-hand face. The face
// normal points away from the cube, so an extrusion grows out sideways and a
// cut bores straight in.
sketch(plane("yz", { offset: 30 }), () => {
    const c = circle([0, 30], 50);
    fix(c.center(), [0, 30]);
    diameter(c, 50);
  })

// New tab, Thin on: the same tube as a separate body.
// highlight-next-line
extrude(40).thin(3).new();
