import { color, select, connector,part, chamfer,extrude, origin,circle, sketch } from 'fluidcad/core';
import {diameter, coincident } from 'fluidcad/constraints';
import { face } from 'fluidcad/filters';
export const pin = part('Pin', () => {
  sketch('xy', () => {
    const c1 = circle([0, 0], 33.8);
    coincident(c1.center(), origin());
    diameter(c1, 33.8);

  });
  const e = extrude(82);
  chamfer(2, e.endEdges(), e.startEdges());
  connector('c1', select(face().cylinder()).center());

  color('#5a616b');

}).name('Pin2');
