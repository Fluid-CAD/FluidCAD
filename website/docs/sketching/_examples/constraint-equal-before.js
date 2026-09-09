// @screenshot view top hideDimensions
import { sketch, circle, origin } from 'fluidcad/core';
import { equal, coincident, horizontal, distance, diameter } from "fluidcad/constraints";

sketch("xy", () => {
    // Two holes drawn at two different sizes.
    const h1 = circle([0, 0], 20);
    const h2 = circle([50, 0], 12);
    coincident(h1.center(), origin());
    horizontal(h1.center(), h2.center());
    distance(h1.center(), h2.center(), 50);
    // One diameter, shared: the second hole takes the first one's size.
    diameter(h1, 20);
})
