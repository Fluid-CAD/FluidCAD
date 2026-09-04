// @screenshot view top
import { sketch, circle, origin } from 'fluidcad/core';
import { diameter, coincident, horizontal, distance } from "fluidcad/constraints";

sketch("xy", () => {
    // A flange: a bore on the origin and one bolt hole on the pitch
    // circle. Circles are dimensioned by diameter — the number a drawing
    // carries for a hole or a shaft.
    const bore = circle([0, 0], 28);
    coincident(bore.center(), origin());
    // highlight-next-line
    diameter(bore, 30);
    const bolt = circle([40, 0], 8);
    horizontal(bore.center(), bolt.center());
    distance(bore.center(), bolt.center(), 45);   // pitch radius
    // highlight-next-line
    diameter(bolt, 9);
})
