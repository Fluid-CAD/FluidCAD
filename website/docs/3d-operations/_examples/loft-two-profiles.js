// @screenshot view iso-ftr
import { sketch, plane, loft, circle, line } from 'fluidcad/core';
import { coincident, diameter, distance, fix, horizontal, vertical } from "fluidcad/constraints";

// Bottom section: a 120 x 70 rectangular duct mouth on the ground plane.
const bottom = sketch("xy", () => {
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

// Top section: a Ø70 round outlet on a plane 110 above the first.
const top = sketch(plane("xy", { offset: 110 }), () => {
    const c = circle([0, 0], 70);
    fix(c.center(), [0, 0]);
    diameter(c, 70);
  })

// Blend the rectangle into the circle, in the order the sketches are listed.
// highlight-next-line
loft(bottom, top);
