// @screenshot view iso-ftr
import { part, sketch, line, circle, extrude, cut, repeat, fillet, plane, connector } from 'fluidcad/core';
import { coincident, horizontal, vertical, distance, diameter, fix, concentric } from 'fluidcad/constraints';
import { edge } from 'fluidcad/filters';

// The swing leaf mirrors the fixed leaf: it grows to -X from the pin axis,
// and its two knuckles fill the gaps between the fixed leaf's three.
export const swingLeaf = part('Swing leaf', () => {
  sketch('xy', () => {
    const b = line([-30, 0], [0, 0]);
    const r = line([0, 0], [0, 60]);
    const t = line([0, 60], [-30, 60]);
    const l = line([-30, 60], [-30, 0]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(r.start(), [0, 0]);
    distance(b.start(), b.end(), 30);
    distance(r.start(), r.end(), 60);
  });
  const leaf = extrude(3);

  sketch(leaf.endFaces(), () => {
    const hole = circle([-18, 10], 4);
    diameter(hole, 4);
    fix(hole.center(), [-18, 10]);
  });
  const hole = cut();
  repeat('linear', 'y', { count: 3, offset: 20 }, hole);

  fillet(4, leaf.sideEdges(edge().onPlane('yz', -30)));

  // The first knuckle starts 12 mm in, so the ring is sketched on a plane
  // offset from the front plane (Plane dialog: Offset, base "front", 12 —
  // the front plane's normal points to -Y, hence the sign).
  sketch(plane('xz', { offset: -12 }), () => {
    const outer = circle([0, 4], 8);
    const bore = circle([0, 4], 4);
    diameter(outer, 8);
    diameter(bore, 4);
    concentric(outer, bore);
    fix(outer.center(), [0, 4]);
  });
  const knuckle = extrude(-12);
  repeat('linear', 'y', { count: 2, offset: 24 }, knuckle);

  // One connector, at the start of the first knuckle: the same point on the
  // pin axis as the fixed leaf's 'knuckle' connector.
  connector('knuckle', knuckle.startEdges(edge().notLine()).center());
});
