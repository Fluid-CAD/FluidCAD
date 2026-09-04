// @screenshot showAxes
import { sketch, circle, extrude, plane } from 'fluidcad/core';

// A straight pipe along X: a ring profile on the YZ plane, extruded 100.
sketch("yz", () => {
    circle([0, 0], 30);   // outer wall
    circle([0, 0], 22);   // bore — an inner closed profile is a hole
});
const pipe = extrude(100);

// highlight-start
// A plane at the pipe's far end, square to it — the Plane dialog's From edge
// type with the pipe's seam edge as Base and the position 'end' (1). At 'end'
// the normal follows the edge's forward direction, so "up" from this plane is
// out of the pipe.
const endFace = plane(pipe.sideEdges(0), 'end');
// highlight-end

// A flange drawn on that plane: [0, 0] is the plane origin, on the seam, so
// the flange is centred on the pipe axis with an explicit centre.
sketch(endFace, () => {
    circle([0, 0], 70);   // flange outer diameter
    circle([0, 0], 22);   // keep the bore open
});
extrude(8);
