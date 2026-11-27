// @screenshot hideGrid
import { sketch, extrude, offset } from 'fluidcad/core';
import { rect } from 'fluidcad/shapes';

// A block 60 × 40, 30 tall.
sketch('xy', () => {
  rect([0, 0], 60, 40).centered();
});
const box = extrude(30);

// A loop 3 below the top rim, on the four side faces. The top edges are the
// rim of those faces — each edge has one of them beside it — so a positive
// distance goes onto the faces, down the walls. The edges and the faces are
// read, not used up: the block stays as it is.
// highlight-next-line
const band = offset(3, box.endEdges(), { on: box.sideFaces() });
