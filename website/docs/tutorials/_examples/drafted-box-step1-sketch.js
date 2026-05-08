// @screenshot waitForInput
import { circle, cut, extrude, fillet, hLine, move, plane, rect, repeat, rib, select, shell, sketch } from "fluidcad/core";
import { edge, face } from "fluidcad/filters";

sketch(plane("top", 1.50), () => {
    rect(7, 5).centered()
});
