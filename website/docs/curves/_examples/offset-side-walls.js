// @screenshot hideGrid
import { sketch, extrude, offset } from 'fluidcad/core';
import { rect } from 'fluidcad/shapes';

sketch('xy', () => {
  rect([0, 0], 60, 40).centered();
});
const box = extrude(30);

// The same edges and faces, the sign flipped: to the right of the edges,
// down the side faces, a loop 4 below the rim.
// highlight-next-line
const band = offset(-4, box.endEdges(), { on: [box.endFaces(), box.sideFaces()] });
