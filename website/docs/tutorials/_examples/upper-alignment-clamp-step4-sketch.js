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

const circleExtrude = extrude(66).symmetric();
cut(66, circle(36, "front")).symmetric();

const p = plane("front", { offset: 20 })

sketch(p, () => {
    const arc = project(circleExtrude.endEdges(1)).guide()
    vMove(45)
    const c = circle(16).guide()
    const l1 = tLine(outside(arc), outside(c))
    const l2 = tLine(enclosing(arc), enclosing(c))
    tArc(l1.end())
    tArc(l1.start(), l2.start(), l1.tangent())
});
