import {breakpoint, connector, extrude, origin, circle, sketch, part, color } from 'fluidcad/core';
import { diameter, coincident } from 'fluidcad/constraints';

export const pistonRing = part('piston-ring', () => {
  sketch('xy', () => {
    const c1 = circle([0, 0], 85);
    const c2 = circle([0, 0], 79);
    coincident(c1.center(), origin());
    diameter(c1, 85);
    coincident(c2.center(), origin());
    diameter(c2, 79);

  });
  const e = extrude(4.3);

  color('#4f565f');
  connector('c1', e.internalFaces().center());

});
