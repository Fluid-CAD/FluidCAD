import { sketch, line, arc } from 'fluidcad/core';
import { coincident, tangent, horizontal, fix, radius, distance } from "fluidcad/constraints";

sketch("xy", () => {
    const l = line([0, 0], [60, 0]);
    const a = arc([60, 0], [100, 40], [60, 40]);
    coincident(l.end(), a.start());
    tangent(l, a);
    horizontal(l);
    fix(l.start());
    distance(l.start(), l.end(), 60);
    radius(a, 40);
})
