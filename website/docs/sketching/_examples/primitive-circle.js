import { sketch, circle, origin } from 'fluidcad/core';
import { coincident, concentric, diameter } from "fluidcad/constraints";

sketch("xy", () => {
    // A washer: an outer circle and the bore inside it. The inner loop
    // becomes a hole when the sketch is extruded.
    // circle(center, diameter) — the number is the diameter, not the radius.
    const outer = circle([0, 0], 50);
    const bore = circle([3, -2], 22);
    // Centre the washer on the origin and put the bore on the same centre;
    // the bore's guessed centre is off on purpose — the constraint fixes it.
    coincident(outer.center(), origin());
    concentric(bore, outer);
    diameter(outer, 50);
    diameter(bore, 22);
})
