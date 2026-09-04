import { sketch, line, arc } from 'fluidcad/core';
import { coincident, tangent, vertical, horizontal, fix, radius, distance } from "fluidcad/constraints";

sketch("xy", () => {
    // A hook: a straight shank, a semicircular bend, and a short return.
    const shank = line([0, 0], [0, 60]);
    // arc(start, end, center): all three are guesses the solver reconciles.
    const bend = arc([0, 60], [40, 60], [20, 60]);
    const tip = line([40, 60], [40, 40]);
    // Join the pieces and make the bend leave the shank without a kink.
    coincident(shank.end(), bend.start());
    coincident(bend.end(), tip.start());
    tangent(shank, bend);
    tangent(bend, tip);
    vertical(shank);
    fix(shank.start(), [0, 0]);
    distance(shank.start(), shank.end(), 60);
    // The radius dimension is what sizes the bend; the centre guess only
    // picks which side it bulges to.
    radius(bend, 20);
    distance(tip.start(), tip.end(), 20);
})
