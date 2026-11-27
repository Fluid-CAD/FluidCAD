// @screenshot hideGrid
import { sketch, extrude, chamfer, select, circle, intersect, plane, sweep } from 'fluidcad/core';
import { rect } from 'fluidcad/shapes';
import { edge, face } from 'fluidcad/filters';

sketch('xy', () => {
  rect([0, 0], 60, 40).centered();
});
const block = extrude(30);
chamfer(20, select(edge().onPlane(block.endFaces()).farthest('x')));

sketch('xy', () => {
  circle([20, 0], 16);
});
const pipe = extrude(50).new();

const seam = intersect(pipe.sideFaces(), select(face().facing([1, 0, 1], 10)));

// A Ø4 circle on a plane square to the curve at its start...
// highlight-start
const bead = sketch(plane(seam.edges(0), 'start'), () => {
  circle([0, 0], 4);
});
// ...swept once around it: a bead where the pipe meets the slope. The sweep
// hides the curve, which later statements can still read.
sweep(seam, bead).new();
// highlight-end
