import { sketch, line, arc } from 'fluidcad/core';
import { coincident, tangent, horizontal, fix, radius, distance } from "fluidcad/constraints";

sketch("xy", () => {
    const l = line([0, 0], [48, 2]);
    const a = arc([48, 2], [70, 25], [50, 22]);
    coincident(l.end(), a.start());
    tangent(l, a);
    horizontal(l);
    fix(l.start());
    distance(l.start(), l.end(), 50);
    radius(a, 20);
})
