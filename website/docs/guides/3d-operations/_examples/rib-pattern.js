// @screenshot waitForInput
import { sketch, move, rect, extrude, shell, rib, fillet, aLine, circle, repeat } from 'fluidcad/core';

sketch("top", () => {
    rect(100).centered();
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

const r = rib(5).parallel().extend().new().scope(s).draft(-4);

repeat("circular", "z", {
    count: 6,
    angle: 360
}, r)
