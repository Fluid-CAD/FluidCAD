// @screenshot view top hideDimensions
import { sketch, line, xAxis } from 'fluidcad/core';
import { perpendicular, coincident, fix, distance, angle } from "fluidcad/constraints";

sketch("xy", () => {
    // An L-bracket that bolts to a 20° incline. Its foot follows the
    // incline, so its corners must be square to the foot — not to the
    // sketch axes.
    const foot = line([0, 0], [90, 30]);
    const upright = line([90, 30], [72, 75]);
    const cap = line([72, 75], [64, 72]);
    const inner = line([64, 72], [79, 35]);
    const back = line([79, 35], [-2, 8]);
    const heel = line([-2, 8], [0, 0]);
    coincident(foot.end(), upright.start());
    coincident(upright.end(), cap.start());
    coincident(cap.end(), inner.start());
    coincident(inner.end(), back.start());
    coincident(back.end(), heel.start());
    coincident(heel.end(), foot.start());
    fix(foot.start());
    angle(xAxis(), foot, 20);              // the incline
    distance(foot.start(), foot.end(), 95);
    distance(upright.start(), upright.end(), 50);
    // highlight-start
    perpendicular(foot, upright);          // the bracket's corner
    perpendicular(foot, heel);             // the foot's end face
    perpendicular(upright, cap);           // the upright's end face
    perpendicular(heel, back);             // inner wall square to the heel …
    perpendicular(cap, inner);             // … and to the cap
    // highlight-end
    distance(foot, back, 8);               // leg thickness
    distance(upright, inner, 8);
})
