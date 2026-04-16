// @screenshot waitForInput
import { circle, cut, extrude, hMove, mirror, plane, rect, sketch, split, tArc, tLine, trim } from "fluidcad/core";
import { outside } from "fluidcad/constraints";

sketch("xy", () => {
    circle(42);
    const c2 = circle(70);
    hMove(50)
})
