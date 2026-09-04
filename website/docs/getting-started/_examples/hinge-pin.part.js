// @screenshot view iso-ftr
import { part, sketch, circle, extrude, chamfer, connector } from 'fluidcad/core';
import { diameter, fix } from 'fluidcad/constraints';

// A 4 mm pin, 60 mm long, with a small head. Drawn on the same axis as the
// knuckles (x = 0, z = 4) so it drops straight into the hinge.
export const pin = part('Pin', () => {
  sketch('xz', () => {
    const c = circle([0, 4], 4);
    diameter(c, 4);
    fix(c.center(), [0, 4]);
  });
  const shaft = extrude(-60);
  // a lead-in chamfer on the far end
  chamfer(0.5, shaft.endEdges());

  sketch('xz', () => {
    const c = circle([0, 4], 7);
    diameter(c, 7);
    fix(c.center(), [0, 4]);
  });
  const head = extrude(1.5);

  // The mate frame: where the head meets the shaft, Z along the pin.
  connector('shaft', head.startEdges().center());
});
