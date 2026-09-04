// @screenshot view top
import { sketch, line, circle } from 'fluidcad/core';
import { coincident, horizontal, vertical, fix, distance, diameter } from "fluidcad/constraints";

sketch("xy", () => {
    // A plate drawn slightly askew, squared up by the constraints.
    const bottom = line([0, 0], [90, 4]);
    const right = line([90, 4], [88, 40]);
    const top = line([88, 40], [-2, 36]);
    const left = line([-2, 36], [0, 0]);
    coincident(bottom.end(), right.start());
    coincident(right.end(), top.start());
    coincident(top.end(), left.start());
    coincident(left.end(), bottom.start());
    // highlight-start
    horizontal(bottom);               // line form: the edge becomes horizontal
    horizontal(top);
    // highlight-end
    vertical(left);
    vertical(right);
    fix(bottom.start());
    distance(bottom.start(), bottom.end(), 90);
    distance(left.start(), left.end(), 40);
    // A row of three holes drawn at slightly different heights. The
    // point form aligns every center after the first with the first.
    const h1 = circle([20, 22], 8);
    const h2 = circle([45, 18], 8);
    const h3 = circle([70, 24], 8);
    // highlight-next-line
    horizontal(h1.center(), h2.center(), h3.center());
    diameter(h1, 8);
    diameter(h2, 8);
    diameter(h3, 8);
    distance(left, h1.center(), 20);
    distance(bottom, h1.center(), 20);
    distance(h1.center(), h2.center(), 25);
    distance(h2.center(), h3.center(), 25);
})
