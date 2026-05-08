// @screenshot waitForInput
import { sketch, move, rect, extrude, shell, rib, fillet, aLine, repeat, plane } from 'fluidcad/core';

sketch("top", () => {
    rect(80).centered();
})

const box = extrude(30)
const s = shell(-4, box.endFaces())
fillet(2, s.internalEdges())

sketch("top", () => {
    rect(30).centered();
});

extrude(50)

const p = plane("front", { rotateY: 45 })

sketch(p, () => {
    move([-40, 18])
    aLine(45, 20)
});

const r = rib(6).parallel().extend().draft(-1);

repeat("circular", "z", {
    count: 4,
    angle: 360
}, r)
