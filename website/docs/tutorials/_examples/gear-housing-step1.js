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
