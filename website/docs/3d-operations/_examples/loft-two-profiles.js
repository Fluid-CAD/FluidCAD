import { sketch, loft, plane } from 'fluidcad/core';
import { circle, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

// First profile: a Ø100 circle on the top plane.
const s1 = sketch("xy", () => {
    circle([0, 0], 100);
  })

// Second profile: an 80 x 80 square on a plane 100 above the first.
const s2 = sketch(plane("xy", { offset: 100 }), () => {
    const sg1 = line([-40, -40], [40, -40]);
    const sg2 = line([40, -40], [40, 40]);
    const sg3 = line([40, 40], [-40, 40]);
    const sg4 = line([-40, 40], [-40, -40]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-40, -40]);
    distance(sg1.start(), sg1.end(), 80);
    distance(sg2.start(), sg2.end(), 80);
  })

// Blend the circle into the square, in the order the sketches are listed.
loft(s1, s2)
