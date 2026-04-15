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
