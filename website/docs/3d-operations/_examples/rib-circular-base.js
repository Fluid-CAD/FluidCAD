// @screenshot view iso-ftr
import { sketch, extrude, shell, rib, fillet, circle, line } from 'fluidcad/core';

sketch("top", () => {
    circle([0, 0], 80);
  })

const box = extrude(30)
const sh = shell(-4, box.endFaces())
const s = fillet(2, sh.internalEdges())

sketch("front", () => {
    // rib guide: a 45° line falling from [-40, 20]
    line([-40, 20], [-25.857864, 5.857864]);
  });

rib(5).parallel().extend().draft(3).new().scope(s);
