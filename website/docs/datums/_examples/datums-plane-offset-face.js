// @screenshot showAxes framePlanes view iso-ftr
import { sketch, line, extrude, plane } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// A 120 × 80 × 60 block, drawn with the Rectangle tool and extruded.
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
// The block's top face, shifted 20 along its normal — Offset type with the
// face clicked as Base and a Distance of 20. The plane is centred on the
// face and moves with it if the block changes height.
const above = plane(block.endFaces(), 20);
// highlight-end
