// @screenshot hideGrid
import { sketch, circle, extrude, helix, project } from 'fluidcad/core';

sketch('xy', () => {
  circle([0, 0], 40);
});
const shaft = extrude(60);

// A helix inside the shaft, around its axis.
const h = helix('z').radius(10).pitch(8).height(40);

// Normal to surface: each point goes to the closest point of the shaft's
// wall, giving a helix of the same pitch on its surface. A helix lies in no
// plane, so along a direction it would need a .direction().
// highlight-next-line
const groove = project(h, shaft.sideFaces()).mode('normal');
