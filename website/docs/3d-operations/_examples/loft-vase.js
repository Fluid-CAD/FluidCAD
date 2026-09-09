// @screenshot view iso-ftr
import { sketch, plane, loft, circle } from 'fluidcad/core';
import { diameter, fix } from "fluidcad/constraints";

// Four round sections on planes 40 apart, each fully constrained. Only the
// diameter changes from one to the next: a Ø60 foot, a Ø100 belly, a Ø44 neck
// and a Ø70 lip.
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

const neck = sketch(plane("xy", { offset: 80 }), () => {
    const c = circle([0, 0], 44);
    fix(c.center(), [0, 0]);
    diameter(c, 44);
  })

const lip = sketch(plane("xy", { offset: 120 }), () => {
    const c = circle([0, 0], 70);
    fix(c.center(), [0, 0]);
    diameter(c, 70);
  })

// The surface passes through the four sections in the order they are listed,
// swelling out to the belly, pinching in at the neck and flaring at the lip.
// highlight-next-line
loft(foot, belly, neck, lip);
