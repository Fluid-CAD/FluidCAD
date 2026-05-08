// @screenshot waitForInput
import { plane, sketch, extrude, fillet, rect, chamfer, move, repeat, rotate, arc, shell, polygon, offset, aLine, rib, revolve } from 'fluidcad/core';

sketch("top", () => {
    polygon(8, 140, 'circumscribed')
    rotate(45 / 2)
    fillet(20)
});

const outer = extrude(110);
