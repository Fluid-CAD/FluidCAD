// @screenshot waitForInput
import { aLine, back, circle, cut, extrude, fillet, hLine, line, local, mirror, plane, rect, remove, repeat, select, shell, sketch, vMove } from "fluidcad/core";
import { edge, face } from "fluidcad/filters";

sketch(plane("top", 1.50), () => {
    rect(7, 5).centered()
});

const base = extrude(-1.5).draft(-8);

fillet(.750, base.sideEdges())
fillet(.50, select(edge().onPlane("top")))
