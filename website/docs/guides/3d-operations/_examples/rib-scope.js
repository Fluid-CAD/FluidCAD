// @screenshot waitForInput
import { sketch, move, rect, extrude, shell, rib, fillet, aLine, circle } from 'fluidcad/core';

sketch("top", () => {
    rect(100, 50).centered();
})

const box = extrude(30)
const sh = shell(-4, box.endFaces())
fillet(2, sh.internalEdges())

sketch("top", () => {
    circle(30)
});

const s = extrude(50).draft(-5)

sketch("front", () => {
    move([-40, 20])
    aLine(45, 20)
});

rib(5).parallel().extend().new().scope(s).draft(-4);
