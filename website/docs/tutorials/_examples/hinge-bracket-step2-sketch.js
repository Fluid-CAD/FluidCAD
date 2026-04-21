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

let base = extrude(80).thin(26).symmetric();

const topPlane = plane(base.sideFaces(4))

sketch(topPlane, () => {
    move([-2, 0])
    vLine(100, true).guide()
    move([0, 0])
    arc(40).centered();
});
