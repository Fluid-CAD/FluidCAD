// @screenshot view iso-ftr hidePositional
import { sketch, line, point, extrude, hole } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// A base block, 40 × 15 and 20 thick: the solid the screw threads into.
// Both blocks here are the rear half of a joint: their front face runs
// through the hole axis, so the picture shows the two bores in section.
sketch("xy", () => {
    const b = line([-20, 0], [20, 0]);
    const r = line([20, 0], [20, 15]);
    const t = line([20, 15], [-20, 15]);
    const l = line([-20, 15], [-20, 0]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-20, 0]);
    distance(b.start(), b.end(), 40);
    distance(r.start(), r.end(), 15);
});
const base = extrude(20);

// An 8 mm cover on top of the base. `.new()` keeps it a solid of its own.
sketch(base.endFaces(), () => {
    const b = line([-20, 0], [20, 0]);
    const r = line([20, 0], [20, 15]);
    const t = line([20, 15], [-20, 15]);
    const l = line([-20, 15], [-20, 0]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-20, 0]);
    distance(b.start(), b.end(), 40);
    distance(r.start(), r.end(), 15);
});
const cover = extrude(8).new();

// One point on the cover's top face marks the screw.
const seat = sketch(cover.endFaces(), () => {
    const p = point([0, 0]);
    fix(p, [0, 0]);
    return { p };
});

// One statement, two holes. The cover takes the M6 clearance hole (Ø6.6).
// The base under it, the next solid along the hole axis, takes the M6
// tapped hole: Ø5, the tap drill for M6 × 1, through the whole block.
hole('M6', seat.geometries.p).fasten();
