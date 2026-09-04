import { sketch, line, point, circle } from 'fluidcad/core';
import { coincident, fix, horizontal, diameter } from "fluidcad/constraints";

sketch("xy", () => {
    // A link bar with a pivot hole exactly halfway along it. The bar is a
    // guide line; the point marks where the pivot goes.
    const bar = line([0, 0], [80, 0]).guide();
    horizontal(bar);
    fix(bar.start(), [0, 0]);
    fix(bar.end(), [80, 0]);
    // A standalone point: no edge, only something to constrain against.
    const pivot = point([30, 10]);
    // .mid() is accepted by coincident() only — it lowers to a midpoint.
    coincident(pivot, bar.mid());
    // The pivot hole rides the point.
    const hole = circle([30, 10], 12);
    coincident(hole.center(), pivot);
    diameter(hole, 12);
})
