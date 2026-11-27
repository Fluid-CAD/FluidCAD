// @screenshot hideGrid
import { sketch, extrude, chamfer, select, circle, intersect } from 'fluidcad/core';
import { rect } from 'fluidcad/shapes';
import { edge, face } from 'fluidcad/filters';

// A block with its top edge on the +X side chamfered: the chamfer is a flat
// face sloping at 45°.
sketch('xy', () => {
  rect([0, 0], 60, 40).centered();
});
const block = extrude(30);
chamfer(20, select(edge().onPlane(block.endFaces()).farthest('x')));

// A pipe standing up through the slope, kept as a body of its own (.new()):
// the curve is taken between two bodies, not cut into one.
sketch('xy', () => {
  circle([20, 0], 16);
});
const pipe = extrude(50).new();

// The curve where the pipe's wall crosses the slope — an ellipse. The first
// argument is the wall; the second the sloped face, named here by the way
// it faces (up and out along +X). Neither body changes.
// highlight-next-line
const seam = intersect(pipe.sideFaces(), select(face().facing([1, 0, 1], 10)));
