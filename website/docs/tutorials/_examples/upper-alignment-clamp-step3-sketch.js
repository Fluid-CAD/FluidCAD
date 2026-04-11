import { aLine, arc, circle, color, connect, copy, cut, extrude, fillet, fuse, hLine, hMove, mirror, move, plane, project, rect, remove, repeat, rotate, select, shell, sketch, slot, tArc, tLine, vMove, wire } from "fluidcad/core";
import { enclosed, enclosing, outside } from "fluidcad/constraints";
import { edge, face } from "fluidcad/filters";

rect(120, 66, "top").center().radius(13)
let e = extrude(13)

sketch(e.endFaces(), () => {
    hMove(120 / 2 - 10)
    rect(10, 14).center('vertical')
    circle(14)
});

const notch = cut()

repeat("mirror", "yz", notch);

sketch("front", () => {
    arc(31)
    connect()
    move([0, 0])
});
