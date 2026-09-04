import { sketch, circle, extrude, common, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// A drive peg with four flats: the volume a round shaft and a square bar have
// in common — a square section whose corners are turned off to the shaft's
// diameter.
sketch("xy", () => {
    const b = line([-20, -20], [20, -20]);
    const r = line([20, -20], [20, 20]);
    const t = line([20, 20], [-20, 20]);
    const l = line([-20, 20], [-20, -20]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-20, -20]);
    distance(b.start(), b.end(), 40);
    distance(r.start(), r.end(), 40);
});
const bar = extrude(60);

// The round shaft, a separate body of the same height.
sketch("xy", () => { circle([0, 0], 50); });
const shaft = extrude(60).new();

// highlight-start
// The Boolean dialog's Common tab: only the volume inside BOTH solids stays.
common(bar, shaft);
// highlight-end
