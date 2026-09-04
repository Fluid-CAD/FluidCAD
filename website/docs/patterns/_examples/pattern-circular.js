import { sketch, circle, extrude, cut, repeat } from 'fluidcad/core';

// A pipe flange: a disc with a central bore and a bolt circle of six holes.
sketch("xy", () => {
    circle([0, 0], 120);   // flange outer diameter
    circle([0, 0], 40);    // the bore, a hole in the profile
});
const flange = extrude(12);

// One bolt hole on the bolt circle, radius 45.
sketch(flange.endFaces(), () => { circle([45, 0], 10); });
const bolt = cut();

// highlight-start
// Repeat the CUT six times around Z: one solid with six holes. copy() would
// instead clone the whole flange.
repeat("circular", "z", { count: 6, angle: 360 }, bolt);
// highlight-end
