// @screenshot view iso-ftr
import { sketch, extrude, loft, plane, circle, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

// The base part every column shares: a 100 x 100 x 12 tank lid.
sketch("xy", () => {
    const sg1 = line([-50, -50], [50, -50]);
    const sg2 = line([50, -50], [50, 50]);
    const sg3 = line([50, 50], [-50, 50]);
    const sg4 = line([-50, 50], [-50, -50]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-50, -50]);
    distance(sg1.start(), sg1.end(), 100);
    distance(sg2.start(), sg2.end(), 100);
  })
const lid = extrude(12)

// First profile: a Ø44 circle on a plane halfway through the lid (6 up).
const s1 = sketch(plane("xy", { offset: 6 }), () => {
    circle([0, 0], 44);
  })

// Second profile: a 16 x 16 square outlet, 50 up.
const s2 = sketch(plane("xy", { offset: 50 }), () => {
    const t1 = line([-8, -8], [8, -8]);
    const t2 = line([8, -8], [8, 8]);
    const t3 = line([8, 8], [-8, 8]);
    const t4 = line([-8, 8], [-8, -8]);
    coincident(t1.end(), t2.start());
    coincident(t2.end(), t3.start());
    coincident(t3.end(), t4.start());
    coincident(t4.end(), t1.start());
    horizontal(t1);
    vertical(t2);
    horizontal(t3);
    vertical(t4);
    fix(t1.start(), [-8, -8]);
    distance(t1.start(), t1.end(), 16);
    distance(t2.start(), t2.end(), 16);
  })

// New + Thin: the hopper wall as a separate body.
// highlight-next-line
loft(s1, s2).thin(2).new()
