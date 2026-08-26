// @screenshot waitForInput
import { sketch, extrude, shell, rib, fillet, circle, repeat, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

sketch("top", () => {
    const sg1 = line([-50, -50], [50, -50]);
    const sg2 = line([50, -50], [50, 50]);
    const sg3 = line([50, 50], [-50, 50]);
    const sg4 = line([-50, 50], [-50, -50]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-50, -50]);
    distance(sg1.start(), sg1.end(), 100);
    distance(sg2.start(), sg2.end(), 100);
  })

const box = extrude(30)
const sh = shell(-4, box.endFaces())
fillet(2, sh.internalEdges())

sketch("top", () => {
    circle([0, 0], 30);
  });

const s = extrude(50).draft(-5)

sketch("front", () => {
    // rib guide: a 45° line rising from [-40, 20]
    line([-40, 20], [-25.857864, 34.142136]);
  });

const r = rib(5).parallel().extend().new().scope(s).draft(-4);

repeat("circular", "z", {
    count: 6,
    angle: 360
}, r)
