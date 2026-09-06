// @screenshot showAxes framePlanes view iso-ftr
import { sketch, line, extrude, plane } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// The same 120 × 80 × 60 block.
sketch("xy", () => {
    const b = line([-60, -40], [60, -40]);
    const r = line([60, -40], [60, 40]);
    const t = line([60, 40], [-60, 40]);
    const l = line([-60, 40], [-60, -40]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-60, -40]);
    distance(b.start(), b.end(), 120);
    distance(r.start(), r.end(), 80);
});
const block = extrude(60);

// highlight-start
// Halfway between the block's bottom and top faces — Mid plane type with the
// two faces clicked as Bases. Each face is wrapped in plane(…) so the mid
// plane reads two planes. Make the block taller and the plane stays centred.
const mid = plane(plane(block.startFaces()), plane(block.endFaces()));
// highlight-end
