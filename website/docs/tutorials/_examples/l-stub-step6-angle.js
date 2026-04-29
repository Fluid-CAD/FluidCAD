// @screenshot waitForInput
import { enclosing } from "fluidcad/constraints";
import { aLine, back, circle, cut, extrude, fillet, fuse, hLine, hMove, intersect, mirror, move, pMove, rect, sketch, slot, subtract, tLine, vLine, vMove } from "fluidcad/core";

sketch("top", () => {
    const s = slot(82, 26);
    const f = fuse(circle(24).name("Hole"),
        rect(-30, 8).centered('vertical').name("Slot Cut"));
    subtract(s, f)
}).name("Base Sketch");

const base = extrude(70).name("Base")

sketch(base.endFaces(), () => {
    circle([0, 0], 36)
}).name("Counterbore Sketch");

cut(13).name("Counterbore")

sketch("front", () => {
    vMove(24)
    const l = hLine(200).guide().centered()
    move([0, 70]);
    hMove(26);
    aLine(-90 + 20, l)
    hLine(100)
    fillet(18)
}).name("Split Sketch")

const c = cut().symmetric().thin(50).name("Split")

sketch("top", () => {
    hMove(82)
    const c1 = circle(26 * 2);
    move([70, 40])
    const c2 = circle(16 * 2)
    circle(10)

    tLine(enclosing(c1), enclosing(c2))

    move([70 - 16, 0])
    tLine(enclosing(c2))

    mirror("x").exclude(c1)
}).name("Flange Sketch");

const flange = extrude(12).name("Flange")

sketch(flange.endFaces(), () => {
    move([70, 40])
    circle(18)
    mirror("x")
}).name("Flange Counterbore Sketch");

cut(5).name("Counterbore");

sketch("front", () => {
    const thickness = 7;
    const i = intersect(c.internalFaces())

    move([82 + 26 - 30, 0])
    vMove(24 + thickness)
    const hl = hLine(100).guide().centered();
    back()
    const vl = vLine(30).centered();

    move([0, 70]);
    hMove(26)
    pMove(7, -90+20)
    aLine(-90, hl)
    hLine(vl)
}).name("Rib Sketch");
