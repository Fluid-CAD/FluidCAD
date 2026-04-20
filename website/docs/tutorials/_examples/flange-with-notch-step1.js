// @screenshot waitForInput
import { circle, cut, extrude, hMove, mirror, plane, rect, remove, sketch, split, tArc, tLine, trim } from "fluidcad/core";
import { outside } from "fluidcad/constraints";

const baseSketch = sketch("xy", () => {
    circle(42).reusable();
    const c2 = circle(70).reusable();
    hMove(50)
})
