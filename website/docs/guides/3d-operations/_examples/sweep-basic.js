import { sketch, sweep } from 'fluidcad/core';
import { circle, line, arc } from 'fluidcad/core';
import { coincident, vertical, tangent, radius, fix } from 'fluidcad/constraints';

const profile = sketch("top", () => {
    circle([0, 0], 40);
    circle([0, 0], 20);
  })

const spine = sketch("front", () => {
    const l = line([0, 0], [0, 100]);
    const a1 = arc([0, 100], [-100, 100], [-50, 100]);
    const a2 = arc([-100, 100], [-180, 180], [-180, 100]).cw();
    coincident(l.end(), a1.start());
    coincident(a1.end(), a2.start());
    vertical(l);
    tangent(l, a1);
    tangent(a1, a2);
    fix(l.start());
    radius(a1, 50);
    radius(a2, 80);
  })

sweep(spine, profile)
