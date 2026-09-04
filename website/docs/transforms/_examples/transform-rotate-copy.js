// @screenshot showAxes
import { sketch, circle, extrude, rotate, fuse, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// A wheel hub with four spokes: one spoke is modelled, the others are
// rotate-copies of it.
sketch("xy", () => { circle([0, 0], 30); });
const hub = extrude(10);

// One spoke, from the hub outwards along X, kept separate so it can be copied.
sketch("xy", () => {
    const b = line([12, -3], [70, -3]);
    const r = line([70, -3], [70, 3]);
    const t = line([70, 3], [12, 3]);
    const l = line([12, 3], [12, -3]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [12, -3]);
    distance(b.start(), b.end(), 58);
    distance(r.start(), r.end(), 6);
});
const spoke = extrude(10).new();

// highlight-start
// The Rotate dialog's Copy tab: the spoke stays and a turned copy is added
// each time. `true` is the copy flag; without it the spoke itself would move.
rotate("z", 90, true, spoke);
rotate("z", 180, true, spoke);
rotate("z", 270, true, spoke);
// highlight-end

// Merge hub and spokes into one wheel.
fuse();
