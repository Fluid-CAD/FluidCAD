// @screenshot view iso-ftr
import { sketch, extrude, cut, circle, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

// The base part every column shares: a 100 x 60 x 15 mounting plate.
// The four small circles inside the outline become through holes when the
// plate is extruded (nested profiles are drilled by default).
sketch("xy", () => {
    const sg1 = line([-50, -30], [50, -30]);
    const sg2 = line([50, -30], [50, 30]);
    const sg3 = line([50, 30], [-50, 30]);
    const sg4 = line([-50, 30], [-50, -30]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-50, -30]);
    distance(sg1.start(), sg1.end(), 100);
    distance(sg2.start(), sg2.end(), 60);
    // M6 clearance holes, 10 in from each corner
    circle([-40, -20], 6.5);
    circle([40, -20], 6.5);
    circle([40, 20], 6.5);
    circle([-40, 20], 6.5);
  })
const plate = extrude(15)

// The feature profile: a Ø30 circle centred on the plate's top face.
sketch(plate.endFaces(), () => {
    circle([0, 0], 30);
  })

// Remove + Thin: a 3-wide, 8-deep ring groove cut along the circle — a seal groove.
// highlight-next-line
cut(8).thin(3)
