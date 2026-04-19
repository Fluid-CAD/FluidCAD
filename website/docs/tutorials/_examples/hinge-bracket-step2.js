// @screenshot waitForInput
import { arc, chamfer, circle, cut, extrude, fillet, hLine, hMove, move, plane, project, remove, select, shell, sketch, trim, vLine } from "fluidcad/core";
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

let base = extrude(80).thin(26).symmetric();

const topPlane = plane(base.sideFaces(4))

sketch(topPlane, () => {
    move([0, 0])
    arc(40).centered();
    project(base.startEdges(1), base.endEdges(1), base.sideEdges(0, 1));
});

cut(26);
