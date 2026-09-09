// @screenshot view iso-ftr
import { sketch, plane, loft, circle, line } from 'fluidcad/core';
import { coincident, diameter, distance, fix, horizontal, vertical } from "fluidcad/constraints";

// Inlet: the same 120 x 70 rectangle on the ground plane.
const inlet = sketch("xy", () => {
    const sg1 = line([-60, -35], [60, -35]);
    const sg2 = line([60, -35], [60, 35]);
    const sg3 = line([60, 35], [-60, 35]);
    const sg4 = line([-60, 35], [-60, -35]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-60, -35]);
    distance(sg1.start(), sg1.end(), 120);
    distance(sg2.start(), sg2.end(), 70);
  })

// Middle section: a Ø80 circle 90 up and 45 across, where the duct turns.
const middle = sketch(plane("xy", { offset: 90 }), () => {
    const c = circle([45, 0], 80);
    fix(c.center(), [45, 0]);
    diameter(c, 80);
  })

// Outlet: the same Ø80 circle again, 180 up and 90 across.
const outlet = sketch(plane("xy", { offset: 180 }), () => {
    const c = circle([90, 0], 80);
    fix(c.center(), [90, 0]);
    diameter(c, 80);
  })

// The surface passes through the three sections in order, so the middle one
// is what carries the duct sideways as it rises.
// highlight-next-line
loft(inlet, middle, outlet);
