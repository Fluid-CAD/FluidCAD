// @screenshot hideGrid
import { sketch, circle, extrude, plane, line, project } from 'fluidcad/core';

sketch('yz', () => {
  circle([0, 20], 30);
});
const tube = extrude(60).new();

const bar = sketch(plane('xy', 60), () => {
  line([30, -30], [30, 30]);
});

// .keep('all') keeps every image: the half underneath too, so the line
// lands as a full circle round the tube.
// highlight-next-line
const ring = project(bar, tube).keep('all');
