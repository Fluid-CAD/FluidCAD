// @screenshot waitForInput hideGrid
import { arc, circle, cut, extrude, local, mirror, move, offset, plane, polygon, rect, sketch, vMove } from "fluidcad/core";

sketch("front", () => {
    arc(18)
    offset(-36 + 18).close()
    move([18, 0])
    const r = rect(18, -40)
    mirror(local("y"), r)
    move([0, 18])
    rect(36, 129 - 18).centered('horizontal')
});

extrude(36).symmetric();

sketch(plane("right", 18), () => {
    vMove(-(167 - 129))
    circle(60);
});

const distance = (80 - 36) / 2
const e = extrude(distance);

mirror("right")

sketch(e.endFaces(), () => {
    circle(30)
});

cut();
