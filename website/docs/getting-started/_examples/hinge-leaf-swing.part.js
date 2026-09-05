// @screenshot view iso-ftr
import { origin, xAxis, yAxis, part, sketch, line, circle, extrude, cut, repeat, fillet, plane, connector } from 'fluidcad/core';
import { coincident, horizontal, vertical, midpoint, distance, diameter, fix } from 'fluidcad/constraints';
import { edge } from 'fluidcad/filters';

// The swing leaf mirrors the fixed leaf: it grows to -X from the pin axis,
// and its two knuckles fill the gaps between the fixed leaf's three.
export const swingLeaf = part('Swing leaf', () => {
  sketch('xy', () => {
    const b = line([-30, -28.96], [0, -28.96]);
    const r = line([0, -28.96], [0, 31.04]);
    const t = line([0, 31.04], [-30, 31.04]);
    const l = line([-30, 31.04], [-30, -28.96]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    distance(b.start(), b.end(), 30);
    distance(r.start(), r.end(), 60);
    // the right edge is on the pin axis, centred on the origin
    midpoint(origin(), r.start(), r.end());
  });
  const leaf = extrude(3);

  sketch(leaf.endFaces(), () => {
    const hole = circle([-22.92, -25.08], 4);
    diameter(hole, 4);
    distance(hole.center(), xAxis(), 20);
    distance(hole.center(), yAxis(), 20);
  });
  const hole = cut();
  repeat('linear', 'y', { count: 3, offset: 20 }, hole);

  fillet(4, leaf.sideEdges(edge().onPlane('yz', -30)));

  // The first knuckle fills the fixed leaf's front gap, 18 mm in front of
  // the origin, so the ring is sketched on a plane offset from the front
  // plane (Plane dialog: Offset, base "front", 18 — the front plane's
  // normal points to -Y, so a positive offset moves towards the viewer).
  sketch(plane('xz', { offset: 18 }), () => {
    const outer = circle([0, 4], 8);
    diameter(outer, 8);
    fix(outer.center(), [0, 4]);
  });
  const knuckle = extrude(-12);
  // Repeat dialog: the second knuckle 24 mm along, in the other gap.
  repeat('linear', 'y', { count: 2, offset: 24 }, knuckle);

  // The bore, cut Through all both ways from the front plane: it drills
  // both knuckles even though the plane itself sits in the gap between them.
  sketch('xz', () => {
    const bore = circle([0, 4], 4);
    diameter(bore, 4);
    fix(bore.center(), [0, 4]);
  });
  cut().symmetric();

  // One connector, at the far end of the first knuckle: the same point on
  // the pin axis as the fixed leaf's 'knuckle' connector.
  connector('knuckle', knuckle.endEdges(edge().notLine()).center());
});
