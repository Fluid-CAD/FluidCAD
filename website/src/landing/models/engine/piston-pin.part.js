import {breakpoint, select, connector, chamfer, extrude, origin, circle, sketch, part, color } from 'fluidcad/core';
import { diameter, coincident } from 'fluidcad/constraints';
import { face } from 'fluidcad/filters';

export const pistonPin = part('piston-pin', () => {
  sketch('xy', () => {
    const c1 = circle([0, 0], 33.8);
    coincident(c1.center(), origin());
    diameter(c1, 33.8);

  });
  const e = extrude(82);
  chamfer(2, e.endEdges(), e.startEdges());

  color('#5a616b');
  connector('c1', select(face().cylinder()).center());

});
