// @screenshot waitForInput
import { aLine, back, circle, cut, extrude, fillet, hLine, line, local, mirror, plane, rect, remove, repeat, select, shell, sketch, vMove } from "fluidcad/core";
import { edge, face } from "fluidcad/filters";

sketch(plane("top", 1.50), () => {
    rect(7, 5).centered()
});
