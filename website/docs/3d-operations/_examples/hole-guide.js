// @screenshot view iso-ftr hideDimensions hidePositional
import { sketch, line, extrude, hole } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// The same 80 × 50 × 10 mounting plate.
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

// A 60 × 30 construction rectangle on the top face lays out the holes.
// Guides never become a profile, and they stay drawn over the model
// while the sketch is shown, so their corners can be clicked.
const layout = sketch(plate.endFaces(), () => {
    const b = line([-30, -15], [30, -15]).guide();
    const r = line([30, -15], [30, 15]).guide();
    const t = line([30, 15], [-30, 15]).guide();
    const l = line([-30, 15], [-30, -15]).guide();
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-30, -15]);
    distance(b.start(), b.end(), 60);
    distance(r.start(), r.end(), 30);
    return { b, t };
});

// An M5 clearance hole on each corner: both ends of the bottom and top lines.
hole('M5',
    layout.geometries.b.start(), layout.geometries.b.end(),
    layout.geometries.t.start(), layout.geometries.t.end());
