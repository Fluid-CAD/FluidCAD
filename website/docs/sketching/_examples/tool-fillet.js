import { sketch, line, circle, fillet } from 'fluidcad/core';
import { coincident, horizontal, vertical, fix, distance, diameter } from 'fluidcad/constraints';

sketch("xy", () => {
    // A mounting plate, 100 × 60, with two screw holes.
    const b = line([0, 0], [100, 0]);
    const r = line([100, 0], [100, 60]);
    const t = line([100, 60], [0, 60]);
    const l = line([0, 60], [0, 0]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [0, 0]);
    distance(b.start(), b.end(), 100);
    distance(r.start(), r.end(), 60);
    const h1 = circle([20, 30], 8);
    const h2 = circle([80, 30], 8);
    diameter(h1, 8);
    diameter(h2, 8);
    // The derived form: one call rounds every corner the listed lines share.
    // The lines are trimmed and a tangent arc of radius 12 fills each corner.
    // highlight-next-line
    fillet(12, b, r, t, l)
})
