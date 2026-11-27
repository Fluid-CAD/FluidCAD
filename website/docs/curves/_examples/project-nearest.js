// @screenshot hideGrid
import { sketch, circle, extrude, plane, line, project } from 'fluidcad/core';

// A tube lying along X.
sketch('yz', () => {
  circle([0, 20], 30);
});
const tube = extrude(60).new();

// A line drawn across it, above it.
const bar = sketch(plane('xy', 60), () => {
  line([30, -30], [30, 30]);
});

// Projected straight down onto the whole tube. The line through each point
// of the source meets the tube twice, on top and underneath; Nearest, the
// default, keeps the top half, the side facing the line.
// highlight-next-line
const top = project(bar, tube);
