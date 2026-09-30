// @screenshot view iso-ftr hidePositional
import { sketch, line, point, extrude, hole } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// An 80 × 50 × 10 mounting plate. The four points on its top face are
// where the holes go: a sketch point has no edge, it only marks a place.
sketch("xy", () => {
    const b = line([-40, -25], [40, -25]);
    const r = line([40, -25], [40, 25]);
    const t = line([40, 25], [-40, 25]);
    const l = line([-40, 25], [-40, -25]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-40, -25]);
    distance(b.start(), b.end(), 80);
    distance(r.start(), r.end(), 50);
});
const plate = extrude(10);

// Returning the points names them for statements outside the sketch:
// `holes.geometries.p1` is the first point.
const holes = sketch(plate.endFaces(), () => {
    const p1 = point([-30, -15]);
    const p2 = point([30, -15]);
    const p3 = point([30, 15]);
    const p4 = point([-30, 15]);
    fix(p1, [-30, -15]);
    fix(p2, [30, -15]);
    fix(p3, [30, 15]);
    fix(p4, [-30, 15]);
    return { p1, p2, p3, p4 };
});

// Drilled Ø8, blind: 6 deep to the shoulder, with a 118° drill point below.
hole(8, holes.geometries.p1, holes.geometries.p2, holes.geometries.p3, holes.geometries.p4)
    .depth(6, 118);
