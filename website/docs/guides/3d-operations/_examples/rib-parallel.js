// @screenshot waitForInput
import { sketch, move, rect, extrude, shell, rib, fillet, aLine } from 'fluidcad/core';

sketch("top", () => {
    rect(100, 50).centered();
})

const box = extrude(30)
const s = shell(-4, box.endFaces())
fillet(2, s.internalEdges())

sketch("front", () => {
    move([-50+4, 20])
    aLine(-45, 20)
});

rib(5).parallel();
