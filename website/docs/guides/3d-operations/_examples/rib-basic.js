// @screenshot waitForInput
import { sketch, rect, extrude, shell, hLine, rib, fillet } from 'fluidcad/core';

sketch("top", () => {
    rect(100, 50).centered();
})

const box = extrude(30)
const s = shell(-4, box.endFaces())
fillet(2, s.internalEdges())

sketch(box.endFaces(), () => {
    hLine([-50+4, 0], 30)
});

rib(5).draft(2);
