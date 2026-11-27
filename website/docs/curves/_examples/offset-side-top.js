// @screenshot hideGrid
import { sketch, extrude, offset } from 'fluidcad/core';
import { rect } from 'fluidcad/shapes';

sketch('xy', () => {
  rect([0, 0], 60, 40).centered();
});
const box = extrude(30);

// The top face and the side faces together: each top edge now has a face
// on both sides, so the side follows the edges' direction. They run
// counter-clockwise seen from above, and standing on the top face a
// positive distance is to their left: inward, a loop 4 in from the rim.
// highlight-next-line
const inset = offset(4, box.endEdges(), { on: [box.endFaces(), box.sideFaces()] });
