// @screenshot view iso-ftr extent 1100x1500
import { sketch, sweep } from 'fluidcad/core';
import { circle, line } from 'fluidcad/core';
import { coincident, vertical, horizontal, fix } from 'fluidcad/constraints';

const profile = sketch("top", () => {
    circle([0, 0], 40);
  })

const spine = sketch("front", () => {
    const up = line([0, 0], [0, 100]);
    const across = line([0, 100], [100, 100]);
    coincident(up.end(), across.start());
    vertical(up);
    horizontal(across);
    fix(up.start());
  })

// highlight-next-line
sweep(spine, profile)
