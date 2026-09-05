// @screenshot view top hideDimensions
import { sketch, line, arc, circle } from 'fluidcad/core';
import { equal, coincident, tangent, horizontal, vertical, fix, distance, radius, diameter } from "fluidcad/constraints";

sketch("xy", () => {
    // A cover plate with four rounded corners drawn at four different
    // radii, and two fixing holes drawn at two different sizes.
    const bottom = line([10, 0], [70, 0]);
    const c1 = arc([70, 0], [80, 10], [70, 10]);
    const right = line([80, 10], [80, 40]);
    const c2 = arc([80, 40], [72, 48], [72, 40]);
    const top = line([72, 48], [6, 48]);
    const c3 = arc([6, 48], [0, 42], [6, 42]);
    const left = line([0, 42], [0, 12]);
    const c4 = arc([0, 12], [12, 0], [12, 12]);
    coincident(bottom.end(), c1.start());
    coincident(c1.end(), right.start());
    coincident(right.end(), c2.start());
    coincident(c2.end(), top.start());
    coincident(top.end(), c3.start());
    coincident(c3.end(), left.start());
    coincident(left.end(), c4.start());
    coincident(c4.end(), bottom.start());
    tangent(bottom, c1);
    tangent(c1, right);
    tangent(right, c2);
    tangent(c2, top);
    tangent(top, c3);
    tangent(c3, left);
    tangent(left, c4);
    tangent(c4, bottom);
    horizontal(bottom);
    horizontal(top);
    vertical(left);
    vertical(right);
    fix(left.end(), [0, 8]);
    distance(left, right, 80);
    distance(bottom, top, 48);
    // One radius on the first corner; the other three take it.
    // highlight-next-line
    equal(c1, c2, c3, c4);
    radius(c1, 8);
    // Two holes: one diameter, shared.
    const h1 = circle([20, 24], 7);
    const h2 = circle([60, 24], 5);
    // highlight-next-line
    equal(h1, h2);
    diameter(h1, 6);
    horizontal(h1.center(), h2.center());
    distance(left, h1.center(), 20);
    distance(bottom, h1.center(), 24);
    distance(h1.center(), h2.center(), 40);
})
