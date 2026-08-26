// @screenshot waitForInput
import { arc, circle, cut, extrude, fillet, line, mirror, plane, project,
    repeat, sketch, xAxis } from "fluidcad/core";
import { coincident, collinear, concentric, diameter, distance, equal, fix,
    horizontal, radius, tangent, vertical } from "fluidcad/constraints";
import { edge } from "fluidcad/filters";

sketch("top", () => {
    const bottom = line([-60, -33], [60, -33]);
    const right = line([60, -33], [60, 33]);
    const top = line([60, 33], [-60, 33]);
    const left = line([-60, 33], [-60, -33]);

    coincident(bottom.end(), right.start());
    coincident(right.end(), top.start());
    coincident(top.end(), left.start());
    coincident(left.end(), bottom.start());
    horizontal(bottom);
    vertical(right);
    horizontal(top);
    vertical(left);
    fix(bottom.start(), [-60, -33]);
    distance(bottom.start(), bottom.end(), 120);
    distance(right.start(), right.end(), 66);

    fillet(13, bottom, right, top, left);
})
let e = extrude(13)
