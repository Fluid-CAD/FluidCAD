// @screenshot waitForInput
import { plane, sketch, extrude, fillet, rect, chamfer, move, repeat, rotate, arc, shell, polygon, offset, aLine, rib, revolve } from 'fluidcad/core';

sketch("top", () => {
    polygon(8, 140, 'circumscribed')
    rotate(45 / 2)
    fillet(20)
});

const outer = extrude(110);

chamfer(8, outer.startEdges())

shell(-5, outer.endFaces())

sketch("top", () => {
    rect(50).centered();
    offset(-5);
});

extrude(160);

const p = plane("front", { rotateY: 45 })

sketch(p, () => {
    move([(-140 / 2) + 5, 110]);
    aLine(45, 20)
});

rib(5).parallel().extend();

repeat("circular", "z", {
    count: 4,
    angle: 360
})

sketch("front", () => {
    arc(140, 0, 90)
});
