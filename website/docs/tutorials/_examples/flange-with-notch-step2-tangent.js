// @screenshot waitForInput
import { arc, circle, cut, extrude, line, mirror, plane, remove, sketch, xAxis } from "fluidcad/core";
import { coincident, concentric, diameter, distance, equal, fix, horizontal, symmetric, tangent, vertical } from "fluidcad/constraints";

const baseSketch = sketch("xy", () => {
    const c1 = circle([0, 0], 42).reusable();
    const c2 = circle([0, 0], 70).reusable();
    const c3 = circle([50, 0], 10);
    const c4 = circle([50, 0], 32).guide();
    const l1 = line([13.3, 32.374527], [56.08, 14.799784]);

    fix(c1.center(), [0, 0]);
    concentric(c1, c2);
    diameter(c1, 42);
    diameter(c2, 70);
    fix(c3.center(), [50, 0]);
    concentric(c3, c4);
    diameter(c3, 10);
    diameter(c4, 32);
    tangent(l1, c2);
    tangent(l1, c4);
    coincident(l1.start(), c2);
    coincident(l1.end(), c4);

    const m = mirror("x", l1);
})
