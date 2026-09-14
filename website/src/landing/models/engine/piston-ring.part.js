import {breakpoint, color, connector, extrude, origin, circle, sketch, part } from 'fluidcad/core';
import { diameter, coincident } from 'fluidcad/constraints';

export const pistonRing = part('Piston Ring', () => {
  sketch('xy', () => {
    const c1 = circle([0, 0], 85);
    const c2 = circle([0, 0], 79);
    coincident(c1.center(), origin());
    coincident(c2.center(), c1.center());
    diameter(c1, 85);
    diameter(c2, 79);

  });
  const e = extrude(4.3);
  // Underside frame with Z pointing up through the ring, so a fastened mate
  // onto a groove floor seats the ring on top of it.
  color('#4f565f');
  connector('c1', e.internalFaces().center());

}).name('Piston Ring');
