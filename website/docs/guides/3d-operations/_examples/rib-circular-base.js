// @screenshot waitForInput
import { sketch, move, extrude, shell, rib, fillet, aLine, circle } from 'fluidcad/core';

sketch("top", () => {
    circle(80)
})

const box = extrude(30)
const sh = shell(-4, box.endFaces())
const s = fillet(2, sh.internalEdges())

sketch("front", () => {
    move([-40, 20])
    aLine(-45, 20)
});

rib(5).parallel().extend().draft(3).new().scope(s);
