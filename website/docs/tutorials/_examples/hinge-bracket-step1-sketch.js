// @screenshot waitForInput
import { arc, chamfer, circle, cut, extrude, fillet, hLine, hMove, move, plane, project, remove, select, shell, sketch, split, trim, vLine } from "fluidcad/core";
import { edge, face } from "fluidcad/filters";

const spine = sketch("front", () => {
    hMove(-40)
    hLine(40)
    hLine(78);
    vLine(150);
    hLine(-78)
    hLine(-40)
    fillet(34)
}).reusable();
