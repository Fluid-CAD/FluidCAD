// @screenshot view iso-ftr
import { sketch, plane, loft, circle } from 'fluidcad/core';
import { diameter, fix } from "fluidcad/constraints";

// The foot and lip again, with the Ø100 belly between them.
const foot = sketch("xy", () => {
    const c = circle([0, 0], 60);
    fix(c.center(), [0, 0]);
    diameter(c, 60);
  })

const belly = sketch(plane("xy", { offset: 40 }), () => {
    const c = circle([0, 0], 100);
    fix(c.center(), [0, 0]);
    diameter(c, 100);
  })

const lip = sketch(plane("xy", { offset: 120 }), () => {
    const c = circle([0, 0], 70);
    fix(c.center(), [0, 0]);
    diameter(c, 70);
  })

// Three sections: the surface now has to pass through the belly on its way
// up, so the tube swells out in the middle.
// highlight-next-line
loft(foot, belly, lip);
