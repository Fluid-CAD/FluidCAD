// @screenshot hideGrid
import { sketch, circle, extrude, offset } from 'fluidcad/core';

sketch('xy', () => {
  circle([0, 0], 40);
});
const body = extrude(20);

// Outside a sketch, with { on }: a curve 3 below the top rim, on the side
// wall. From a rim, a positive distance goes onto the faces.
const band = offset(3, body.endEdges(), { on: body.sideFaces() });
