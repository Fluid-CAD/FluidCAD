// @screenshot waitForInput
import { arc, axis, circle, copy, cut, extrude, fillet, line, project, remove,
    repeat, sketch, sweep } from "fluidcad/core";
import { coincident, concentric, diameter, distance, equal, fix, horizontal,
    radius, tangent, vertical } from "fluidcad/constraints";

const spine = sketch("front", () => {
    const riser = line([0, 0], [0, 1.5]);
    const bend = arc([0, 1.5], [1.171573, 4.328427], [4, 1.5]).cw();
    const topSegment = line([1.171573, 4.328427], [2.232233, 5.389087]);

    coincident(riser.end(), bend.start());
    coincident(bend.end(), topSegment.start());
    vertical(riser);
    tangent(riser, bend);
    tangent(bend, topSegment);
    fix(riser.start(), [0, 0]);
    distance(riser.start(), riser.end(), 1.5);
    radius(bend, 4);
    distance(topSegment.start(), topSegment.end(), 1.5);

    return {
        topSegment
    }
}).reusable();
