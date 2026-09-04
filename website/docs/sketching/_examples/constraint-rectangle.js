import { sketch, line } from 'fluidcad/core';
import { coincident, horizontal, vertical, fix, distance } from "fluidcad/constraints";

sketch("xy", () => {
    // The guesses are rough on purpose — the constraints do the work.
    const b = line([1, -2], [99, 3]);
    const r = line([99, 3], [101, 52]);
    const t = line([101, 52], [-2, 48]);
    const l = line([-2, 48], [1, -2]);
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
    distance(r.start(), r.end(), 50);
})
