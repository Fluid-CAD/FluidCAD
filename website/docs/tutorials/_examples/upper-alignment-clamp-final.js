import { aLine, arc, circle, color, connect, copy, cut, extrude, fillet, fuse, hLine, hMove, mirror, move, plane, project, rect, remove, repeat, rotate, select, shell, sketch, slot, tArc, tLine, vMove, wire } from "fluidcad/core";
import { enclosed, enclosing, outside } from "fluidcad/constraints";
import { edge, face } from "fluidcad/filters";

rect(120, 66, "top").centered().radius(13)
let e = extrude(13)

sketch(e.endFaces(), () => {
    hMove(120 / 2 - 10)
    rect(10, 14).centered('vertical')
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

extrude(11)

sketch(plane("front", { offset: 35 }), () => {
    move([0, 45])
    circle(16)
    circle(10);
});

const pipeLength = -35 + 20;
const e2 = extrude(pipeLength).drill(false);

cut(-pipeLength, circle(10, e2.startFaces()));

mirror("front")

sketch(e.endFaces(), () => {
    const center = [120 / 2 - 13, -66 / 2 + 13];
    move(center)
    circle(7);
    mirror("x")
    mirror("y")
}).name('Hole Sketch');

cut().name('Hole')

sketch(e.endFaces(), () => {
    move([120/2-13, -66/2+13])
    circle(15)
    mirror("x")
    mirror("y")
}).name('Counterbore Sketch');

cut(4).name('Counterbore')

select(face());
color('#4b8f4b')
