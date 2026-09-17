import { circle, cut, extrude, fillet, line, origin, plane, repeat, rib, select, shell, sketch, unit } from 'fluidcad/core';
import { coincident, diameter, distance, fix, horizontal, midpoint, vertical } from 'fluidcad/constraints';
import { edge, face } from 'fluidcad/filters';

unit('in');

// Centered Rectangle: W 7, H 5, on the rim plane.
const rimPlane = plane('xy', 1.5);
sketch(rimPlane, () => {
  const l1 = line([-3.5, -2.5], [3.5, -2.5]);
  const l2 = line([3.5, -2.5], [3.5, 2.5]);
  const l3 = line([3.5, 2.5], [-3.5, 2.5]);
  const l4 = line([-3.5, 2.5], [-3.5, -2.5]);
  coincident(l1.end(), l2.start());
  coincident(l2.end(), l3.start());
  coincident(l3.end(), l4.start());
  coincident(l4.end(), l1.start());
  horizontal(l1);
  horizontal(l3);
  vertical(l2);
  vertical(l4);
  distance(l1.start(), l1.end(), 7);
  distance(l2.start(), l2.end(), 5);
  midpoint(origin(), l1.start(), l3.start());
});

const base = extrude(-1.5).draft(-8);

fillet(0.75, base.sideEdges());
fillet(0.5, select(edge().parallelTo('xz').onPlane('xy').nearest('y').withTangents()));
