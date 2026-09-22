// @screenshot view iso-ftr extent 1100x1500
import { sketch, sweep } from 'fluidcad/core';
import { circle, line, arc } from 'fluidcad/core';
import { coincident, vertical, horizontal, tangent, radius, fix } from 'fluidcad/constraints';

const profile = sketch("top", () => {
    circle([0, 0], 40);
  })

const spine = sketch("front", () => {
    const up = line([0, 0], [0, 70]);
    const bend = arc([0, 70], [-30, 100], [-30, 70]);
    const across = line([-30, 100], [-100, 100]);
    coincident(up.end(), bend.start());
    coincident(bend.end(), across.start());
    vertical(up);
    horizontal(across);
    tangent(up, bend);
    tangent(bend, across);
    radius(bend, 30);
    fix(up.start());
  })

// highlight-next-line
sweep(spine, profile)
