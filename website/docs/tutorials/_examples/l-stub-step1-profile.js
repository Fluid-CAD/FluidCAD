// @screenshot waitForInput
import { enclosing } from "fluidcad/constraints";
import { aLine, back, circle, cut, extrude, fillet, fuse, hLine, hMove, intersect, line, mirror, move, rect, sketch, slot, subtract, tLine, vLine, vMove } from "fluidcad/core";

sketch("top", () => {
    const s = slot(82, 26);
    const f = fuse(circle(24).name("Hole"),
        rect(-30, 8).centered('vertical').name("Slot Cut"));
}).name("Base Sketch");
