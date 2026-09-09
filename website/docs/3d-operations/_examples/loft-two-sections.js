// @screenshot view iso-ftr
import { sketch, plane, loft, circle } from 'fluidcad/core';
import { diameter, fix } from "fluidcad/constraints";

// Only the vase's foot and lip, 120 apart.
const foot = sketch("xy", () => {
    const c = circle([0, 0], 60);
    fix(c.center(), [0, 0]);
    diameter(c, 60);
  })

const lip = sketch(plane("xy", { offset: 120 }), () => {
    const c = circle([0, 0], 70);
    fix(c.center(), [0, 0]);
    diameter(c, 70);
  })

// Two sections: the surface runs straight from one to the other — a tube
// that tapers gently from Ø60 to Ø70.
// highlight-next-line
loft(foot, lip);
