// @screenshot hideGrid
import { sketch, circle, sphere, plane, project } from 'fluidcad/core';

const ball = sphere(30);

// A ring drawn on a plane above the ball.
const ring = sketch(plane('xy', 50), () => {
  circle([0, 0], 30);
});

// Outside a sketch: the ring dropped onto the ball along the sketch's
// normal, one closed curve on its top.
const pc = project(ring, ball);
