import { arc, cut, extrude, fillet, intersect, line, origin, repeat, select, shell, sketch } from 'fluidcad/core';
import { coincident, distance, equal, horizontal, midpoint, radius, tangent, vertical } from 'fluidcad/constraints';
import { face } from 'fluidcad/filters';

// Centered rounded Rectangle: W 170, H 100, R 18.
sketch('xy', () => {
  const l1 = line([-67, -50], [67, -50]);
  const a1 = arc([67, -50], [85, -32], [67, -32]);
  const l2 = line([85, -32], [85, 32]);
  const a2 = arc([85, 32], [67, 50], [67, 32]);
  const l3 = line([67, 50], [-67, 50]);
  const a3 = arc([-67, 50], [-85, 32], [-67, 32]);
  const l4 = line([-85, 32], [-85, -32]);
  const a4 = arc([-85, -32], [-67, -50], [-67, -32]);
  coincident(l1.end(), a1.start());
  coincident(a1.end(), l2.start());
  coincident(l2.end(), a2.start());
  coincident(a2.end(), l3.start());
  coincident(l3.end(), a3.start());
  coincident(a3.end(), l4.start());
  coincident(l4.end(), a4.start());
  coincident(a4.end(), l1.start());
  tangent(l1, a1);
  tangent(a1, l2);
  tangent(l2, a2);
  tangent(a2, l3);
  tangent(l3, a3);
  tangent(a3, l4);
  tangent(l4, a4);
  tangent(a4, l1);
  horizontal(l1);
  horizontal(l3);
  vertical(l2);
  vertical(l4);
  equal(a1, a2);
  equal(a1, a3);
  equal(a1, a4);
  distance(l4, l2, 170);
  distance(l1, l3, 100);
  radius(a1, 18);
  midpoint(origin(), a4.center(), a2.center());
});

const e = extrude(23.6);

// Remove the top face, then round the inside.
const sh = shell(-5, e.endFaces());
fillet(8, sh.internalEdges());

// Intersect the side faces, rim and tangent interior; leave out the underside.
const rim = select(face().onPlane(e.endFaces()));
const interior = select(face().edgeCount(8).below(e.startFaces()).withTangents());
const sideProfile = sketch('yz', () => {
  intersect(e.sideFaces(), rim, interior);
});

const rim2 = select(face().onPlane(e.endFaces()));
const interior2 = select(face().edgeCount(8).below(e.startFaces()).withTangents());
sketch('xz', () => {
  intersect(e.sideFaces(), rim2, interior2);
});

// Positive thickness cuts into the material for these intersection profiles.
const grooveX = cut(3).symmetric().thin(1);
repeat('linear', 'y', { count: 3, offset: 25, centered: true }, grooveX);

const grooveY = cut(3, sideProfile).symmetric().thin(1);
repeat('linear', 'x', { count: 7, offset: 20, centered: true }, grooveY);
