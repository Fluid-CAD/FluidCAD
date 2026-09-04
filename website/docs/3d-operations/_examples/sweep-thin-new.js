// @screenshot view iso-ftr
import { sketch, extrude, sweep, plane, circle, line, arc } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

// The base part every column shares: a 120 x 60 drawer front, 15 thick,
// standing on the front plane.
sketch("xz", () => {
    const sg1 = line([-60, 0], [60, 0]);
    const sg2 = line([60, 0], [60, 60]);
    const sg3 = line([60, 60], [-60, 60]);
    const sg4 = line([-60, 60], [-60, 0]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-60, 0]);
    distance(sg1.start(), sg1.end(), 120);
    distance(sg2.start(), sg2.end(), 60);
  })
const front = extrude(15)

// The path: a shallow arch drawn on the panel's front face, 80 wide.
const path = sketch(front.endFaces(), () => {
    const a = arc([-40, 20], [40, 20], [0, -40]).cw();
    fix(a.start(), [-40, 20]);
    fix(a.end(), [40, 20]);
  })

// The profile: a Ø16 circle at the path's start, on a plane normal to the
// path there. Its centre sits on the panel face, so the tube runs half in,
// half out of the panel.
const profile = sketch(plane(path, 'start'), () => {
    circle([0, 0], 16);
  })

// New + Thin: the tube wall as a separate body.
// highlight-next-line
sweep(path, profile).thin(2).new()
