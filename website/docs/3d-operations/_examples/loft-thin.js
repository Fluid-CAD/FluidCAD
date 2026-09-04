import { sketch, loft, plane } from 'fluidcad/core';
import { circle, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

const s1 = sketch("xy", () => {
    circle([0, 0], 100);
  })

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

// highlight-next-line
loft(s1, s2).thin(5)
