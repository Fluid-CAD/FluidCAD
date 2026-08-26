import { sketch, sweep } from 'fluidcad/core';
import { circle, line, arc } from 'fluidcad/core';
import { coincident, vertical, tangent, radius, fix } from 'fluidcad/constraints';

const profile = sketch("top", () => {
    circle([0, 0], 40);
  })

const spine = sketch("front", () => {
    const l = line([0, 0], [0, 100]);
    const a1 = arc([0, 100], [-60, 160], [-60, 100]);
    coincident(l.end(), a1.start());
    vertical(l);
    tangent(l, a1);
    fix(l.start());
    radius(a1, 60);
  })

// highlight-next-line
sweep(spine, profile).extend("end", 80)
