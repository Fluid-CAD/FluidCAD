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

cut(26).thin(50);

select(edge().verticalTo("top").line(26))
chamfer(28);

select(face().cylinderCurve(34 * 2).withTangents());
shell(-10)

sketch(topPlane, () => {
    circle([0, 0], 80)
});

extrude(-20)

const faceSelection = select(face().onPlane("xy", 16)).reusable()
sketch(faceSelection, () => {
    move([0, 0])
    project(faceSelection)
    vLine(60, true)
    split()
    trim(edge().above("yz"))
    circle([0, 0], 50)
});

remove(faceSelection);

extrude(16)
