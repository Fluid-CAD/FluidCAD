import { arc, chamfer, circle, copy, cut, extrude, fillet, hMove, mirror, move, plane, pMove, rect, repeat, sketch, vMove } from "fluidcad/core";

let supportWidth = (150 - 63) / 2;
let supportThickness = 12;

sketch("xy", () => {
    hMove(63 / 2)
    rect(supportWidth, 115).centered('vertical')
});

const e1 = extrude(supportThickness);

fillet(12, e1.sideEdges(2, 3));

chamfer(8, 90 - 25, true, e1.endEdges())

sketch("top", () => {
    rect(116, 77).centered();
});

const e2 = extrude(130);
const rightPlane = plane(e1.sideFaces(2))

sketch(e2.endFaces(), () => {
    rect(116, 68).centered();
});

const e3 = extrude(168 - 130);

chamfer(8, e3.endEdges());

const p1 = plane("xy");
sketch(p1, () => {
    rect(100, 62).centered();
});

cut(-158).draft(-3)

sketch(rightPlane, () => {
    move([0, 0]);
    vMove(16)
    vMove(-4)
    rect(20, 4).centered('horizontal')
    vMove(4)
    arc(10, 0, 180)
});

extrude(-40 / 2)
sketch(rightPlane, () => {
    move([0, 0]);
    vMove(16)
    circle(9);
});

cut();

sketch(e3.sideFaces(0), () => {
    const rect1Width = 77;
    const offset = 90;
    const rect1Height = 130 - offset;
    move([-rect1Width / 2, offset]);

    rect(rect1Width, rect1Height).radius(8, 8, 0, 0)

    const leftOffset = (rect1Width - 68) / 2;

    hMove(-rect1Width + leftOffset);

    const rect2Width = 68;
    const rect2Height = 152 - 130;

    rect(rect2Width, rect2Height).radius(0, 0, 8, 8)
});

const e5 = extrude((128 - 116)/2).drill(false)
mirror("yz")

sketch(e5.endFaces(), () => {
    move([0, 122])
    circle(42);
});

cut()

sketch(e5.endFaces(), () => {
    move([0, 122])
    circle(54);
});

const counterbore = cut(10);
repeat("mirror", "yz", counterbore);

sketch(e2.sideFaces(3), () => {
    circle(122)
});

const e6 = extrude(11/2)

sketch(e6.endFaces(), () => {
    hMove(116 / 2);
    rect(5, 40).centered('vertical')
});

const c2 = cut()
repeat("mirror", "yz", c2);

sketch(e6.endFaces(), () => {

    pMove(103 / 2, 45)
    circle(9)

    copy('circular', [0, 65], {
        count: 4,
        angle: 360
    });

    circle(85)
});
