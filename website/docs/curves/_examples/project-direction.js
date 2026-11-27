// @screenshot hideGrid
import { sketch, circle, extrude, plane, project } from 'fluidcad/core';

sketch('xy', () => {
  circle([0, 0], 80);
});
const disc = extrude(10);

// A circle on a plane tilted 30° about X.
const tilted = sketch(plane('xy', { offset: 40, rotateX: 30 }), () => {
  circle([0, 0], 30);
});

// Along the world Z axis instead of the tilted plane's normal: an ellipse
// on the disc's top face.
// highlight-next-line
const mark = project(tilted, disc.endFaces()).direction('z');
