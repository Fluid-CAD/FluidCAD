import { sketch, sweep } from 'fluidcad/core';
import { line, arc } from 'fluidcad/core';
import { coincident, vertical, tangent, radius, fix } from 'fluidcad/constraints';

const profile = sketch("top", () => {
    line([-30, 0], [30, 0])
  })

const spine = sketch("front", () => {
    const l = line([0, 0], [0, 100]);
    const a1 = arc([0, 100], [-100, 100], [-50, 100]);
    coincident(l.end(), a1.start());
    vertical(l);
    tangent(l, a1);
    fix(l.start());
    radius(a1, 50);
  })

// highlight-next-line
sweep(spine, profile).thin(5).new()
